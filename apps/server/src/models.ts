import mongoose, { Schema } from 'mongoose';

const userSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['interviewer', 'candidate', 'recruiter'], required: true },
  avatarColor: { type: String, default: '#7c6cf2' },
  emailVerified: { type: Boolean, default: false },
  emailPreferences: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  lastSeenAt: { type: Date },
  headline: { type: String, maxlength: 120, default: '' },
  bio: { type: String, maxlength: 2000, default: '' },
  skills: { type: [String], default: [] },
  education: { type: [{ school: String, degree: String, year: String }], default: [] },
  projects: { type: [{ name: String, description: String, url: String }], default: [] },
  resumeUrl: { type: String, maxlength: 500, default: '' },
  company: { type: String, maxlength: 120, default: '' },
}, { timestamps: true });

const interviewSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  interviewer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  candidate: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  candidateEmail: { type: String, required: true, lowercase: true, trim: true },
  scheduledAt: { type: Date, required: true },
  durationMinutes: { type: Number, min: 15, max: 240, default: 45 },
  interviewType: { type: String, enum: ['technical', 'behavioral', 'hr', 'other'], default: 'technical' },
  instructions: { type: String, maxlength: 2000, default: '' },
  status: { type: String, enum: ['scheduled', 'in-progress', 'completed', 'cancelled'], default: 'scheduled' },
  roomCode: { type: String, required: true, unique: true },
  reminderSentAt: { type: Date },
}, { timestamps: true });

const messageSchema = new Schema({
  roomCode: { type: String, required: true, index: true },
  conversationId: { type: String, index: true },
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: { type: String, required: true },
  text: { type: String, required: true, maxlength: 2000 },
  replyTo: { type: Schema.Types.ObjectId, ref: 'ChatMessage' },
  attachment: { name: String, mimeType: String, size: Number, storageKey: String },
  reactions: { type: [{ userId: { type: Schema.Types.ObjectId, ref: 'User' }, emoji: String }], default: [] },
  editedAt: { type: Date },
  deletedAt: { type: Date },
  deliveredTo: { type: [{ userId: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date }], default: [] },
  readBy: { type: [{ userId: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date }], default: [] },
  deliveredAt: { type: Date },
  readAt: { type: Date },
}, { timestamps: true });

const conversationSchema = new Schema({
  participants: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], required: true, validate: (value: unknown[]) => value.length >= 2 && value.length <= 50 },
  kind: { type: String, enum: ['direct', 'group'], required: true },
  name: { type: String, maxlength: 100, default: '' },
  lastMessageAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });
conversationSchema.index({ participants: 1, kind: 1, name: 1 });

const chatUploadSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  conversationId: { type: String, required: true, index: true },
  originalName: { type: String, required: true, maxlength: 180 },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true, max: 10 * 1024 * 1024 },
  data: { type: Buffer, required: true, select: false },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

const codeWorkspaceSchema = new Schema({
  interviewId: { type: Schema.Types.ObjectId, ref: 'Interview', required: true, unique: true, index: true },
  language: { type: String, enum: ['javascript', 'typescript', 'python', 'java', 'cpp'], default: 'javascript' },
  source: { type: String, maxlength: 50000, default: '// Work through the problem together.\n' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const authTokenSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  purpose: { type: String, enum: ['verify-email', 'reset-password'], required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

const notificationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, enum: ['interview-created', 'interview-updated', 'interview-cancelled', 'interview-reminder'], required: true },
  title: { type: String, required: true, maxlength: 140 },
  message: { type: String, required: true, maxlength: 500 },
  interviewId: { type: Schema.Types.ObjectId, ref: 'Interview' },
  readAt: { type: Date },
}, { timestamps: true });

const feedbackSchema = new Schema({
  interviewId: { type: Schema.Types.ObjectId, ref: 'Interview', required: true, index: true },
  authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  notes: { type: String, maxlength: 2000, default: '' },
}, { timestamps: true });
feedbackSchema.index({ interviewId: 1, authorId: 1 }, { unique: true });

const jobSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  company: { type: String, required: true, trim: true, maxlength: 120 },
  location: { type: String, required: true, trim: true, maxlength: 120 },
  salary: { type: String, maxlength: 120, default: '' },
  experience: { type: String, maxlength: 80, default: '' },
  skills: { type: [String], default: [] },
  description: { type: String, required: true, maxlength: 8000 },
  deadline: { type: Date },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
}, { timestamps: true });

const applicationSchema = new Schema({
  jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
  candidateId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['applied', 'shortlisted', 'assessment', 'technical-interview', 'hr-interview', 'selected', 'rejected'], default: 'applied' },
  coverLetter: { type: String, maxlength: 4000, default: '' },
}, { timestamps: true });
applicationSchema.index({ jobId: 1, candidateId: 1 }, { unique: true });

const evaluationSchema = new Schema({
  interviewId: { type: Schema.Types.ObjectId, ref: 'Interview', required: true, index: true },
  authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  technicalSkills: { type: Number, min: 1, max: 5, required: true },
  communication: { type: Number, min: 1, max: 5, required: true },
  problemSolving: { type: Number, min: 1, max: 5, required: true },
  notes: { type: String, maxlength: 4000, default: '' },
  recommendation: { type: String, enum: ['reject', 'hold', 'proceed'], required: true },
  candidateSummary: { type: String, maxlength: 2000, default: '' },
}, { timestamps: true });
evaluationSchema.index({ interviewId: 1, authorId: 1 }, { unique: true });

export const User: mongoose.Model<any> = (mongoose.models.User as mongoose.Model<any> | undefined) ?? mongoose.model<any>('User', userSchema);
export const Interview: mongoose.Model<any> = (mongoose.models.Interview as mongoose.Model<any> | undefined) ?? mongoose.model<any>('Interview', interviewSchema);
export const ChatMessage: mongoose.Model<any> = (mongoose.models.ChatMessage as mongoose.Model<any> | undefined) ?? mongoose.model<any>('ChatMessage', messageSchema);
export const Conversation: mongoose.Model<any> = (mongoose.models.Conversation as mongoose.Model<any> | undefined) ?? mongoose.model<any>('Conversation', conversationSchema);
export const ChatUpload: mongoose.Model<any> = (mongoose.models.ChatUpload as mongoose.Model<any> | undefined) ?? mongoose.model<any>('ChatUpload', chatUploadSchema);
export const CodeWorkspace: mongoose.Model<any> = (mongoose.models.CodeWorkspace as mongoose.Model<any> | undefined) ?? mongoose.model<any>('CodeWorkspace', codeWorkspaceSchema);
export const AuthToken: mongoose.Model<any> = (mongoose.models.AuthToken as mongoose.Model<any> | undefined) ?? mongoose.model<any>('AuthToken', authTokenSchema);
export const Notification: mongoose.Model<any> = (mongoose.models.Notification as mongoose.Model<any> | undefined) ?? mongoose.model<any>('Notification', notificationSchema);
export const Feedback: mongoose.Model<any> = (mongoose.models.Feedback as mongoose.Model<any> | undefined) ?? mongoose.model<any>('Feedback', feedbackSchema);
export const Job: mongoose.Model<any> = (mongoose.models.Job as mongoose.Model<any> | undefined) ?? mongoose.model<any>('Job', jobSchema);
export const Application: mongoose.Model<any> = (mongoose.models.Application as mongoose.Model<any> | undefined) ?? mongoose.model<any>('Application', applicationSchema);
export const Evaluation: mongoose.Model<any> = (mongoose.models.Evaluation as mongoose.Model<any> | undefined) ?? mongoose.model<any>('Evaluation', evaluationSchema);
