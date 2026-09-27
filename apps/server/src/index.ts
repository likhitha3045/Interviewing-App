import 'dotenv/config';
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { Server } from 'socket.io';
import { z } from 'zod';
import { Application, AuthToken, ChatMessage, ChatUpload, CodeWorkspace, Conversation, Evaluation, Feedback, Interview, Job, Notification, User } from './models.js';
import { clientUrl, isEmailConfigured, sendEmail, serverUrl } from './email.js';

const PORT = Number(process.env.PORT ?? 4000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in the environment.');
if (process.env.NODE_ENV === 'production' && !process.env.INTERVIEWER_SIGNUP_CODE) throw new Error('INTERVIEWER_SIGNUP_CODE must be set in production.');
if (process.env.NODE_ENV === 'production' && !process.env.RECRUITER_SIGNUP_CODE) throw new Error('RECRUITER_SIGNUP_CODE must be set in production.');
if (process.env.NODE_ENV === 'production' && !process.env.SMTP_HOST) throw new Error('SMTP_HOST must be configured in production for account verification and interview email.');
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] }, maxHttpBufferSize: 1e6 });
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(helmet());
app.use(express.json({ limit: '32kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, skip: (req) => req.path === '/health' }));
const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => {
  const safeMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'];
  if (safeMimeTypes.includes(file.mimetype)) callback(null, true);
  else callback(new Error('Only images, PDF, and plain text attachments are accepted.'));
} });
const resumeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => {
  const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  if (allowed.includes(file.mimetype)) callback(null, true);
  else callback(new Error('Résumé must be a PDF or DOCX file.'));
} });

interface TokenPayload { userId: string; role: 'interviewer' | 'candidate' | 'recruiter'; name: string }
const issueToken = (payload: TokenPayload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ message: 'Authentication required.' });
  void (async () => {
    try {
      const payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
      const account = await User.findById(payload.userId).select('name role isActive').lean() as { name: string; role: TokenPayload['role']; isActive?: boolean } | null;
      if (!account || account.isActive === false) return res.status(401).json({ message: 'This account is disabled or no longer available.' });
      res.locals.user = { ...payload, name: account.name, role: account.role };
      next();
    } catch {
      return res.status(401).json({ message: 'Your session has expired. Please sign in again.' });
    }
  })();
};
const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const issueOneTimeToken = async (userId: string, purpose: 'verify-email' | 'reset-password') => {
  await AuthToken.deleteMany({ userId, purpose });
  const token = randomBytes(32).toString('hex');
  await AuthToken.create({ userId, purpose, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  return token;
};
const publishNotification = async (user: any, interview: any, kind: string, title: string, message: string, deliverEmail = true) => {
  const notification = await Notification.create({ userId: user._id, interviewId: interview._id, kind, title, message });
  const payload = { id: String(notification._id), interviewId: String(interview._id), kind, title, message, createdAt: notification.createdAt, readAt: null };
  io.to(`user:${String(user._id)}`).emit('notification', payload);
  if (deliverEmail && user.emailPreferences !== false) void sendEmail(user.email, title, `${message}\n\nInterview: ${interview.title}\nWhen: ${new Date(interview.scheduledAt).toLocaleString()}\nRoom: ${interview.roomCode}`, clientUrl(`/?room=${interview.roomCode}`)).catch((error: unknown) => console.error('Unable to deliver notification email:', error));
  return payload;
};
const escapeIcs = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const isSafeWebUrl = (value: string) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
};
const verifyAttachmentBytes = async (file: Express.Multer.File) => {
  const detected = await fileTypeFromBuffer(file.buffer);
  const allowedSignatures: Record<string, string[]> = { 'image/jpeg': ['image/jpeg'], 'image/png': ['image/png'], 'image/gif': ['image/gif'], 'image/webp': ['image/webp'], 'application/pdf': ['application/pdf'] };
  if (allowedSignatures[file.mimetype]) return allowedSignatures[file.mimetype]!.includes(detected?.mime ?? '');
  if (file.mimetype === 'text/plain') return !detected && !file.buffer.includes(0);
  return false;
};

app.get('/api/health', (_req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', database: ready ? 'connected' : 'disconnected' });
});

app.get('/api/rtc/ice-servers', authenticate, (_req, res) => {
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [{ urls: process.env.STUN_URLS?.split(',').map((value) => value.trim()).filter(Boolean) ?? ['stun:stun.l.google.com:19302'] }];
  const turnUrls = process.env.TURN_URLS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  const sharedSecret = process.env.TURN_SHARED_SECRET;
  if (turnUrls.length && sharedSecret) {
    const username = `${Math.floor(Date.now() / 1000) + 3600}:interviewly`;
    const credential = createHmac('sha1', sharedSecret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
  }
  res.json({ iceServers });
});

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const schema = z.object({ name: z.string().trim().min(2).max(80), email: z.string().email(), password: z.string().min(8).max(128), role: z.enum(['interviewer', 'candidate', 'recruiter']), interviewerCode: z.string().optional() });
  const input = schema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Enter a valid name, email, password (8+ characters), and role.' });
  if (input.data.role === 'interviewer' && process.env.NODE_ENV === 'production' && (!process.env.INTERVIEWER_SIGNUP_CODE || input.data.interviewerCode !== process.env.INTERVIEWER_SIGNUP_CODE)) return res.status(403).json({ message: 'Interviewer registration requires an organization invitation code.' });
  if (input.data.role === 'recruiter' && process.env.NODE_ENV === 'production' && (!process.env.RECRUITER_SIGNUP_CODE || input.data.interviewerCode !== process.env.RECRUITER_SIGNUP_CODE)) return res.status(403).json({ message: 'Recruiter registration requires an organization invitation code.' });
  const email = input.data.email.toLowerCase();
  if (await User.exists({ email })) return res.status(409).json({ message: 'An account with that email already exists.' });
  const user = await User.create({ name: input.data.name, email, role: input.data.role, passwordHash: await bcrypt.hash(input.data.password, 12) });
  const verificationToken = await issueOneTimeToken(String(user._id), 'verify-email');
  const verificationUrl = serverUrl(`/api/auth/verify-email?token=${verificationToken}`);
  const emailDelivered = await sendEmail(user.email, 'Verify your Interviewly email', 'Verify your email address to activate your Interviewly account. This link expires in one hour.', verificationUrl);
  res.status(201).json({ message: emailDelivered ? 'Account created. Check your email for a verification link before signing in.' : 'SMTP is not configured, so no email was sent. Use the local verification link below.', ...(!emailDelivered && !isEmailConfigured() ? { developmentUrl: verificationUrl } : {}) });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Enter your email and password.' });
  const user = await User.findOne({ email: input.data.email.toLowerCase() }).select('+passwordHash');
  if (!user || !(await bcrypt.compare(input.data.password, user.passwordHash))) return res.status(401).json({ message: 'Email or password is incorrect.' });
  if (user.emailVerified === false) return res.status(403).json({ message: 'Verify your email using the link we sent before signing in.' });
  const id = String(user._id);
  res.json({ token: issueToken({ userId: id, name: user.name, role: user.role }), user: { id, name: user.name, email: user.email, role: user.role } });
}));

app.get('/api/auth/verify-email', asyncRoute(async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const record = token ? await AuthToken.findOneAndDelete({ tokenHash: tokenHash(token), purpose: 'verify-email', expiresAt: { $gt: new Date() } }) : null;
  if (!record) return res.status(400).send('This verification link is invalid or expired. Please request a new one.');
  const user = await User.findByIdAndUpdate(record.userId, { emailVerified: true }, { new: true });
  if (user?.role === 'candidate') {
    const pending = await Interview.find({ candidate: null, candidateEmail: user.email, status: 'scheduled' }).limit(50);
    for (const interview of pending) {
      const claimed = await Interview.findOneAndUpdate({ _id: interview._id, candidate: null }, { candidate: user._id }, { new: true });
      if (claimed) await publishNotification(user, claimed, 'interview-created', 'Interview invitation', `You’ve been added to “${claimed.title}”.`, false);
    }
  }
  res.redirect(`${CLIENT_ORIGIN}/?verified=1${user?.email ? `&email=${encodeURIComponent(user.email)}` : ''}`);
}));

app.post('/api/auth/resend-verification', asyncRoute(async (req, res) => {
  const input = z.object({ email: z.string().email() }).safeParse(req.body);
  if (input.success) {
    const user = await User.findOne({ email: input.data.email.toLowerCase(), emailVerified: false });
    if (user) {
      const verificationToken = await issueOneTimeToken(String(user._id), 'verify-email');
      const verificationUrl = serverUrl(`/api/auth/verify-email?token=${verificationToken}`);
      const emailDelivered = await sendEmail(user.email, 'Verify your Interviewly email', 'Verify your email address to activate your Interviewly account. This link expires in one hour.', verificationUrl);
      if (!emailDelivered && !isEmailConfigured() && process.env.NODE_ENV !== 'production') return res.json({ message: 'SMTP is not configured, so no email was sent. Use the local verification link below.', developmentUrl: verificationUrl });
    }
  }
  res.json({ message: 'If the account needs verification, a new link has been sent.' });
}));

app.post('/api/auth/forgot-password', asyncRoute(async (req, res) => {
  const input = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!input.success) return res.status(200).json({ message: 'If that account exists, a password reset link will be sent.' });
  const user = await User.findOne({ email: input.data.email.toLowerCase() });
  if (user) {
    const token = await issueOneTimeToken(String(user._id), 'reset-password');
    const resetUrl = clientUrl(`/?reset=${token}`);
    const emailDelivered = await sendEmail(user.email, 'Reset your Interviewly password', 'Use the link below to choose a new password. This link expires in one hour.', resetUrl);
    if (!emailDelivered && !isEmailConfigured() && process.env.NODE_ENV !== 'production') return res.json({ message: 'SMTP is not configured, so no email was sent. Use the local password-reset link below.', developmentUrl: resetUrl });
  }
  res.json({ message: 'If that account exists, a password reset link will be sent.' });
}));

app.post('/api/auth/reset-password', asyncRoute(async (req, res) => {
  const input = z.object({ token: z.string().min(32), password: z.string().min(8).max(128) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Use a valid reset link and a password of at least 8 characters.' });
  const record = await AuthToken.findOneAndDelete({ tokenHash: tokenHash(input.data.token), purpose: 'reset-password', expiresAt: { $gt: new Date() } });
  if (!record) return res.status(400).json({ message: 'This password reset link is invalid or expired.' });
  await User.findByIdAndUpdate(record.userId, { passwordHash: await bcrypt.hash(input.data.password, 12) });
  res.json({ message: 'Password updated. You can now sign in.' });
}));

app.get('/api/auth/me', authenticate, asyncRoute(async (_req, res) => {
  const tokenUser = res.locals.user as TokenPayload;
  const user = await User.findById(tokenUser.userId).select('name email role');
  if (!user) return res.status(404).json({ message: 'Account not found.' });
  res.json({ id: String(user._id), name: user.name, email: user.email, role: user.role });
}));

app.get('/api/interviews', authenticate, asyncRoute(async (_req, res) => {
  const { userId, role } = res.locals.user as TokenPayload;
  const filter = role === 'candidate' ? { candidate: userId } : role === 'recruiter' ? { createdBy: userId } : { interviewer: userId };
  const interviews = await Interview.find(filter).populate('interviewer', 'name email').populate('candidate', 'name email').sort({ scheduledAt: 1 });
  res.json(interviews);
}));

app.get('/api/notifications', authenticate, asyncRoute(async (_req, res) => {
  const { userId } = res.locals.user as TokenPayload;
  res.json(await Notification.find({ userId }).sort({ createdAt: -1 }).limit(50).lean());
}));

app.patch('/api/notifications/read-all', authenticate, asyncRoute(async (_req, res) => {
  const { userId } = res.locals.user as TokenPayload;
  await Notification.updateMany({ userId, readAt: { $exists: false } }, { readAt: new Date() });
  res.json({ ok: true });
}));

app.patch('/api/users/email-preferences', authenticate, asyncRoute(async (req, res) => {
  const preference = z.boolean().safeParse(req.body.enabled);
  if (!preference.success) return res.status(400).json({ message: 'Choose whether email notifications are enabled.' });
  const { userId } = res.locals.user as TokenPayload;
  await User.findByIdAndUpdate(userId, { emailPreferences: preference.data });
  res.json({ enabled: preference.data });
}));

app.get('/api/users/email-preferences', authenticate, asyncRoute(async (_req, res) => {
  const { userId } = res.locals.user as TokenPayload;
  const user = await User.findById(userId).select('emailPreferences').lean() as { emailPreferences?: boolean } | null;
  res.json({ enabled: user?.emailPreferences !== false });
}));

app.get('/api/profile', authenticate, asyncRoute(async (_req, res) => {
  const { userId } = res.locals.user as TokenPayload;
  const profile = await User.findById(userId).select('-passwordHash -__v').lean();
  if (!profile) return res.status(404).json({ message: 'Profile not found.' });
  res.json(profile);
}));

app.post('/api/profile/resume', authenticate, (req, res, next) => {
  resumeUpload.single('file')(req, res, (error: unknown) => { if (error) return res.status(400).json({ message: error instanceof Error ? error.message : 'Invalid résumé.' }); next(); });
}, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (!req.file) return res.status(400).json({ message: 'Choose a PDF or DOCX résumé under 10 MB.' });
  const data = req.file.buffer;
  const isPdf = data.subarray(0, 5).toString() === '%PDF-';
  const isDocx = data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if ((req.file.mimetype === 'application/pdf' && !isPdf) || (req.file.mimetype.endsWith('wordprocessingml.document') && !isDocx)) return res.status(400).json({ message: 'The file contents do not match the selected résumé type.' });
  const safeName = req.file.originalname.replace(/[\\/\r\n\0]/g, '_').slice(0, 180);
  const resume = await ChatUpload.create({ ownerId: currentUser.userId, conversationId: `resume:${currentUser.userId}`, originalName: safeName, mimeType: req.file.mimetype, size: req.file.size, data, expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) });
  const resumeUrl = `/api/profile/resume/${String(resume._id)}`;
  await User.findByIdAndUpdate(currentUser.userId, { resumeUrl });
  res.status(201).json({ resumeUrl, name: safeName });
}));

app.get('/api/profile/resume/:id', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Résumé not found.' });
  const resume = await ChatUpload.findById(req.params.id).select('+data');
  if (!resume || !resume.conversationId.startsWith('resume:') || resume.expiresAt <= new Date()) return res.status(404).json({ message: 'Résumé not found or expired.' });
  const isOwner = String(resume.ownerId) === currentUser.userId;
  let recruiterAuthorized = false;
  if (!isOwner && currentUser.role === 'recruiter') {
    const application = await Application.findOne({ candidateId: resume.ownerId }).select('jobId').lean() as { jobId: unknown } | null;
    if (application) recruiterAuthorized = Boolean(await Job.exists({ _id: application.jobId, createdBy: currentUser.userId }));
  }
  if (!isOwner && !recruiterAuthorized) return res.status(403).json({ message: 'You do not have access to this résumé.' });
  res.setHeader('Content-Type', resume.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(resume.originalName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(resume.data);
}));

app.patch('/api/profile', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const input = z.object({ headline: z.string().trim().max(120).optional(), bio: z.string().trim().max(2000).optional(), skills: z.array(z.string().trim().min(1).max(50)).max(30).optional(), education: z.array(z.object({ school: z.string().trim().max(120), degree: z.string().trim().max(120), year: z.string().trim().max(12) })).max(10).optional(), projects: z.array(z.object({ name: z.string().trim().max(120), description: z.string().trim().max(500), url: z.string().max(500).refine((value) => value === '' || isSafeWebUrl(value)).optional() })).max(20).optional(), resumeUrl: z.string().max(500).refine((value) => value === '' || isSafeWebUrl(value), 'Enter an HTTP(S) résumé URL.').optional(), company: z.string().trim().max(120).optional() }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Check the profile fields and try again.' });
  const profile = await User.findByIdAndUpdate(currentUser.userId, { $set: input.data }, { new: true, runValidators: true }).select('-passwordHash -__v');
  if (!profile) return res.status(404).json({ message: 'Profile not found.' });
  res.json(profile);
}));

app.get('/api/jobs', authenticate, asyncRoute(async (_req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const filter = currentUser.role === 'recruiter' ? { createdBy: currentUser.userId } : { status: 'open', $or: [{ deadline: { $exists: false } }, { deadline: { $gte: new Date() } }] };
  res.json(await Job.find(filter).populate('createdBy', 'name company').sort({ createdAt: -1 }).lean());
}));

app.post('/api/jobs', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (currentUser.role !== 'recruiter') return res.status(403).json({ message: 'Only recruiters can publish jobs.' });
  const input = z.object({ title: z.string().trim().min(2).max(120), company: z.string().trim().min(2).max(120), location: z.string().trim().min(2).max(120), salary: z.string().trim().max(120).default(''), experience: z.string().trim().max(80).default(''), skills: z.array(z.string().trim().min(1).max(50)).max(30).default([]), description: z.string().trim().min(20).max(8000), deadline: z.string().datetime().optional() }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Add a title, company, location, and a description of at least 20 characters.' });
  const job = await Job.create({ ...input.data, deadline: input.data.deadline ? new Date(input.data.deadline) : undefined, createdBy: currentUser.userId });
  res.status(201).json(job);
}));

app.patch('/api/jobs/:id', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (currentUser.role !== 'recruiter') return res.status(403).json({ message: 'Only recruiters can manage jobs.' });
  const input = z.object({ status: z.enum(['open', 'closed']) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Invalid job status.' });
  const job = await Job.findOneAndUpdate({ _id: req.params.id, createdBy: currentUser.userId }, { status: input.data.status }, { new: true });
  if (!job) return res.status(404).json({ message: 'Job not found.' });
  res.json(job);
}));

app.post('/api/jobs/:id/applications', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (currentUser.role !== 'candidate') return res.status(403).json({ message: 'Only candidates can apply for jobs.' });
  const input = z.object({ coverLetter: z.string().trim().max(4000).default('') }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Check your application details.' });
  const job = await Job.findOne({ _id: req.params.id, status: 'open', $or: [{ deadline: { $exists: false } }, { deadline: { $gte: new Date() } }] });
  if (!job) return res.status(404).json({ message: 'This job is no longer accepting applications.' });
  try {
    const application = await Application.create({ jobId: job._id, candidateId: currentUser.userId, coverLetter: input.data.coverLetter });
    const recruiter = await User.findById(job.createdBy);
    if (recruiter) {
      const notification = await Notification.create({ userId: recruiter._id, kind: 'interview-created', title: 'New job application', message: `A candidate applied for ${job.title}.` });
      io.to(`user:${String(recruiter._id)}`).emit('notification', { id: String(notification._id), title: notification.title, message: notification.message, createdAt: notification.createdAt, readAt: null });
    }
    res.status(201).json(application);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return res.status(409).json({ message: 'You already applied for this job.' });
    throw error;
  }
}));

app.get('/api/applications', authenticate, asyncRoute(async (_req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const filter = currentUser.role === 'candidate' ? { candidateId: currentUser.userId } : currentUser.role === 'recruiter' ? { jobId: { $in: await Job.find({ createdBy: currentUser.userId }).distinct('_id') } } : { candidateId: currentUser.userId };
  res.json(await Application.find(filter).populate('jobId').populate('candidateId', 'name email headline skills resumeUrl').sort({ createdAt: -1 }).lean());
}));

app.patch('/api/applications/:id/status', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (currentUser.role !== 'recruiter') return res.status(403).json({ message: 'Only recruiters can update application stages.' });
  const input = z.object({ status: z.enum(['shortlisted', 'assessment', 'technical-interview', 'hr-interview', 'selected', 'rejected']) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Invalid application stage.' });
  const jobIds = await Job.find({ createdBy: currentUser.userId }).distinct('_id');
  const application = await Application.findOneAndUpdate({ _id: req.params.id, jobId: { $in: jobIds } }, { status: input.data.status }, { new: true }).populate('jobId');
  if (!application) return res.status(404).json({ message: 'Application not found.' });
  const candidate = await User.findById(application.candidateId);
  if (candidate) {
    const notification = await Notification.create({ userId: candidate._id, kind: 'interview-updated', title: 'Application update', message: `Your application for “${application.jobId.title}” moved to ${input.data.status}.` });
    io.to(`user:${String(candidate._id)}`).emit('notification', { id: String(notification._id), title: notification.title, message: notification.message, createdAt: notification.createdAt, readAt: null });
    if (candidate.emailPreferences !== false) void sendEmail(candidate.email, 'Application status updated', notification.message, clientUrl('/')).catch((error: unknown) => console.error('Unable to deliver application email:', error));
  }
  res.json(application);
}));

app.get('/api/recruiter/metrics', authenticate, asyncRoute(async (_req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (currentUser.role !== 'recruiter') return res.status(403).json({ message: 'Recruiter access required.' });
  const jobs = await Job.find({ createdBy: currentUser.userId }).distinct('_id');
  const [candidateCount, statusGroups, upcomingInterviews, jobCounts] = await Promise.all([
    User.countDocuments({ role: 'candidate' }),
    Application.aggregate([{ $match: { jobId: { $in: jobs } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Interview.countDocuments({ createdBy: currentUser.userId, status: 'scheduled', scheduledAt: { $gte: new Date(), $lt: new Date(Date.now() + 24 * 60 * 60 * 1000) } }),
    Application.aggregate([{ $match: { jobId: { $in: jobs } } }, { $group: { _id: '$jobId', count: { $sum: 1 } } }, { $lookup: { from: 'jobs', localField: '_id', foreignField: '_id', as: 'job' } }, { $unwind: '$job' }, { $project: { title: '$job.title', count: 1 } }]),
  ]);
  res.json({ totalCandidates: candidateCount, interviewsToday: upcomingInterviews, applications: statusGroups.reduce((total: number, group: { count: number }) => total + group.count, 0), shortlisted: statusGroups.find((group: { _id: string }) => group._id === 'shortlisted')?.count ?? 0, selected: statusGroups.find((group: { _id: string }) => group._id === 'selected')?.count ?? 0, jobCounts });
}));

app.post('/api/ai/interview-questions', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (!['recruiter', 'interviewer'].includes(currentUser.role)) return res.status(403).json({ message: 'Recruiter or interviewer access is required.' });
  const input = z.object({ role: z.string().trim().min(2).max(100), experience: z.string().trim().max(80).default(''), skills: z.array(z.string().trim().min(1).max(50)).max(20) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Add a role and at least one skill.' });
  const key = process.env.AI_API_KEY;
  if (!key) return res.status(503).json({ message: 'AI question generation is optional. Configure AI_API_KEY and AI_API_URL to enable it.' });
  const endpoint = process.env.AI_API_URL ?? 'https://api.openai.com/v1/chat/completions';
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.AI_MODEL ?? 'gpt-4o-mini', temperature: 0.4, max_tokens: 800, messages: [{ role: 'system', content: 'Create 6 concise, original interview questions. Return a numbered list. Do not assess or infer protected characteristics.' }, { role: 'user', content: `Role: ${input.data.role}\nExperience: ${input.data.experience}\nSkills: ${input.data.skills.join(', ')}` }] }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return res.status(502).json({ message: 'The configured AI provider could not generate questions.' });
  const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const questions = result.choices?.[0]?.message?.content?.trim();
  if (!questions) return res.status(502).json({ message: 'The AI provider returned no questions.' });
  res.json({ questions });
}));

app.post('/api/interviews', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (currentUser.role === 'candidate') return res.status(403).json({ message: 'Only interviewers and recruiters can schedule sessions.' });
  const input = z.object({ title: z.string().trim().min(3).max(120), candidateEmail: z.string().email(), interviewerEmail: z.string().email().optional(), scheduledAt: z.string().datetime(), durationMinutes: z.number().int().min(15).max(240).default(45), interviewType: z.enum(['technical', 'behavioral', 'hr', 'other']).default('technical'), instructions: z.string().trim().max(2000).default('') }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Add a title, candidate email, and valid date/time.' });
  const candidateEmail = input.data.candidateEmail.toLowerCase();
  const existingAccount = await User.findOne({ email: candidateEmail });
  if (existingAccount && existingAccount.role !== 'candidate') return res.status(409).json({ message: 'That email belongs to an interviewer account, not a candidate.' });
  const assignedInterviewer = currentUser.role === 'recruiter' ? await User.findOne({ email: input.data.interviewerEmail?.toLowerCase(), role: 'interviewer', emailVerified: true }) : null;
  if (currentUser.role === 'recruiter' && !assignedInterviewer) return res.status(404).json({ message: 'Enter the email address of a verified interviewer to assign.' });
  const candidate = existingAccount;
  const interviewer = assignedInterviewer ?? await User.findById(currentUser.userId);
  const interview = await Interview.create({ title: input.data.title, candidate: candidate?._id ?? null, candidateEmail, interviewer: interviewer?._id ?? currentUser.userId, createdBy: currentUser.userId, scheduledAt: new Date(input.data.scheduledAt), durationMinutes: input.data.durationMinutes, interviewType: input.data.interviewType, instructions: input.data.instructions, roomCode: randomUUID().slice(0, 8).toUpperCase() });
  const populated = await interview.populate([{ path: 'interviewer', select: 'name email' }, { path: 'candidate', select: 'name email' }]);
  if (candidate) await publishNotification(candidate, interview, 'interview-created', 'New interview scheduled', `${currentUser.name} scheduled “${interview.title}” with you.`);
  else void sendEmail(candidateEmail, `Interview invitation: ${interview.title}`, `${currentUser.name} invited you to “${interview.title}” on ${new Date(interview.scheduledAt).toLocaleString()}. Create and verify a candidate account with this email address to access the interview room.`, clientUrl(`/?register=1&email=${encodeURIComponent(candidateEmail)}`)).catch((error: unknown) => console.error('Unable to deliver candidate invitation:', error));
  if (assignedInterviewer) await publishNotification(assignedInterviewer, interview, 'interview-created', 'Interview assigned to you', `${currentUser.name} assigned you to “${interview.title}”.`);
  res.status(201).json(populated);
}));

app.patch('/api/interviews/:id/status', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const status = z.enum(['scheduled', 'in-progress', 'completed', 'cancelled']).safeParse(req.body.status);
  if (!status.success) return res.status(400).json({ message: 'Invalid interview status.' });
  const allowedPrevious = status.data === 'in-progress' || status.data === 'cancelled' || status.data === 'completed' ? ['scheduled', 'in-progress'] : ['scheduled'];
  const interview = await Interview.findOneAndUpdate({ _id: req.params.id, status: { $in: allowedPrevious }, $or: [{ interviewer: currentUser.userId }, { candidate: currentUser.userId }, { createdBy: currentUser.userId }] }, { status: status.data }, { new: true });
  if (!interview) return res.status(404).json({ message: 'Interview not found.' });
  if (status.data === 'cancelled') {
    const interviewer = await User.findById(interview.interviewer);
    const candidate = interview.candidate ? await User.findById(interview.candidate) : null;
    for (const participant of [interviewer, candidate]) if (participant && String(participant._id) !== currentUser.userId) await publishNotification(participant, interview, 'interview-cancelled', 'Interview cancelled', `${currentUser.name} cancelled “${interview.title}”.`);
    if (!candidate && interview.candidateEmail) void sendEmail(interview.candidateEmail, 'Interview cancelled', `${currentUser.name} cancelled “${interview.title}”.`, clientUrl('/')).catch((error: unknown) => console.error('Unable to deliver cancellation email:', error));
  }
  res.json(interview);
}));

app.patch('/api/interviews/:id', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (currentUser.role === 'candidate') return res.status(403).json({ message: 'Only interviewers and recruiters can reschedule this session.' });
  const input = z.object({ title: z.string().trim().min(3).max(120).optional(), scheduledAt: z.string().datetime().optional(), durationMinutes: z.number().int().min(15).max(240).optional(), interviewType: z.enum(['technical', 'behavioral', 'hr', 'other']).optional(), instructions: z.string().trim().max(2000).optional() }).refine((data) => Object.keys(data).length > 0).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Provide a valid title or date and time.' });
  const update: Record<string, unknown> = { $set: input.data };
  if (input.data.scheduledAt) update.$unset = { reminderSentAt: 1 };
  const ownerField = currentUser.role === 'recruiter' ? 'createdBy' : 'interviewer';
  const interview = await Interview.findOneAndUpdate({ _id: req.params.id, [ownerField]: currentUser.userId, status: 'scheduled' }, update, { new: true }).populate([{ path: 'interviewer', select: 'name email emailPreferences' }, { path: 'candidate', select: 'name email emailPreferences' }]);
  if (!interview) return res.status(404).json({ message: 'Scheduled interview not found.' });
  if (interview.candidate) await publishNotification(interview.candidate, interview, 'interview-updated', 'Interview updated', `“${interview.title}” has a new time: ${new Date(interview.scheduledAt).toLocaleString()}.`);
  else if (interview.candidateEmail) void sendEmail(interview.candidateEmail, 'Interview time updated', `The time for “${interview.title}” changed to ${new Date(interview.scheduledAt).toLocaleString()}.`, clientUrl(`/?register=1&email=${encodeURIComponent(interview.candidateEmail)}`)).catch((error: unknown) => console.error('Unable to deliver reschedule email:', error));
  if (currentUser.role === 'recruiter' && interview.interviewer && String(interview.interviewer._id) !== currentUser.userId) await publishNotification(interview.interviewer, interview, 'interview-updated', 'Interview updated', `“${interview.title}” has a new time: ${new Date(interview.scheduledAt).toLocaleString()}.`);
  res.json(interview);
}));

app.get('/api/interviews/:id/calendar', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const interview = await Interview.findOne({ _id: req.params.id, $or: [{ interviewer: currentUser.userId }, { candidate: currentUser.userId }, { createdBy: currentUser.userId }] }).populate([{ path: 'interviewer', select: 'name email' }, { path: 'candidate', select: 'name email' }]);
  if (!interview) return res.status(404).json({ message: 'Interview not found.' });
  const start = new Date(interview.scheduledAt);
  const end = new Date(start.getTime() + interview.durationMinutes * 60 * 1000);
  const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const candidateName = interview.candidate?.name ?? interview.candidateEmail;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Interviewly//Interview//EN', 'BEGIN:VEVENT', `UID:${interview.roomCode}@interviewly`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${escapeIcs(interview.title)}`, `DESCRIPTION:${escapeIcs(`Interview with ${interview.interviewer.name} and ${candidateName}. Room: ${interview.roomCode}`)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  res.type('text/calendar').attachment(`interview-${interview.roomCode}.ics`).send(ics);
}));

app.post('/api/interviews/:id/feedback', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const input = z.object({ rating: z.number().int().min(1).max(5), notes: z.string().trim().max(2000).default('') }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Choose a 1–5 rating and optional notes.' });
  const interview = await Interview.findOne({ _id: req.params.id, status: 'completed', $or: [{ interviewer: currentUser.userId }, { candidate: currentUser.userId }] });
  if (!interview) return res.status(404).json({ message: 'Completed interview not found.' });
  try {
    const feedback = await Feedback.create({ interviewId: interview._id, authorId: currentUser.userId, ...input.data });
    res.status(201).json(feedback);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return res.status(409).json({ message: 'You already submitted feedback for this interview.' });
    throw error;
  }
}));

app.get('/api/interviews/:id/feedback/mine', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const participant = await Interview.exists({ _id: req.params.id, $or: [{ interviewer: currentUser.userId }, { candidate: currentUser.userId }] });
  if (!participant) return res.status(404).json({ message: 'Interview not found.' });
  const feedback = await Feedback.findOne({ interviewId: req.params.id, authorId: currentUser.userId }).lean();
  res.json(feedback ?? null);
}));

app.post('/api/interviews/:id/evaluation', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (currentUser.role !== 'interviewer') return res.status(403).json({ message: 'Only interviewers can submit interview evaluations.' });
  const input = z.object({ technicalSkills: z.number().int().min(1).max(5), communication: z.number().int().min(1).max(5), problemSolving: z.number().int().min(1).max(5), notes: z.string().trim().max(4000).default(''), candidateSummary: z.string().trim().max(2000).default(''), recommendation: z.enum(['reject', 'hold', 'proceed']) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Complete the evaluation ratings and recommendation.' });
  const interview = await Interview.findOne({ _id: req.params.id, interviewer: currentUser.userId, status: 'completed' });
  if (!interview) return res.status(404).json({ message: 'Completed interview not found.' });
  const evaluation = await Evaluation.findOneAndUpdate({ interviewId: interview._id, authorId: currentUser.userId }, { ...input.data, interviewId: interview._id, authorId: currentUser.userId }, { new: true, upsert: true, runValidators: true });
  const candidate = await User.findById(interview.candidate);
  if (candidate && input.data.candidateSummary) {
    const notification = await Notification.create({ userId: candidate._id, kind: 'interview-updated', title: 'Interview feedback available', message: `Feedback for “${interview.title}” is now available.` });
    io.to(`user:${String(candidate._id)}`).emit('notification', { id: String(notification._id), title: notification.title, message: notification.message, createdAt: notification.createdAt, readAt: null });
  }
  res.json(evaluation);
}));

app.get('/api/interviews/:id/evaluation', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const interview = await Interview.findOne({ _id: req.params.id, $or: [{ interviewer: currentUser.userId }, { candidate: currentUser.userId }] });
  if (!interview) return res.status(404).json({ message: 'Interview not found.' });
  const evaluation = await Evaluation.findOne({ interviewId: interview._id, authorId: interview.interviewer }).lean() as Record<string, unknown> | null;
  if (!evaluation) return res.json(null);
  if (currentUser.role === 'candidate') return res.json({ technicalSkills: evaluation.technicalSkills, communication: evaluation.communication, problemSolving: evaluation.problemSolving, candidateSummary: evaluation.candidateSummary, recommendation: evaluation.candidateSummary ? evaluation.recommendation : undefined });
  res.json(evaluation);
}));

app.get('/api/interviews/:roomCode/messages', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const interview = await Interview.findOne({ roomCode: req.params.roomCode, $or: [{ interviewer: currentUser.userId }, { candidate: currentUser.userId }] });
  if (!interview) return res.status(404).json({ message: 'Interview room not found.' });
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const filter: Record<string, unknown> = { roomCode: req.params.roomCode, deletedAt: { $exists: false } };
  if (search) filter.text = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const messages = await ChatMessage.find(filter).sort({ createdAt: 1 }).limit(100).populate('replyTo', 'senderName text deletedAt').lean();
  res.json(messages.map((message: any) => serializeMessage(message)));
}));

app.get('/api/interviews/:roomCode/code', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const interview = await Interview.findOne({ roomCode: req.params.roomCode, $or: [{ interviewer: currentUser.userId }, { candidate: currentUser.userId }] });
  if (!interview) return res.status(404).json({ message: 'Interview room not found.' });
  const code = await CodeWorkspace.findOneAndUpdate({ interviewId: interview._id }, { $setOnInsert: { interviewId: interview._id } }, { upsert: true, new: true });
  res.json({ language: code.language, source: code.source });
}));

app.post('/api/interviews/:roomCode/code/run', authenticate, rateLimit({ windowMs: 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false }), asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const input = z.object({ language: z.enum(['javascript', 'python', 'java', 'cpp']), source: z.string().min(1).max(20000), stdin: z.string().max(10000).default('') }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Choose a supported language and source under 20 KB.' });
  const interview = await Interview.findOne({ roomCode: req.params.roomCode, $or: [{ interviewer: currentUser.userId }, { candidate: currentUser.userId }] });
  if (!interview) return res.status(404).json({ message: 'Interview room not found.' });
  const endpoint = process.env.JUDGE0_API_URL;
  if (!endpoint) return res.status(503).json({ message: 'Code execution is not configured. Set up an isolated Judge0-compatible service; code is never executed by Interviewly’s API server.' });
  const languageIds: Record<string, number> = { javascript: 63, python: 71, java: 62, cpp: 54 };
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.JUDGE0_API_KEY) headers['X-RapidAPI-Key'] = process.env.JUDGE0_API_KEY;
  if (process.env.JUDGE0_API_HOST) headers['X-RapidAPI-Host'] = process.env.JUDGE0_API_HOST;
  const base = endpoint.replace(/\/$/, '');
  const response = await fetch(`${base}/submissions?base64_encoded=false&wait=true`, { method: 'POST', headers, body: JSON.stringify({ language_id: languageIds[input.data.language], source_code: input.data.source, stdin: input.data.stdin, cpu_time_limit: 3, wall_time_limit: 5, memory_limit: 128000 }), signal: AbortSignal.timeout(12_000) });
  if (!response.ok) return res.status(502).json({ message: 'The configured isolated code runner failed to respond.' });
  const result = await response.json() as { stdout?: string | null; stderr?: string | null; compile_output?: string | null; message?: string; status?: { description?: string } };
  res.json({ stdout: result.stdout ?? '', stderr: result.stderr ?? '', compileOutput: result.compile_output ?? '', message: result.message ?? '', status: result.status?.description ?? 'Finished' });
}));

app.post('/api/interviews/:roomCode/attachments', authenticate, (req, res, next) => {
  attachmentUpload.single('file')(req, res, (error: unknown) => { if (error) return res.status(400).json({ message: error instanceof Error ? error.message : 'Invalid attachment.' }); next(); });
}, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const interview = await Interview.findOne({ roomCode: req.params.roomCode, $or: [{ interviewer: currentUser.userId }, { candidate: currentUser.userId }] });
  if (!interview) return res.status(404).json({ message: 'Interview room not found.' });
  if (!req.file) return res.status(400).json({ message: 'Choose a supported file no larger than 10 MB.' });
  if (!(await verifyAttachmentBytes(req.file))) return res.status(400).json({ message: 'The uploaded file contents do not match an allowed attachment type.' });
  const safeName = req.file.originalname.replace(/[\\/\r\n\0]/g, '_').slice(0, 180);
  const upload = await ChatUpload.create({ ownerId: currentUser.userId, conversationId: req.params.roomCode, originalName: safeName, mimeType: req.file.mimetype, size: req.file.size, data: req.file.buffer, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
  res.status(201).json({ storageKey: String(upload._id), name: upload.originalName, mimeType: upload.mimeType, size: upload.size });
}));

const serializeMessage = (message: any) => ({ id: String(message._id), conversationId: message.conversationId, roomCode: message.roomCode, senderId: String(message.sender), senderName: message.senderName, text: message.deletedAt ? '' : message.text, createdAt: message.createdAt, deliveredAt: message.deliveredAt, readAt: message.readAt, deliveredTo: message.deliveredTo?.map((item: any) => ({ userId: String(item.userId), at: item.at })) ?? [], readBy: message.readBy?.map((item: any) => ({ userId: String(item.userId), at: item.at })) ?? [], editedAt: message.editedAt, deleted: Boolean(message.deletedAt), replyTo: message.replyTo ? { id: String(message.replyTo._id), senderName: message.replyTo.senderName, text: message.replyTo.deletedAt ? 'Message deleted' : message.replyTo.text } : undefined, attachment: message.attachment ? { name: message.attachment.name, mimeType: message.attachment.mimeType, size: message.attachment.size, url: `/api/chat/attachments/${message.attachment.storageKey}` } : undefined, reactions: message.reactions?.map((reaction: any) => ({ userId: String(reaction.userId), emoji: reaction.emoji })) ?? [] });

app.get('/api/conversations', authenticate, asyncRoute(async (_req, res) => {
  const { userId } = res.locals.user as TokenPayload;
  const conversations = await Conversation.find({ participants: userId }).sort({ lastMessageAt: -1 }).lean();
  const result = await Promise.all(conversations.map(async (conversation: any) => {
    const lastMessage = await ChatMessage.findOne({ conversationId: String(conversation._id), deletedAt: { $exists: false } }).sort({ createdAt: -1 }).lean();
    const unreadCount = await ChatMessage.countDocuments({ conversationId: String(conversation._id), sender: { $ne: userId }, readBy: { $not: { $elemMatch: { userId } } }, deletedAt: { $exists: false } });
    const participants = await User.find({ _id: { $in: conversation.participants } }).select('name email lastSeenAt').lean();
    return { id: String(conversation._id), kind: conversation.kind, name: conversation.name, participants: participants.map((person: any) => ({ id: String(person._id), name: person.name, email: person.email, lastSeenAt: person.lastSeenAt })), lastMessage: lastMessage ? serializeMessage(lastMessage) : null, unreadCount, lastMessageAt: conversation.lastMessageAt };
  }));
  res.json(result);
}));

app.post('/api/conversations', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const input = z.object({ participantEmails: z.array(z.string().email()).min(1).max(49), name: z.string().trim().max(100).default('') }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Enter at least one valid participant email.' });
  const emails = [...new Set(input.data.participantEmails.map((email) => email.toLowerCase()))];
  const users = await User.find({ email: { $in: emails }, emailVerified: true }).select('_id email').lean();
  if (users.length !== emails.length) return res.status(404).json({ message: 'One or more participants do not have a verified account.' });
  const participantIds = [...new Set([currentUser.userId, ...users.map((person: any) => String(person._id))])];
  const kind = participantIds.length > 2 ? 'group' : 'direct';
  let conversation: any = null;
  if (kind === 'direct') conversation = await Conversation.findOne({ kind: 'direct', participants: { $all: participantIds, $size: 2 } });
  if (!conversation) conversation = await Conversation.create({ kind, participants: participantIds, name: kind === 'group' ? input.data.name : '' });
  for (const participantId of participantIds) io.to(`user:${participantId}`).emit('conversation:new', { id: String(conversation._id), kind: conversation.kind, name: conversation.name });
  res.status(201).json({ id: String(conversation._id), kind: conversation.kind, name: conversation.name, participants: participantIds });
}));

app.get('/api/conversations/:id/messages', authenticate, asyncRoute(async (req, res) => {
  const { userId } = res.locals.user as TokenPayload;
  const conversation = await Conversation.findOne({ _id: req.params.id, participants: userId });
  if (!conversation) return res.status(404).json({ message: 'Conversation not found.' });
  const query = z.string().trim().max(100).optional().safeParse(req.query.search);
  const filter: Record<string, unknown> = { conversationId: String(conversation._id), deletedAt: { $exists: false } };
  if (query.success && query.data) filter.text = { $regex: query.data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const messages = await ChatMessage.find(filter).sort({ createdAt: -1 }).limit(100).populate('replyTo', 'senderName text deletedAt').lean();
  res.json(messages.reverse().map((message: any) => serializeMessage(message)));
}));

app.post('/api/conversations/:id/attachments', authenticate, (req, res, next) => {
  attachmentUpload.single('file')(req, res, (error: unknown) => { if (error) return res.status(400).json({ message: error instanceof Error ? error.message : 'Invalid attachment.' }); next(); });
}, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  const conversation = await Conversation.findOne({ _id: req.params.id, participants: currentUser.userId });
  if (!conversation) return res.status(404).json({ message: 'Conversation not found.' });
  if (!req.file) return res.status(400).json({ message: 'Choose a supported file no larger than 10 MB.' });
  if (!(await verifyAttachmentBytes(req.file))) return res.status(400).json({ message: 'The uploaded file contents do not match an allowed attachment type.' });
  const safeName = req.file.originalname.replace(/[\\/\r\n\0]/g, '_').slice(0, 180);
  const upload = await ChatUpload.create({ ownerId: currentUser.userId, conversationId: String(conversation._id), originalName: safeName, mimeType: req.file.mimetype, size: req.file.size, data: req.file.buffer, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
  io.to(`user:${currentUser.userId}`).emit('chat:attachment-ready', { conversationId: String(conversation._id), storageKey: String(upload._id), name: upload.originalName, mimeType: upload.mimeType, size: upload.size });
  res.status(201).json({ storageKey: String(upload._id), name: upload.originalName, mimeType: upload.mimeType, size: upload.size });
}));

app.get('/api/chat/attachments/:id', authenticate, asyncRoute(async (req, res) => {
  const currentUser = res.locals.user as TokenPayload;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Attachment not found.' });
  const upload = await ChatUpload.findById(req.params.id).select('+data');
  if (!upload || upload.expiresAt <= new Date()) return res.status(404).json({ message: 'Attachment not found or expired.' });
  const member = await Conversation.exists({ _id: upload.conversationId, participants: currentUser.userId });
  const room = await Interview.exists({ roomCode: upload.conversationId, $or: [{ interviewer: currentUser.userId }, { candidate: currentUser.userId }] });
  if (!member && !room) return res.status(403).json({ message: 'You cannot access this attachment.' });
  res.setHeader('Content-Type', upload.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(upload.originalName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(upload.data);
}));

io.use((socket, next) => {
  void (async () => { try {
    const token = socket.handshake.auth.token as string | undefined;
    if (!token) return next(new Error('Authentication required'));
    const payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
    const account = await User.findById(payload.userId).select('name role isActive').lean() as { name: string; role: TokenPayload['role']; isActive?: boolean } | null;
    if (!account || account.isActive === false) return next(new Error('Account is disabled.'));
    socket.data.user = { ...payload, name: account.name, role: account.role };
    next();
  } catch { next(new Error('Invalid or expired session')); } })();
});

const onlineSockets = new Map<string, Set<string>>();
const activeRooms = new Map<string, Set<string>>();
const recordingConsents = new Map<string, Set<string>>();
const userRooms = (userId: string) => [...onlineSockets.get(userId) ?? []];
const canAccessChatMessage = async (message: any, userId: string, socket: any) => {
  if (message.conversationId) return Boolean(await Conversation.exists({ _id: message.conversationId, participants: userId }));
  return typeof message.roomCode === 'string' && socket.rooms.has(message.roomCode);
};
io.on('connection', (socket) => {
  const user = socket.data.user as TokenPayload;
  socket.join(`user:${user.userId}`);
  const sockets = onlineSockets.get(user.userId) ?? new Set<string>();
  sockets.add(socket.id);
  onlineSockets.set(user.userId, sockets);
  activeRooms.set(socket.id, new Set());
  void User.updateOne({ _id: user.userId }, { $set: { lastSeenAt: null } });
  const chatSentAt: number[] = [];

  socket.on('room:join', async (rawRoomCode: unknown, done?: (result: { ok: boolean; message?: string }) => void) => {
    const parsedRoomCode = z.string().regex(/^[A-Z0-9]{8}$/).safeParse(rawRoomCode);
    if (!parsedRoomCode.success) return done?.({ ok: false, message: 'Invalid room code.' });
    const roomCode = parsedRoomCode.data;
    const interview = await Interview.findOne({ roomCode, $or: [{ interviewer: user.userId }, { candidate: user.userId }] });
    if (!interview) return done?.({ ok: false, message: 'You are not a participant in this room.' });
    await socket.join(roomCode);
    activeRooms.get(socket.id)?.add(roomCode);
    const participants = [String(interview.interviewer), String(interview.candidate)];
    for (const participantId of participants) io.to(roomCode).emit('presence:update', { userId: participantId, online: (onlineSockets.get(participantId)?.size ?? 0) > 0 });
    const readAt = new Date();
    const unreadMessages = await ChatMessage.find({ roomCode, sender: { $ne: user.userId }, readAt: { $exists: false } }).select('_id sender deliveredTo readBy').lean();
    if (unreadMessages.length) {
      for (const message of unreadMessages) {
        await ChatMessage.updateOne({ _id: message._id }, { $set: { deliveredAt: readAt, readAt }, $addToSet: { deliveredTo: { userId: user.userId, at: readAt }, readBy: { userId: user.userId, at: readAt } } });
        io.to(roomCode).emit('chat:read', { readerId: user.userId, messageIds: [String(message._id)], readAt });
      }
    }
    socket.to(roomCode).emit('room:peer-joined', { userId: user.userId, name: user.name });
    done?.({ ok: true });
  });
  socket.on('chat:send', async (data: unknown) => {
    const input = z.object({ roomCode: z.string().regex(/^[A-Z0-9]{8}$/), text: z.string().trim().max(2000).default(''), replyTo: z.string().regex(/^[a-f\d]{24}$/i).optional(), attachmentKey: z.string().regex(/^[a-f\d]{24}$/i).optional() }).refine((value) => value.text.length > 0 || Boolean(value.attachmentKey)).safeParse(data);
    if (!input.success || !socket.rooms.has(input.data.roomCode)) return;
    const now = Date.now();
    while (chatSentAt.length && chatSentAt[0]! < now - 10_000) chatSentAt.shift();
    if (chatSentAt.length >= 10) return;
    chatSentAt.push(now);
    const { roomCode, text } = input.data;
    let reply;
    if (input.data.replyTo) { reply = await ChatMessage.findOne({ _id: input.data.replyTo, roomCode }); if (!reply) return; }
    let attachment: { name: string; mimeType: string; size: number; storageKey: string } | undefined;
    if (input.data.attachmentKey) {
      const upload = await ChatUpload.findOne({ _id: input.data.attachmentKey, ownerId: user.userId, conversationId: roomCode, expiresAt: { $gt: new Date() } });
      if (!upload) return;
      attachment = { name: upload.originalName, mimeType: upload.mimeType, size: upload.size, storageKey: String(upload._id) };
    }
    const roomSockets = io.sockets.adapter.rooms.get(roomCode);
    const deliveredAt = roomSockets && roomSockets.size > 1 ? new Date() : undefined;
    const interview = await Interview.findOne({ roomCode }).select('interviewer candidate').lean() as { interviewer: unknown; candidate: unknown } | null;
    const message = await ChatMessage.create({ roomCode, sender: user.userId, senderName: user.name, text: text.trim(), replyTo: reply?._id, attachment, deliveredAt, ...(deliveredAt ? { deliveredTo: [{ userId: user.userId, at: deliveredAt }] } : {}) });
    const payload = serializeMessage(await message.populate('replyTo', 'senderName text deletedAt'));
    io.to(roomCode).emit('chat:message', payload);
    if (interview) {
      const recipient = String(interview.interviewer) === user.userId ? String(interview.candidate ?? '') : String(interview.interviewer);
      if (recipient) {
        for (const recipientSocket of userRooms(recipient)) io.to(recipientSocket).emit('chat:notification', { roomCode, message: payload });
        void User.findById(recipient).then((recipientUser) => {
          if (recipientUser?.emailPreferences !== false) void sendEmail(recipientUser.email, `New message from ${user.name}`, `${user.name}: ${text.trim()}`, clientUrl(`/?room=${roomCode}`)).catch((error: unknown) => console.error('Unable to deliver chat notification:', error));
        }).catch((error: unknown) => console.error('Unable to load chat recipient:', error));
      }
    }
  });
  socket.on('code:join', async (roomCode: unknown, done?: (result: { ok: boolean; message?: string; language?: string; source?: string }) => void) => {
    const parsed = z.string().regex(/^[A-Z0-9]{8}$/).safeParse(roomCode);
    if (!parsed.success) return done?.({ ok: false, message: 'Invalid room code.' });
    const interview = await Interview.findOne({ roomCode: parsed.data, $or: [{ interviewer: user.userId }, { candidate: user.userId }] });
    if (!interview) return done?.({ ok: false, message: 'You are not an interview participant.' });
    await socket.join(`code:${parsed.data}`);
    const code = await CodeWorkspace.findOneAndUpdate({ interviewId: interview._id }, { $setOnInsert: { interviewId: interview._id } }, { upsert: true, new: true });
    done?.({ ok: true, language: code.language, source: code.source });
  });
  socket.on('code:update', async (data: unknown) => {
    const input = z.object({ roomCode: z.string().regex(/^[A-Z0-9]{8}$/), source: z.string().max(50000), language: z.enum(['javascript', 'typescript', 'python', 'java', 'cpp']) }).safeParse(data);
    if (!input.success || !socket.rooms.has(`code:${input.data.roomCode}`)) return;
    const interview = await Interview.findOne({ roomCode: input.data.roomCode, $or: [{ interviewer: user.userId }, { candidate: user.userId }] });
    if (!interview) return;
    const code = await CodeWorkspace.findOneAndUpdate({ interviewId: interview._id }, { language: input.data.language, source: input.data.source, updatedBy: user.userId }, { upsert: true, new: true });
    socket.to(`code:${input.data.roomCode}`).emit('code:change', { source: code.source, language: code.language, updatedBy: user.userId });
  });
  socket.on('conversation:join', async (id: unknown, done?: (result: { ok: boolean; message?: string }) => void) => {
    const parsed = z.string().regex(/^[a-f\d]{24}$/i).safeParse(id);
    if (!parsed.success) return done?.({ ok: false, message: 'Invalid conversation.' });
    const conversation = await Conversation.findOne({ _id: parsed.data, participants: user.userId });
    if (!conversation) return done?.({ ok: false, message: 'You are not a conversation participant.' });
    await socket.join(`conversation:${parsed.data}`);
    activeRooms.get(socket.id)?.add(`conversation:${parsed.data}`);
    const participants = await User.find({ _id: { $in: conversation.participants } }).select('name lastSeenAt').lean() as unknown as Array<{ _id: unknown; name: string; lastSeenAt?: Date }>;
    for (const participant of participants) io.to(`conversation:${parsed.data}`).emit('conversation:presence', { userId: String(participant._id), name: participant.name, online: (onlineSockets.get(String(participant._id))?.size ?? 0) > 0, lastSeenAt: participant.lastSeenAt });
    done?.({ ok: true });
  });
  socket.on('call:recording-consent', async (data: unknown) => {
    const input = z.object({ roomCode: z.string().regex(/^[A-Z0-9]{8}$/), consent: z.boolean() }).safeParse(data);
    if (!input.success || !socket.rooms.has(input.data.roomCode)) return;
    const interview = await Interview.findOne({ roomCode: input.data.roomCode, $or: [{ interviewer: user.userId }, { candidate: user.userId }] }).select('interviewer candidate').lean() as { interviewer: unknown; candidate: unknown } | null;
    if (!interview) return;
    const consents = recordingConsents.get(input.data.roomCode) ?? new Set<string>();
    if (input.data.consent) consents.add(user.userId); else consents.delete(user.userId);
    recordingConsents.set(input.data.roomCode, consents);
    const participantIds = [String(interview.interviewer), String(interview.candidate)].filter((id) => id && id !== 'null');
    const allowed = participantIds.length === 2 && participantIds.every((id) => consents.has(id));
    io.to(input.data.roomCode).emit('call:recording-consent', { userId: user.userId, consent: input.data.consent, allowed, count: consents.size, required: participantIds.length });
  });
  socket.on('conversation:send', async (data: unknown) => {
    const input = z.object({ conversationId: z.string().regex(/^[a-f\d]{24}$/i), text: z.string().trim().max(2000).default(''), replyTo: z.string().regex(/^[a-f\d]{24}$/i).optional(), attachmentKey: z.string().regex(/^[a-f\d]{24}$/i).optional() }).refine((value) => value.text.length > 0 || Boolean(value.attachmentKey)).safeParse(data);
    if (!input.success) return;
    const conversation = await Conversation.findOne({ _id: input.data.conversationId, participants: user.userId });
    if (!conversation) return;
    let reply = null;
    if (input.data.replyTo) {
      reply = await ChatMessage.findOne({ _id: input.data.replyTo, conversationId: input.data.conversationId });
      if (!reply) return;
    }
    let attachment: { name: string; mimeType: string; size: number; storageKey: string } | undefined;
    if (input.data.attachmentKey) {
      const upload = await ChatUpload.findOne({ _id: input.data.attachmentKey, conversationId: input.data.conversationId, ownerId: user.userId, expiresAt: { $gt: new Date() } });
      if (!upload) return;
      attachment = { name: upload.originalName, mimeType: upload.mimeType, size: upload.size, storageKey: String(upload._id) };
    }
    const message = await ChatMessage.create({ conversationId: input.data.conversationId, roomCode: `conv:${input.data.conversationId}`, sender: user.userId, senderName: user.name, text: input.data.text, replyTo: reply?._id, attachment, deliveredTo: [{ userId: user.userId, at: new Date() }] });
    conversation.lastMessageAt = message.createdAt;
    await conversation.save();
    const payload = serializeMessage(await message.populate('replyTo', 'senderName text deletedAt'));
    io.to(`conversation:${input.data.conversationId}`).emit('chat:message', payload);
    for (const participant of conversation.participants) {
      const recipient = String(participant);
      if (recipient === user.userId) continue;
      for (const recipientSocket of userRooms(recipient)) io.to(recipientSocket).emit('chat:notification', { conversationId: input.data.conversationId, message: payload });
      void User.findById(recipient).then((recipientUser) => {
        if (recipientUser?.emailPreferences !== false) void sendEmail(recipientUser.email, `New message from ${user.name}`, input.data.text || `Shared a file: ${attachment?.name ?? ''}`, clientUrl('/')).catch((error: unknown) => console.error('Unable to deliver chat notification:', error));
      }).catch((error: unknown) => console.error('Unable to load chat recipient:', error));
    }
  });
  socket.on('chat:edit', async (data: unknown) => {
    const input = z.object({ messageId: z.string().regex(/^[a-f\d]{24}$/i), text: z.string().trim().min(1).max(2000) }).safeParse(data);
    if (!input.success) return;
    const prior = await ChatMessage.findOne({ _id: input.data.messageId, sender: user.userId, deletedAt: { $exists: false }, createdAt: { $gt: new Date(Date.now() - 15 * 60 * 1000) } });
    if (!prior || !(await canAccessChatMessage(prior, user.userId, socket))) return;
    const message = await ChatMessage.findByIdAndUpdate(prior._id, { text: input.data.text, editedAt: new Date() }, { new: true }).populate('replyTo', 'senderName text deletedAt');
    if (!message) return;
    const channel = message.conversationId ? `conversation:${message.conversationId}` : message.roomCode;
    io.to(channel).emit('chat:updated', serializeMessage(message));
  });
  socket.on('chat:delete', async (data: unknown) => {
    const input = z.object({ messageId: z.string().regex(/^[a-f\d]{24}$/i) }).safeParse(data);
    if (!input.success) return;
    const prior = await ChatMessage.findOne({ _id: input.data.messageId, sender: user.userId, deletedAt: { $exists: false } });
    if (!prior || !(await canAccessChatMessage(prior, user.userId, socket))) return;
    const message = await ChatMessage.findByIdAndUpdate(prior._id, { text: '', attachment: undefined, deletedAt: new Date() }, { new: true });
    if (!message) return;
    const channel = message.conversationId ? `conversation:${message.conversationId}` : message.roomCode;
    io.to(channel).emit('chat:updated', serializeMessage(message));
  });
  socket.on('chat:reaction', async (data: unknown) => {
    const input = z.object({ messageId: z.string().regex(/^[a-f\d]{24}$/i), emoji: z.string().min(1).max(16) }).safeParse(data);
    if (!input.success) return;
    const message = await ChatMessage.findOne({ _id: input.data.messageId, deletedAt: { $exists: false } });
    if (!message) return;
    const channel = message.conversationId ? `conversation:${message.conversationId}` : message.roomCode;
    if (!(await canAccessChatMessage(message, user.userId, socket))) return;
    const existing = message.reactions.find((item: any) => String(item.userId) === user.userId && item.emoji === input.data.emoji);
    if (existing) message.reactions.pull(existing._id);
    else message.reactions.push({ userId: user.userId, emoji: input.data.emoji });
    await message.save();
    io.to(channel).emit('chat:updated', serializeMessage(message));
  });
  socket.on('chat:read', async (data: unknown) => {
    const input = z.object({ roomCode: z.string().regex(/^[A-Z0-9]{8}$/) }).safeParse(data);
    if (!input.success || !socket.rooms.has(input.data.roomCode)) return;
    const readAt = new Date();
    const unreadMessages = await ChatMessage.find({ roomCode: input.data.roomCode, sender: { $ne: user.userId }, readAt: { $exists: false } }).select('_id').lean();
    if (!unreadMessages.length) return;
    const messageIds = unreadMessages.map((message: any) => String(message._id));
    await ChatMessage.updateMany({ _id: { $in: unreadMessages.map((message: any) => message._id) } }, { $set: { deliveredAt: readAt, readAt } });
    io.to(input.data.roomCode).emit('chat:read', { readerId: user.userId, messageIds, readAt });
  });
  socket.on('conversation:typing', async (data: unknown) => {
    const input = z.object({ conversationId: z.string().regex(/^[a-f\d]{24}$/i), isTyping: z.boolean() }).safeParse(data);
    if (!input.success || !socket.rooms.has(`conversation:${input.data.conversationId}`)) return;
    socket.to(`conversation:${input.data.conversationId}`).emit('chat:typing', { userId: user.userId, name: user.name, isTyping: input.data.isTyping });
  });
  socket.on('conversation:read', async (data: unknown) => {
    const input = z.object({ conversationId: z.string().regex(/^[a-f\d]{24}$/i) }).safeParse(data);
    if (!input.success || !socket.rooms.has(`conversation:${input.data.conversationId}`)) return;
    const readAt = new Date();
    const unread = await ChatMessage.find({ conversationId: input.data.conversationId, sender: { $ne: user.userId }, deletedAt: { $exists: false }, readBy: { $not: { $elemMatch: { userId: user.userId } } } }).select('_id').lean();
    if (!unread.length) return;
    for (const message of unread) await ChatMessage.updateOne({ _id: message._id }, { $addToSet: { readBy: { userId: user.userId, at: readAt }, deliveredTo: { userId: user.userId, at: readAt } }, $set: { deliveredAt: readAt, readAt } });
    io.to(`conversation:${input.data.conversationId}`).emit('chat:read', { readerId: user.userId, messageIds: unread.map((item: any) => String(item._id)), readAt });
  });
  socket.on('chat:typing', (data: unknown) => {
    const input = z.object({ roomCode: z.string().regex(/^[A-Z0-9]{8}$/), isTyping: z.boolean() }).safeParse(data);
    if (input.success && socket.rooms.has(input.data.roomCode)) socket.to(input.data.roomCode).emit('chat:typing', { userId: user.userId, name: user.name, isTyping: input.data.isTyping });
  });
  for (const event of ['webrtc:offer', 'webrtc:answer', 'webrtc:ice']) {
    socket.on(event, (data: unknown) => {
      const input = z.object({ roomCode: z.string().regex(/^[A-Z0-9]{8}$/), payload: z.record(z.string(), z.unknown()) }).safeParse(data);
      if (input.success && socket.rooms.has(input.data.roomCode)) socket.to(input.data.roomCode).emit(event, { userId: user.userId, payload: input.data.payload });
    });
  }
  socket.on('disconnect', () => {
    const current = onlineSockets.get(user.userId);
    current?.delete(socket.id);
    const isOffline = current?.size === 0;
    if (isOffline) { onlineSockets.delete(user.userId); void User.updateOne({ _id: user.userId }, { $set: { lastSeenAt: new Date() } }); }
    for (const roomCode of activeRooms.get(socket.id) ?? []) if (isOffline) {
      if (roomCode.startsWith('conversation:')) io.to(roomCode).emit('conversation:presence', { userId: user.userId, online: false, lastSeenAt: new Date() });
      else io.to(roomCode).emit('presence:update', { userId: user.userId, online: false });
    }
    activeRooms.delete(socket.id);
  });
});

const sendUpcomingReminders = async () => {
  const now = new Date();
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
  const due = await Interview.find({ status: 'scheduled', scheduledAt: { $gt: now, $lte: inOneHour }, reminderSentAt: { $exists: false } }).limit(100);
  for (const candidateInterview of due) {
    const claimed = await Interview.findOneAndUpdate({ _id: candidateInterview._id, reminderSentAt: { $exists: false } }, { $set: { reminderSentAt: new Date() } });
    if (!claimed) continue;
    const [interviewer, candidate] = await Promise.all([User.findById(claimed.interviewer), User.findById(claimed.candidate)]);
    for (const participant of [interviewer, candidate]) if (participant) await publishNotification(participant, claimed, 'interview-reminder', 'Interview starting soon', `“${claimed.title}” starts at ${new Date(claimed.scheduledAt).toLocaleString()}.`);
    if (!candidate && claimed.candidateEmail) void sendEmail(claimed.candidateEmail, 'Interview starting soon', `“${claimed.title}” starts at ${new Date(claimed.scheduledAt).toLocaleString()}.`, clientUrl(`/?register=1&email=${encodeURIComponent(claimed.candidateEmail)}`)).catch((error: unknown) => console.error('Unable to deliver candidate reminder:', error));
  }
};

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ message: 'Something went wrong. Please try again.' });
});

const start = async () => {
  await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/interviewing-app');
  void sendUpcomingReminders().catch((error: unknown) => console.error('Reminder check failed:', error));
  const reminderTimer = setInterval(() => { void sendUpcomingReminders().catch((error: unknown) => console.error('Reminder check failed:', error)); }, 60 * 1000);
  reminderTimer.unref();
  httpServer.listen(PORT, () => console.log(`Interview server listening on http://localhost:${PORT}`));
};
void start().catch((error: unknown) => { console.error('Unable to start server:', error); process.exit(1); });
