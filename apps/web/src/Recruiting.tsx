import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, BriefcaseBusiness, Check, Plus, Sparkles, UserRound, Users, X } from 'lucide-react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
type Role = 'interviewer' | 'candidate' | 'recruiter';
type User = { id: string; name: string; email: string; role: Role };
type Job = { _id: string; title: string; company: string; location: string; salary: string; experience: string; skills: string[]; description: string; deadline?: string; status: 'open' | 'closed' };
type Application = { _id: string; status: string; coverLetter: string; createdAt: string; jobId: Job; candidateId?: { _id: string; name: string; email: string; headline?: string; skills?: string[]; resumeUrl?: string } };
type Profile = { name: string; email: string; role: Role; headline?: string; bio?: string; skills?: string[]; education?: Array<{ school: string; degree: string; year: string }>; projects?: Array<{ name: string; description: string; url?: string }>; resumeUrl?: string; company?: string };
type Metrics = { totalCandidates: number; interviewsToday: number; applications: number; shortlisted: number; selected: number; jobCounts: Array<{ title: string; count: number }> };

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? 'Request failed.');
  return body as T;
}

const stages = ['applied', 'shortlisted', 'assessment', 'technical-interview', 'hr-interview', 'selected', 'rejected'];
const stageName = (stage: string) => ({ applied: 'Applied', shortlisted: 'Shortlisted', assessment: 'Assessment', 'technical-interview': 'Technical interview', 'hr-interview': 'HR interview', selected: 'Selected', rejected: 'Not selected' }[stage] ?? stage);

export function JobsPage({ token, user }: { token: string; user: User }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [applied, setApplied] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    void request<Job[]>('/api/jobs', token).then(setJobs).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load jobs.'));
    if (user.role === 'candidate') void request<Application[]>('/api/applications', token).then((items) => setApplied(items.map((item) => item.jobId?._id).filter(Boolean))).catch(() => undefined);
  }, [token, user.role]);
  async function createJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      const job = await request<Job>('/api/jobs', token, { method: 'POST', body: JSON.stringify({ title: data.get('title'), company: data.get('company'), location: data.get('location'), salary: data.get('salary'), experience: data.get('experience'), description: data.get('description'), skills: String(data.get('skills')).split(',').map((skill) => skill.trim()).filter(Boolean), ...(data.get('deadline') ? { deadline: new Date(String(data.get('deadline'))).toISOString() } : {}) }) });
      setJobs((items) => [job, ...items]); setShowForm(false); setNotice('Job published successfully.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not publish this job.'); }
    finally { setBusy(false); }
  }
  async function apply(job: Job) {
    try { await request(`/api/jobs/${job._id}/applications`, token, { method: 'POST', body: JSON.stringify({ coverLetter: '' }) }); setApplied((items) => [...items, job._id]); setNotice(`Application sent to ${job.company}.`); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not apply.'); }
  }
  async function closeJob(job: Job) {
    try { const updated = await request<Job>(`/api/jobs/${job._id}`, token, { method: 'PATCH', body: JSON.stringify({ status: job.status === 'open' ? 'closed' : 'open' }) }); setJobs((items) => items.map((item) => item._id === job._id ? updated : item)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update the job.'); }
  }
  return <section className="feature-page"><div className="feature-heading"><div><div className="eyebrow">OPPORTUNITIES</div><h2>{user.role === 'recruiter' ? 'Your job postings' : 'Find your next opportunity'}</h2><p>{user.role === 'recruiter' ? 'Post roles and follow every application from one place.' : 'Explore open roles and apply in a couple of clicks.'}</p></div>{user.role === 'recruiter' && <button className="button button-primary" onClick={() => setShowForm(true)}><Plus size={16} /> Create job</button>}</div>
    {notice && <div className="form-info">{notice}</div>}{error && <div className="form-error">{error}</div>}
    {showForm && <div className="modal-backdrop"><div className="modal-card"><div className="modal-top"><div className="modal-icon"><BriefcaseBusiness size={20} /></div><button className="icon-button" onClick={() => setShowForm(false)} aria-label="Close"><X size={19} /></button></div><div className="eyebrow">NEW OPPORTUNITY</div><h2>Create a job posting</h2><form onSubmit={createJob}><label className="field-label">Job title<input name="title" required maxLength={120} placeholder="Frontend Developer" /></label><label className="field-label">Company<input name="company" required maxLength={120} placeholder="Company name" /></label><div className="form-two-cols"><label className="field-label">Location<input name="location" required placeholder="Remote / city" /></label><label className="field-label">Salary range<input name="salary" placeholder="$80k–$110k" /></label></div><div className="form-two-cols"><label className="field-label">Experience<input name="experience" placeholder="2+ years" /></label><label className="field-label">Application deadline<input name="deadline" type="date" min={new Date().toISOString().slice(0, 10)} /></label></div><label className="field-label">Skills, comma-separated<input name="skills" placeholder="React, TypeScript, CSS" /></label><label className="field-label">Description<textarea name="description" required minLength={20} maxLength={8000} rows={5} placeholder="Describe the role, team and responsibilities…" /></label>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button button-light" onClick={() => setShowForm(false)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Publishing…' : 'Publish job'}<ArrowRight size={16} /></button></div></form></div></div>}
    {!jobs.length ? <div className="empty-state"><div className="empty-art"><BriefcaseBusiness size={24} /></div><h3>No open roles yet</h3><p>{user.role === 'recruiter' ? 'Create your first job posting to start receiving applicants.' : 'Check back soon for new opportunities.'}</p></div> : <div className="job-grid">{jobs.map((job) => <article className="job-card" key={job._id}><div className="job-card-top"><div className="job-company-mark">{job.company.slice(0, 1).toUpperCase()}</div><span className={`status-pill ${job.status === 'closed' ? 'status-cancelled' : 'status-completed'}`}>{job.status}</span></div><h3>{job.title}</h3><p className="job-company">{job.company} <span>·</span> {job.location}</p><div className="job-tags">{job.skills.slice(0, 5).map((skill) => <span key={skill}>{skill}</span>)}</div><p className="job-description">{job.description}</p><div className="job-meta"><span>{job.salary || 'Salary not listed'}</span><span>{job.experience || 'Experience flexible'}</span></div>{user.role === 'candidate' ? <button className="button button-primary job-apply" disabled={applied.includes(job._id) || job.status === 'closed'} onClick={() => void apply(job)}>{applied.includes(job._id) ? <><Check size={15} /> Applied</> : 'Apply now'}<ArrowRight size={15} /></button> : user.role === 'recruiter' && <button className="button button-light job-apply" onClick={() => void closeJob(job)}>{job.status === 'open' ? 'Close applications' : 'Reopen job'}</button>}</article>)}</div>}
  </section>;
}

export function ApplicationsPage({ token, user }: { token: string; user: User }) {
  const [applications, setApplications] = useState<Application[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { void request<Application[]>('/api/applications', token).then(setApplications).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load applications.')); }, [token]);
  async function downloadResume(url?: string) {
    if (!url) return;
    try { const response = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error('Résumé download is unavailable.'); const blob = await response.blob(); const objectUrl = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = 'candidate-resume'; anchor.click(); URL.revokeObjectURL(objectUrl); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not download résumé.'); }
  }
  async function updateStatus(application: Application, status: string) {
    try { const updated = await request<Application>(`/api/applications/${application._id}/status`, token, { method: 'PATCH', body: JSON.stringify({ status }) }); setApplications((items) => items.map((item) => item._id === updated._id ? { ...item, status: updated.status } : item)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update application.'); }
  }
  return <section className="feature-page"><div className="feature-heading"><div><div className="eyebrow">APPLICATION TRACKER</div><h2>{user.role === 'recruiter' ? 'Candidate pipeline' : 'Your applications'}</h2><p>{user.role === 'recruiter' ? 'Review candidates and move applications to the next stage.' : 'See where each application is in the process.'}</p></div></div>{error && <div className="form-error">{error}</div>}{!applications.length ? <div className="empty-state"><div className="empty-art"><Users size={24} /></div><h3>No applications yet</h3><p>{user.role === 'candidate' ? 'Your job applications and their progress will appear here.' : 'Applications to your postings will appear here.'}</p></div> : <div className="application-list">{applications.map((application) => <article className="application-card" key={application._id}><div className="application-card-heading"><div><h3>{application.jobId?.title ?? 'Job posting'}</h3><p>{application.jobId?.company} · {application.candidateId?.name ?? 'You'} · Applied {new Date(application.createdAt).toLocaleDateString()}</p></div><span className={`status-pill status-${application.status === 'rejected' ? 'cancelled' : application.status === 'selected' ? 'completed' : 'scheduled'}`}>{stageName(application.status)}</span></div>{user.role === 'recruiter' && application.candidateId && <div className="candidate-summary"><div className="mini-avatar">{application.candidateId.name.slice(0, 1)}</div><div><strong>{application.candidateId.name}</strong><span>{application.candidateId.headline || application.candidateId.email}</span><div className="job-tags">{application.candidateId.skills?.slice(0, 6).map((skill) => <span key={skill}>{skill}</span>)}</div></div>{application.candidateId.resumeUrl && <button className="button button-light resume-button" onClick={() => void downloadResume(application.candidateId?.resumeUrl)}>View résumé</button>}</div>}{user.role === 'recruiter' ? <label className="stage-select">Move to stage<select value={application.status} onChange={(event) => void updateStatus(application, event.target.value)}>{stages.map((stage) => <option key={stage} value={stage}>{stageName(stage)}</option>)}</select></label> : <div className="application-timeline">{stages.slice(0, 6).map((stage, index) => <div className={`timeline-step ${stages.indexOf(application.status) >= index && application.status !== 'rejected' ? 'step-done' : ''}`} key={stage}><span>{stages.indexOf(application.status) >= index && application.status !== 'rejected' ? <Check size={12} /> : index + 1}</span><small>{stageName(stage)}</small></div>)}</div>}</article>)}</div>}</section>;
}

export function ProfilePage({ token, user }: { token: string; user: User }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { void request<Profile>('/api/profile', token).then(setProfile).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load profile.')); }, [token]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile) return; setBusy(true); setError(''); setSaved(false);
    const data = new FormData(event.currentTarget);
    const projects = String(data.get('projects') ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [name, url = ''] = line.split('|'); return { name: name?.trim() ?? '', url: url.trim(), description: '' }; });
    const education = String(data.get('education') ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [school, degree = '', year = ''] = line.split('|'); return { school: school?.trim() ?? '', degree: degree.trim(), year: year.trim() }; });
    try {
      const updated = await request<Profile>('/api/profile', token, { method: 'PATCH', body: JSON.stringify({ headline: data.get('headline'), bio: data.get('bio'), skills: String(data.get('skills')).split(',').map((value) => value.trim()).filter(Boolean), resumeUrl: data.get('resumeUrl'), company: data.get('company'), education, projects }) });
      setProfile(updated); setSaved(true);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save profile.'); }
    finally { setBusy(false); }
  }
  if (!profile) return <section className="feature-page"><div className="loading-screen">Loading your profile…</div></section>;
  return <section className="feature-page"><div className="feature-heading"><div><div className="eyebrow">YOUR PROFESSIONAL PROFILE</div><h2>Profile & résumé</h2><p>Help interviewers and recruiters get to know you.</p></div></div>{error && <div className="form-error">{error}</div>}{saved && <div className="form-info">Profile saved successfully.</div>}
  <div className="profile-layout"><aside className="profile-preview"><div className="avatar avatar-purple profile-large">{profile.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</div><h3>{profile.name}</h3><p>{profile.headline || (user.role === 'recruiter' ? 'Recruiter' : user.role === 'candidate' ? 'Add a professional headline' : 'Interviewer')}</p>{profile.company && <span>{profile.company}</span>}<div className="profile-preview-skills">{profile.skills?.map((skill) => <span key={skill}>{skill}</span>)}</div>{profile.resumeUrl && <a href={profile.resumeUrl} target="_blank" rel="noreferrer">View résumé</a>}</aside><form className="profile-form" onSubmit={save}><div className="eyebrow">PROFILE DETAILS</div>{user.role === 'recruiter' && <label className="field-label">Company<input name="company" defaultValue={profile.company} maxLength={120} /></label>}<label className="field-label">Headline<input name="headline" defaultValue={profile.headline} maxLength={120} placeholder="Software developer · React & Node.js" /></label><label className="field-label">About<textarea name="bio" rows={4} maxLength={2000} defaultValue={profile.bio} placeholder="A short introduction…" /></label><label className="field-label">Skills, comma-separated<input name="skills" defaultValue={profile.skills?.join(', ')} placeholder="React, Node.js, MongoDB" /></label><label className="field-label">Education, one entry per line (School | Degree | Year)<textarea name="education" rows={3} defaultValue={profile.education?.map((item) => `${item.school} | ${item.degree} | ${item.year}`).join('\n')} placeholder="University | B.Tech Computer Science | 2025" /></label><label className="field-label">Projects, one entry per line (Name | URL)<textarea name="projects" rows={3} defaultValue={profile.projects?.map((item) => `${item.name} | ${item.url ?? ''}`).join('\n')} placeholder="Portfolio project | https://example.com" /></label><label className="field-label">Résumé link<input name="resumeUrl" type="url" defaultValue={profile.resumeUrl} placeholder="https://…" /></label><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}<ArrowRight size={16} /></button></form>
  </div></section>;
}

export function RecruiterDashboard({ token }: { token: string }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  useEffect(() => { void request<Metrics>('/api/recruiter/metrics', token).then(setMetrics).catch(() => undefined); }, [token]);
  if (!metrics) return <section className="stat-grid" aria-label="Recruiter statistics"><div className="stat-card stat-lilac"><div className="stat-icon"><Users size={19} /></div><span className="stat-label">CANDIDATES</span><strong>—</strong><span className="stat-note">in the talent pool</span></div><div className="stat-card stat-mint"><div className="stat-icon"><Check size={19} /></div><span className="stat-label">APPLICATIONS</span><strong>—</strong><span className="stat-note">across your job posts</span></div><div className="stat-card stat-peach"><div className="stat-icon"><BriefcaseBusiness size={19} /></div><span className="stat-label">INTERVIEWS TODAY</span><strong>—</strong><span className="stat-note">scheduled sessions</span></div></section>;
  return <><section className="stat-grid" aria-label="Recruiter statistics"><div className="stat-card stat-lilac"><div className="stat-icon"><Users size={19} /></div><span className="stat-label">CANDIDATES</span><strong>{metrics.totalCandidates}</strong><span className="stat-note">in the talent pool</span></div><div className="stat-card stat-mint"><div className="stat-icon"><Check size={19} /></div><span className="stat-label">APPLICATIONS</span><strong>{metrics.applications}</strong><span className="stat-note">{metrics.shortlisted} shortlisted · {metrics.selected} selected</span></div><div className="stat-card stat-peach"><div className="stat-icon"><BriefcaseBusiness size={19} /></div><span className="stat-label">INTERVIEWS TODAY</span><strong>{metrics.interviewsToday}</strong><span className="stat-note">scheduled sessions</span></div></section><section className="recruiter-jobs"><div className="eyebrow">YOUR PIPELINE</div><h2>Applications by role</h2>{metrics.jobCounts.length ? metrics.jobCounts.map((item) => <div className="metric-bar" key={item.title}><span>{item.title}</span><b>{item.count}</b><i style={{ width: `${Math.max(8, item.count / Math.max(...metrics.jobCounts.map((job) => job.count), 1) * 100)}%` }} /></div>) : <p className="job-company">Publish a role to start building your candidate pipeline.</p>}</section><section className="recruiter-jobs"><div className="eyebrow">OPTIONAL AI ASSISTANT</div><h2>Interview question starter</h2><p className="job-company">Generate a draft list of role-specific questions when an AI provider is configured.</p><button className="button button-light" onClick={() => setAiOpen(true)}>Generate questions</button></section>{aiOpen && <QuestionGenerator token={token} onClose={() => setAiOpen(false)} />}</>;
}

function QuestionGenerator({ token, onClose }: { token: string; onClose: () => void }) {
  const [role, setRole] = useState('Frontend Developer');
  const [experience, setExperience] = useState('Junior');
  const [skills, setSkills] = useState('React, JavaScript, CSS');
  const [questions, setQuestions] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function generate(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await request<{ questions: string }>('/api/ai/interview-questions', token, { method: 'POST', body: JSON.stringify({ role, experience, skills: skills.split(',').map((item) => item.trim()).filter(Boolean) }) }); setQuestions(result.questions); }
    catch (err) { setError(err instanceof Error ? err.message : 'Question generation is unavailable.'); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><div className="modal-card"><div className="modal-top"><div className="modal-icon"><Sparkles size={20} /></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div><div className="eyebrow">OPTIONAL AI ASSISTANT</div><h2>Generate interview questions</h2><form onSubmit={generate}><label className="field-label">Role<input value={role} onChange={(event) => setRole(event.target.value)} required /></label><label className="field-label">Experience<input value={experience} onChange={(event) => setExperience(event.target.value)} /></label><label className="field-label">Skills, comma-separated<input value={skills} onChange={(event) => setSkills(event.target.value)} required /></label><button className="button button-primary" disabled={busy}>{busy ? 'Generating…' : 'Generate questions'}<ArrowRight size={15} /></button></form>{error && <div className="form-error">{error}</div>}{questions && <pre className="ai-question-results">{questions}</pre>}</div></div>;
}

export function EvaluationModal({ interview, token, onClose }: { interview: { _id: string; title: string }; token: string; onClose: () => void }) {
  const [rating, setRating] = useState({ technicalSkills: 4, communication: 4, problemSolving: 4 });
  const [notes, setNotes] = useState('');
  const [candidateSummary, setCandidateSummary] = useState('');
  const [recommendation, setRecommendation] = useState<'reject' | 'hold' | 'proceed'>('proceed');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    try { await request(`/api/interviews/${interview._id}/evaluation`, token, { method: 'POST', body: JSON.stringify({ ...rating, notes, candidateSummary, recommendation }) }); setSaved(true); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save evaluation.'); }
  }
  return <div className="modal-backdrop"><div className="modal-card"><div className="modal-top"><div className="modal-icon"><UserRound size={20} /></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div><div className="eyebrow">PRIVATE INTERVIEW EVALUATION</div><h2>{saved ? 'Evaluation saved.' : interview.title}</h2>{saved ? <><p>Private notes are visible only to interviewers. The candidate summary is shared with the candidate.</p><div className="modal-actions"><button className="button button-primary" onClick={onClose}>Done</button></div></> : <form onSubmit={submit}><div className="form-three-cols">{(['technicalSkills', 'communication', 'problemSolving'] as const).map((criterion) => <label className="field-label" key={criterion}>{criterion === 'technicalSkills' ? 'Technical skills' : criterion === 'problemSolving' ? 'Problem solving' : 'Communication'}<select value={rating[criterion]} onChange={(event) => setRating((current) => ({ ...current, [criterion]: Number(event.target.value) }))}>{[5, 4, 3, 2, 1].map((number) => <option value={number} key={number}>{number} / 5</option>)}</select></label>)}</div><label className="field-label">Private interviewer notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={4000} rows={3} placeholder="Visible only to interviewers…" /></label><label className="field-label">Candidate feedback<textarea value={candidateSummary} onChange={(event) => setCandidateSummary(event.target.value)} maxLength={2000} rows={3} placeholder="The candidate will be able to read this…" /></label><label className="field-label">Recommendation<select value={recommendation} onChange={(event) => setRecommendation(event.target.value as typeof recommendation)}><option value="proceed">Proceed</option><option value="hold">Hold</option><option value="reject">Do not proceed</option></select></label>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button button-light" onClick={onClose}>Cancel</button><button className="button button-primary">Save evaluation</button></div></form>}</div></div>;
}

export function CandidateEvaluationModal({ interview, token, onClose }: { interview: { _id: string; title: string }; token: string; onClose: () => void }) {
  const [evaluation, setEvaluation] = useState<{ technicalSkills: number; communication: number; problemSolving: number; candidateSummary?: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { void request<typeof evaluation>(`/api/interviews/${interview._id}/evaluation`, token).then(setEvaluation).catch(() => setEvaluation(null)).finally(() => setLoaded(true)); }, [interview._id, token]);
  return <div className="modal-backdrop"><div className="modal-card"><div className="modal-top"><div className="modal-icon"><UserRound size={20} /></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div><div className="eyebrow">INTERVIEW FEEDBACK</div><h2>{interview.title}</h2>{!loaded ? <p>Loading your feedback…</p> : !evaluation || !evaluation.candidateSummary ? <p>Your interviewer hasn’t shared feedback yet.</p> : <><div className="evaluation-ratings">{[['Technical skills', evaluation.technicalSkills], ['Communication', evaluation.communication], ['Problem solving', evaluation.problemSolving]].map(([label, score]) => <div key={String(label)}><span>{label}</span><strong>{score} / 5</strong></div>)}</div><div className="shared-feedback"><strong>Message from your interviewer</strong><p>{evaluation.candidateSummary}</p></div></>}<div className="modal-actions"><button className="button button-primary" onClick={onClose}>Done</button></div></div></div>;
}

export function ResumeUploadPanel({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true); setError(''); setMessage('');
    const form = new FormData(); form.append('file', file);
    try {
      const response = await fetch(`${API}/api/profile/resume`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? 'Upload failed.');
      setMessage(`Résumé uploaded: ${body.name}`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not upload résumé.'); }
    finally { setBusy(false); }
  }
  return <section className="resume-upload-panel"><div><strong>Private résumé file</strong><p>PDF or DOCX, maximum 10 MB. Recruiters can download it only after you apply to one of their jobs.</p></div><label className="button button-light">{busy ? 'Uploading…' : 'Choose résumé'}<input type="file" hidden disabled={busy} accept="application/pdf,.pdf,.docx" onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ''; }} /></label>{message && <span className="form-info">{message}</span>}{error && <span className="form-error">{error}</span>}</section>;
}
