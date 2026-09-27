import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  ArrowDownLeft, ArrowLeft, ArrowRight, Bell, BriefcaseBusiness, CalendarDays, Check, ChevronDown, CircleHelp,
  Clock3, Code2, Copy, FileText, LogOut, Menu, MessageCircle, Mic, MicOff,
  Maximize2, Paperclip, Plus, ScreenShare, Search, Settings2, ShieldCheck, Sparkles, Video, VideoOff,
  UserRound, Users, X,
} from 'lucide-react';
import { ApplicationsPage, CandidateEvaluationModal, EvaluationModal, JobsPage, ProfilePage, RecruiterDashboard } from './Recruiting';
import { ConversationsPage } from './Conversations';
import { CollaborativeEditor } from './CollaborativeEditor';
import { ResumeUploadPanel } from './ResumeUploadPanel';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
type Role = 'interviewer' | 'candidate' | 'recruiter';
type AuthMode = 'login' | 'register' | 'forgot' | 'reset';
type User = { id: string; name: string; email: string; role: Role };
type Person = { _id?: string; id?: string; name: string; email?: string };
type Interview = { _id: string; title: string; roomCode: string; scheduledAt: string; durationMinutes: number; interviewType: 'technical' | 'behavioral' | 'hr' | 'other'; instructions?: string; status: 'scheduled' | 'in-progress' | 'completed' | 'cancelled'; interviewer: Person; candidate: Person | null; candidateEmail?: string };
type ChatMessage = { id: string; conversationId?: string; roomCode?: string; senderId: string; senderName: string; text: string; createdAt: string; deliveredAt?: string; readAt?: string | null; deliveredTo?: Array<{ userId: string; at: string }>; readBy?: Array<{ userId: string; at: string }>; editedAt?: string; deleted?: boolean; replyTo?: { id: string; senderName: string; text: string }; attachment?: { name: string; mimeType: string; size: number; url: string }; reactions?: Array<{ userId: string; emoji: string }> };
type AppNotification = { _id?: string; id?: string; title: string; message: string; createdAt: string; readAt?: string | null; interviewId?: string };

async function api<T>(path: string, token?: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? 'Something went wrong.');
  return body as T;
}

const initials = (name = '') => name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase();
const prettyTime = (date: string) => new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const prettyDate = (date: string) => new Date(date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

async function downloadCalendar(item: Interview, token: string) {
  const response = await fetch(`${API}/api/interviews/${item._id}/calendar`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `interview-${item.roomCode}.ics`; anchor.click();
  URL.revokeObjectURL(url);
}

async function cancelInterview(item: Interview, token: string, setInterviews: (update: (items: Interview[]) => Interview[]) => void) {
  if (!window.confirm(`Cancel “${item.title}”? Both participants will be notified.`)) return;
  try {
    const updated = await api<Interview>(`/api/interviews/${item._id}/status`, token, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
    setInterviews((items) => items.map((existing) => existing._id === updated._id ? { ...existing, status: 'cancelled' } : existing));
  } catch (error) { window.alert(error instanceof Error ? error.message : 'Could not cancel this interview.'); }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState(() => localStorage.getItem('interviewly_token') ?? '');
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(Boolean(token));
  const [authMode, setAuthMode] = useState<AuthMode>(() => { const params = new URLSearchParams(window.location.search); return params.has('reset') ? 'reset' : params.get('register') === '1' ? 'register' : 'login'; });
  const [section, setSection] = useState<'overview' | 'interviews' | 'history' | 'jobs' | 'applications' | 'profile' | 'chats'>('overview');
  const [search, setSearch] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [activeInterview, setActiveInterview] = useState<Interview | null>(null);
  const [notice, setNotice] = useState('');
  const [notifications, setNotifications] = useState(0);
  const [notificationItems, setNotificationItems] = useState<AppNotification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [feedbackInterview, setFeedbackInterview] = useState<Interview | null>(null);
  const [scheduleInterview, setScheduleInterview] = useState<Interview | null>(null);
  const verifiedMessage = new URLSearchParams(window.location.search).has('verified') ? 'Email verified. You can now sign in.' : '';

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    Promise.all([api<User>('/api/auth/me', token), api<Interview[]>('/api/interviews', token)])
      .then(([me, items]) => {
        setUser(me); setInterviews(items);
        const roomCode = new URLSearchParams(window.location.search).get('room');
        const invited = roomCode ? items.find((item) => item.roomCode === roomCode) : undefined;
        if (invited) { setActiveInterview(invited); window.history.replaceState({}, '', window.location.pathname); }
      })
      .catch(() => { localStorage.removeItem('interviewly_token'); setToken(''); setUser(null); })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (!token || !user) return;
    void Promise.all([api<AppNotification[]>('/api/notifications', token), api<{ enabled: boolean }>('/api/users/email-preferences', token, { method: 'GET' }).catch(() => ({ enabled: true }))])
      .then(([items, preferences]) => { setNotificationItems(items); setNotifications(items.filter((item) => !item.readAt).length); setEmailNotifications(preferences.enabled); })
      .catch(() => undefined);
  }, [token, user]);

  useEffect(() => {
    if (!token || !user) return;
    const socket = io(API, { auth: { token } });
    socket.on('notification', (item: AppNotification) => {
      setNotifications((count) => count + 1);
      setNotificationItems((items) => [{ ...item, id: item.id ?? crypto.randomUUID(), createdAt: item.createdAt ?? new Date().toISOString(), readAt: null }, ...items]);
      setNotice(item.message);
      window.setTimeout(() => setNotice(''), 4500);
      void api<Interview[]>('/api/interviews', token).then(setInterviews).catch(() => undefined);
    });
    return () => { socket.disconnect(); };
  }, [token, user]);

  const logout = () => { localStorage.removeItem('interviewly_token'); setToken(''); setUser(null); setInterviews([]); setNotificationItems([]); setActiveInterview(null); };
  const updateEmailNotifications = async (enabled: boolean) => {
    setEmailNotifications(enabled);
    try { await api('/api/users/email-preferences', token, { method: 'PATCH', body: JSON.stringify({ enabled }) }); }
    catch { setEmailNotifications(!enabled); }
  };
  const markNotificationsRead = async () => {
    setNotificationItems((items) => items.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    setNotifications(0);
    await api('/api/notifications/read-all', token, { method: 'PATCH' }).catch(() => undefined);
  };
  const handleInterviewStatus = useCallback((id: string, status: Interview['status']) => {
    setInterviews((items) => items.map((item) => item._id === id ? { ...item, status } : item));
    setActiveInterview((item) => item?._id === id ? { ...item, status } : item);
    void api<Interview>(`/api/interviews/${id}/status`, token, { method: 'PATCH', body: JSON.stringify({ status }) })
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Could not update interview status.'));
  }, [token]);
  const upcoming = useMemo(() => interviews.filter((item) => item.status === 'scheduled' || item.status === 'in-progress').sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt)), [interviews]);
  const history = useMemo(() => interviews.filter((item) => item.status === 'completed' || item.status === 'cancelled'), [interviews]);

  if (loading) return <div className="loading-screen"><div className="brand-mark"><Sparkles size={20} /></div><span>Getting your space ready…</span></div>;
  if (!user || !token) return <AuthScreen mode={authMode} onModeChange={setAuthMode} onSuccess={(nextToken, nextUser) => { localStorage.setItem('interviewly_token', nextToken); setToken(nextToken); setUser(nextUser); }} initialMessage={verifiedMessage} />;
  if (activeInterview) return <CallRoom interview={activeInterview} token={token} user={user} onClose={() => setActiveInterview(null)} onStatusChange={handleInterviewStatus} />;

  const navItems = [
    { key: 'overview', label: 'Overview', icon: Code2 },
    { key: 'interviews', label: 'My interviews', icon: CalendarDays, count: upcoming.length },
    { key: 'history', label: 'History', icon: FileText },
    { key: 'jobs', label: 'Jobs', icon: BriefcaseBusiness },
    { key: 'chats', label: 'Messages', icon: MessageCircle },
    { key: 'applications', label: 'Applications', icon: Users },
    { key: 'profile', label: 'My profile', icon: UserRound },
  ] as const;
  const visible = (section === 'history' ? history : upcoming).filter((item) => {
    const query = search.trim().toLowerCase();
    return !query || `${item.title} ${item.interviewer.name} ${item.candidate?.name ?? item.candidateEmail ?? ''}`.toLowerCase().includes(query);
  });

  return <div className="app-shell">
    <aside className={`sidebar ${mobileMenuOpen ? 'mobile-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Sparkles size={20} strokeWidth={2.5} /></div><span>interviewly</span><button className="mobile-close" aria-label="Close menu" onClick={() => setMobileMenuOpen(false)}><X size={18} /></button></div>
      <div className="workspace-label">WORKSPACE <ChevronDown size={13} /></div>
      <nav className="nav-list" aria-label="Main navigation">
        {navItems.filter(({ key }) => key !== 'applications' || user.role !== 'interviewer').map(({ key, label, icon: Icon, ...rest }) => <button key={key} onClick={() => { setSection(key); setMobileMenuOpen(false); }} className={`nav-item ${section === key ? 'selected' : ''}`}><Icon size={18} /><span>{label}</span>{'count' in rest && rest.count > 0 && <span className="nav-count">{rest.count}</span>}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="side-help"><div className="help-icon"><CircleHelp size={18} /></div><div><strong>Need a hand?</strong><span>Visit our help center</span></div><ArrowRight size={15} /></div>
        <div className="profile-card"><div className="avatar avatar-purple">{initials(user.name)}</div><div className="profile-copy"><strong>{user.name}</strong><span>{user.role === 'interviewer' ? 'Interviewer' : user.role === 'recruiter' ? 'Recruiter' : 'Candidate'}</span></div><button className="icon-button" onClick={logout} title="Sign out"><LogOut size={17} /></button></div>
      </div>
    </aside>
    {mobileMenuOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)} />}
    <main className="main-area">
      <header className="topbar"><button className="icon-button hamburger" aria-label="Open menu" onClick={() => setMobileMenuOpen(true)}><Menu size={20} /></button><div className="breadcrumb">Workspace <span>/</span> <strong>{section === 'overview' ? 'Overview' : section === 'history' ? 'History' : section === 'interviews' ? 'My interviews' : section[0]!.toUpperCase() + section.slice(1)}</strong></div><div className="topbar-right"><label className="search-box"><Search size={16} /><input placeholder="Search interviews" aria-label="Search interviews" value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌘ K</kbd></label><button className="icon-button notification-button" title="Notifications" onClick={() => setNotificationsOpen((open) => !open)}><Bell size={18} />{notifications > 0 && <i />}</button><div className="top-avatar">{initials(user.name)}</div></div>{notificationsOpen && <div className="notification-popover"><div className="popover-heading"><strong>Notifications</strong><button onClick={() => void markNotificationsRead()}>Mark all read</button></div>{notificationItems.length ? notificationItems.map((item) => <div className={`notification-item ${!item.readAt ? 'unread' : ''}`} key={item.id ?? item._id}><span className="notification-indicator" /><div><strong>{item.title}</strong><p>{item.message}</p><time>{new Date(item.createdAt).toLocaleString()}</time></div></div>) : <div className="notification-empty">You’re all caught up.</div>}<div className="email-preference"><label><span>Email updates</span><input type="checkbox" checked={emailNotifications} onChange={(event) => void updateEmailNotifications(event.target.checked)} /></label><small>Invites, changes and one-hour reminders</small></div></div>}</header>
      <div className="content-wrap">
        <div className="welcome-row"><div><div className="eyebrow"><span className="eyebrow-dot" /> {user.role === 'recruiter' ? 'RECRUITER WORKSPACE' : 'YOUR INTERVIEW SPACE'}</div><h1>{section === 'history' ? 'Past conversations' : section === 'interviews' ? 'Your interviews' : section === 'jobs' ? 'Job opportunities' : section === 'applications' ? 'Application tracker' : section === 'profile' ? 'Your profile' : `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${user.name.split(' ')[0]}.`}</h1><p>{section === 'history' ? 'Take a look back at the conversations that moved things forward.' : section === 'jobs' ? 'Manage openings and discover your next opportunity.' : section === 'applications' ? 'Follow each application through its journey.' : section === 'profile' ? 'Keep your professional details up to date.' : 'A little preparation goes a long way. You’ve got this.'}</p></div>{section === 'overview' && user.role !== 'candidate' && <button className="button button-primary" onClick={() => setShowSchedule(true)}><Plus size={17} /> Schedule interview</button>}</div>
        {section === 'jobs' && <JobsPage token={token} user={user} />}
        {section === 'chats' && <ConversationsPage token={token} user={user} />}
        {section === 'applications' && user.role !== 'interviewer' && <ApplicationsPage token={token} user={user} />}
        {section === 'profile' && <><ProfilePage token={token} user={user} />{user.role === 'candidate' && <ResumeUploadPanel token={token} />}</>}
        {section === 'overview' && user.role === 'recruiter' && <RecruiterDashboard token={token} />}
        {section === 'overview' && user.role !== 'recruiter' && <section className="stat-grid" aria-label="Interview statistics"><div className="stat-card stat-lilac"><div className="stat-icon"><CalendarDays size={19} /></div><span className="stat-label">UPCOMING</span><strong>{upcoming.length.toString().padStart(2, '0')}</strong><span className="stat-note">on your calendar</span><div className="stat-decoration">✳</div></div><div className="stat-card stat-mint"><div className="stat-icon"><Check size={19} /></div><span className="stat-label">COMPLETED</span><strong>{history.filter((item) => item.status === 'completed').length.toString().padStart(2, '0')}</strong><span className="stat-note">conversations so far</span><div className="stat-decoration">✳</div></div><div className="stat-card stat-peach"><div className="stat-icon"><Clock3 size={19} /></div><span className="stat-label">NEXT SESSION</span><strong className="next-time">{upcoming[0] ? prettyTime(upcoming[0].scheduledAt) : '—'}</strong><span className="stat-note">{upcoming[0] ? prettyDate(upcoming[0].scheduledAt) : 'nothing scheduled yet'}</span><div className="stat-decoration">✳</div></div></section>}
        {(section === 'overview' || section === 'interviews' || section === 'history') && <section className="interviews-section"><div className="section-heading"><div><div className="eyebrow">{section === 'history' ? 'YOUR JOURNEY' : 'ON THE HORIZON'}</div><h2>{section === 'history' ? 'Interview history' : 'Upcoming interviews'} <span className="heading-count">{visible.length}</span></h2></div><div className="section-actions"><button className="button button-light" onClick={() => visible[0] && void downloadCalendar(visible[0], token)} disabled={!visible.length}><ArrowDownLeft size={16} /> Calendar</button>{user.role !== 'candidate' && <button className="button button-outline" onClick={() => setShowSchedule(true)}><Plus size={16} /> New interview</button>}</div></div>
          {visible.length ? <div className="interview-list">{visible.map((item, index) => <InterviewCard key={item._id} item={item} user={user} onJoin={() => setActiveInterview(item)} onEdit={() => setScheduleInterview(item)} onCancel={() => void cancelInterview(item, token, setInterviews)} onFeedback={() => setFeedbackInterview(item)} onCalendar={() => void downloadCalendar(item, token)} featured={index === 0 && section !== 'history'} />)}</div> : <div className="empty-state"><div className="empty-art"><CalendarDays size={25} /></div><h3>{section === 'history' ? 'Your story starts here' : 'Your calendar is clear'}</h3><p>{section === 'history' ? 'Completed interviews will show up here.' : 'Make room for a great conversation by scheduling an interview.'}</p>{section !== 'history' && user.role === 'interviewer' && <button className="button button-primary" onClick={() => setShowSchedule(true)}><Plus size={16} /> Schedule your first interview</button>}</div>}
        </section>}
        <footer className="page-footer"><span>Made for the conversations that matter.</span><span><ShieldCheck size={14} /> Your space is private & secure</span></footer>
      </div>
    </main>
    {(showSchedule || scheduleInterview) && <ScheduleModal token={token} userRole={user.role} editing={scheduleInterview ?? undefined} onClose={() => { setShowSchedule(false); setScheduleInterview(null); }} onCreated={(item) => { setInterviews((items) => [...items.filter((existing) => existing._id !== item._id), item].sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt))); setSection('interviews'); setShowSchedule(false); setScheduleInterview(null); }} />}
    {feedbackInterview && (user.role === 'interviewer' ? <EvaluationModal interview={feedbackInterview} token={token} onClose={() => setFeedbackInterview(null)} /> : <CandidateEvaluationModal interview={feedbackInterview} token={token} onClose={() => setFeedbackInterview(null)} />)}
    {notice && <div className="toast"><Bell size={17} />{notice}<button className="icon-button" onClick={() => setNotice('')}><X size={15} /></button></div>}
  </div>;
}

function AuthScreen({ mode, onModeChange, onSuccess, initialMessage = '' }: { mode: AuthMode; onModeChange: (mode: AuthMode) => void; onSuccess: (token: string, user: User) => void; initialMessage?: string }) {
  const [error, setError] = useState('');
  const [info, setInfo] = useState(initialMessage);
  const [developmentUrl, setDevelopmentUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<Role>('candidate');
  const [email, setEmail] = useState(() => new URLSearchParams(window.location.search).get('email') ?? '');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    const body = Object.fromEntries(data.entries());
    try {
      if (mode === 'forgot') {
        const result = await api<{ message: string; developmentUrl?: string }>('/api/auth/forgot-password', undefined, { method: 'POST', body: JSON.stringify(body) });
        setInfo(result.message); setDevelopmentUrl(result.developmentUrl ?? ''); setError(''); return;
      }
      if (mode === 'reset') {
        const result = await api<{ message: string }>('/api/auth/reset-password', undefined, { method: 'POST', body: JSON.stringify({ ...body, token: new URLSearchParams(window.location.search).get('reset') }) });
        setInfo(result.message); onModeChange('login'); window.history.replaceState({}, '', window.location.pathname); return;
      }
      if (mode === 'register') {
        const result = await api<{ message: string; developmentUrl?: string }>('/api/auth/register', undefined, { method: 'POST', body: JSON.stringify(body) });
        setInfo(result.message); setDevelopmentUrl(result.developmentUrl ?? ''); setError(''); onModeChange('login'); return;
      }
      const result = await api<{ token: string; user: User }>('/api/auth/login', undefined, { method: 'POST', body: JSON.stringify(body) });
      onSuccess(result.token, result.user);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not sign in.'); }
    finally { setBusy(false); }
  }
  return <div className="auth-layout">
    <section className="auth-brand">
      <div className="brand"><div className="brand-mark"><Sparkles size={20} strokeWidth={2.5} /></div><span>interviewly</span></div>
      <div className="auth-hero">
        <div className="hero-tag"><span /> A BETTER WAY TO MEET</div>
        <h1>Make room for<br /><em>great conversations.</em></h1>
        <p>One calm, focused space for every interview. Show up as your best self — we’ll take care of the rest.</p>
        <div className="hero-illustration">
          <div className="illustration-sun" />
          <div className="illustration-window">
            <div className="window-bar"><i /><i /><i /></div>
            <div className="window-person"><span /><b /></div>
            <div className="window-sidebar"><span /><span /><span /></div>
            <div className="window-note"><MessageCircle size={14} /> You’ve got this!</div>
          </div>
          <div className="float-bubble bubble-one"><Video size={18} /></div>
          <div className="float-bubble bubble-two"><Sparkles size={16} /></div>
          <div className="hero-caption">A little less pressure. A lot more you.</div>
        </div>
      </div>
      <div className="auth-foot"><span>© 2025 Interviewly</span><span>Thoughtfully made for humans <span className="heart">♥</span></span></div>
    </section>
    <section className="auth-panel">
      <form className="auth-form" onSubmit={submit}>
        <div className="form-kicker">{mode === 'login' ? 'WELCOME BACK' : mode === 'register' ? 'WELCOME ABOARD' : mode === 'forgot' ? 'ACCOUNT RECOVERY' : 'CHOOSE A NEW PASSWORD'} <span>✳</span></div>
        <h2>{mode === 'login' ? 'Let’s pick up where you left off.' : mode === 'register' ? 'Your next great conversation starts here.' : mode === 'forgot' ? 'Let’s get you back in.' : 'Set a new password.'}</h2>
        <p className="auth-subtitle">{mode === 'login' ? 'Sign in to your Interviewly workspace.' : mode === 'register' ? 'Create your account to get started.' : mode === 'forgot' ? 'We’ll email a secure password reset link if an account matches.' : 'Use at least 8 characters for your new password.'}</p>
      {mode === 'register' && <label className="field-label">Full name<input name="name" required minLength={2} placeholder="Alex Morgan" autoComplete="name" /></label>}
      {mode !== 'reset' && <label className="field-label">Email address<input name="email" type="email" required placeholder="you@company.com" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
      {mode === 'login' && <label className="field-label">Password<input name="password" type="password" required placeholder="Enter your password" autoComplete="current-password" /></label>}
      {mode === 'register' && <label className="field-label">Password<input name="password" type="password" required minLength={8} placeholder="At least 8 characters" autoComplete="new-password" /></label>}
      {mode === 'reset' && <label className="field-label">New password<input name="password" type="password" required minLength={8} placeholder="At least 8 characters" autoComplete="new-password" /></label>}
      {mode === 'register' && <><label className="field-label">I’m joining as<select name="role" value={role} onChange={(event) => setRole(event.target.value as Role)}><option value="candidate">Candidate</option><option value="interviewer">Interviewer</option><option value="recruiter">Recruiter / Admin</option></select></label>{(role === 'interviewer' || role === 'recruiter') && <label className="field-label">Organization invitation code<input name="interviewerCode" placeholder="Required in production" autoComplete="off" /></label>}</>}
      {info && <div className="form-info">{info}{developmentUrl && <a className="development-link" href={developmentUrl}>{mode === 'forgot' ? 'Continue password reset' : 'Verify email address'}</a>}</div>}{error && <div className="form-error">{error}</div>}
      {mode === 'login' && <button type="button" className="forgot-link" onClick={() => { setInfo(''); setError(''); setDevelopmentUrl(''); onModeChange('forgot'); }}>Forgot password?</button>}
      {mode === 'login' && <button type="button" className="forgot-link" onClick={() => { if (!email) { setError('Enter your email address first.'); return; } void api<{ message: string; developmentUrl?: string }>('/api/auth/resend-verification', undefined, { method: 'POST', body: JSON.stringify({ email }) }).then((result) => { setInfo(result.message); setDevelopmentUrl(result.developmentUrl ?? ''); setError(''); }).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not resend the link.')); }}>Didn’t get the verification email? Resend it</button>}
      <button className="button button-primary auth-submit" disabled={busy}>{busy ? 'One moment…' : mode === 'login' ? 'Sign in to workspace' : mode === 'register' ? 'Create my account' : mode === 'forgot' ? 'Send reset link' : 'Update password'}<ArrowRight size={17} /></button>
      <div className="auth-switch">{mode === 'register' ? 'Already have an account?' : mode === 'login' ? 'New to Interviewly?' : 'Remembered your password?'} <button type="button" onClick={() => { setError(''); setInfo(''); onModeChange(mode === 'login' ? 'register' : 'login'); }}>{mode === 'login' ? 'Create an account' : mode === 'register' ? 'Sign in' : 'Back to sign in'}</button></div><div className="secure-note"><ShieldCheck size={15} /> Your information is always private</div>
      </form>
    </section>
  </div>;
}

function InterviewCard({ item, user, onJoin, onEdit, onCancel, onFeedback, onCalendar, featured }: { item: Interview; user: User; onJoin: () => void; onEdit: () => void; onCancel: () => void; onFeedback: () => void; onCalendar: () => void; featured: boolean }) {
  const other = user.role === 'interviewer' || user.role === 'recruiter' ? item.candidate : item.interviewer;
  const otherName = other?.name ?? item.candidateEmail ?? 'Candidate invitation pending';
  const isToday = new Date(item.scheduledAt).toDateString() === new Date().toDateString();
  return <article className={`interview-card ${featured ? 'featured' : ''}`}><div className="date-tile"><strong>{new Date(item.scheduledAt).getDate().toString().padStart(2, '0')}</strong><span>{new Date(item.scheduledAt).toLocaleDateString([], { month: 'short' }).toUpperCase()}</span></div><div className="interview-main"><div className="interview-title-row"><h3>{item.title}</h3><span className={`status-pill status-${item.status}`}>{!item.candidate && user.role !== 'candidate' ? 'Invite pending' : item.status === 'in-progress' ? 'Live now' : item.status}</span></div><div className="interview-meta"><span><Clock3 size={14} /> {prettyTime(item.scheduledAt)} · {item.durationMinutes ?? 45} min</span><span className="meta-divider">·</span><span className="person-meta"><span className="mini-avatar">{initials(otherName)}</span> {otherName}</span><span className="interview-type-label">{item.interviewType ?? 'technical'}</span>{user.role === 'recruiter' && <span>Interviewer: {item.interviewer.name}</span>}</div></div><div className="interview-card-actions"><span className="date-caption">{isToday ? 'Today' : prettyDate(item.scheduledAt)}</span>{(user.role === 'candidate' || user.role === 'interviewer') && (item.status === 'scheduled' || item.status === 'in-progress') ? <button className={`button ${featured ? 'button-primary' : 'button-outline'} join-button`} onClick={onJoin}><Video size={15} /> Join room</button> : null}{item.status === 'completed' && user.role !== 'recruiter' && <button className="button button-light join-button" onClick={onFeedback}>{user.role === 'interviewer' ? 'Evaluate' : 'View feedback'}</button>}{item.status !== 'cancelled' && <button className="icon-button more-button" aria-label="Add to calendar" title="Add to calendar" onClick={onCalendar}><CalendarDays size={16} /></button>}{(user.role === 'interviewer' || user.role === 'recruiter') && item.status === 'scheduled' && <><button className="icon-button more-button" aria-label="Reschedule interview" title="Reschedule" onClick={onEdit}><Clock3 size={16} /></button><button className="icon-button more-button" aria-label="Cancel interview" title="Cancel" onClick={onCancel}><X size={16} /></button></>}</div></article>;
}

function ScheduleModal({ token, userRole, editing, onClose, onCreated }: { token: string; userRole: Role; editing?: Interview; onClose: () => void; onCreated: (item: Interview) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    const date = String(data.get('date'));
    try {
      const payload = { title: data.get('title'), scheduledAt: new Date(date).toISOString(), durationMinutes: Number(data.get('durationMinutes')), interviewType: data.get('interviewType'), instructions: data.get('instructions') };
      const item = await api<Interview>(editing ? `/api/interviews/${editing._id}` : '/api/interviews', token, { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(editing ? payload : { ...payload, candidateEmail: data.get('candidateEmail'), ...(userRole === 'recruiter' ? { interviewerEmail: data.get('interviewerEmail') } : {}) }) });
      onCreated(item);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create this interview.'); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal-card"><div className="modal-top"><div className="modal-icon"><CalendarDays size={20} /></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div><div className="eyebrow">MAKE A LITTLE SPACE</div><h2>{editing ? 'Reschedule interview' : 'Schedule an interview'}</h2><p>{editing ? 'Choose a new time; both participants will be notified.' : 'Set up a room and invite a candidate to join you.'}</p><form onSubmit={submit}><label className="field-label">Interview title<input name="title" required minLength={3} maxLength={120} defaultValue={editing?.title} placeholder="e.g. Product designer — portfolio review" /></label>{!editing && <label className="field-label">Candidate email<input name="candidateEmail" required type="email" placeholder="candidate@email.com" /></label>}{!editing && userRole === 'recruiter' && <label className="field-label">Assign interviewer email<input name="interviewerEmail" required type="email" placeholder="interviewer@company.com" /></label>}<div className="form-two-cols"><label className="field-label">Interview type<select name="interviewType" defaultValue={editing?.interviewType ?? 'technical'}><option value="technical">Technical</option><option value="behavioral">Behavioral</option><option value="hr">HR</option><option value="other">Other</option></select></label><label className="field-label">Duration<select name="durationMinutes" defaultValue={editing?.durationMinutes ?? 45}>{[15, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}</select></label></div><label className="field-label">Date & time<input name="date" type="datetime-local" required min={new Date().toISOString().slice(0, 16)} defaultValue={editing ? new Date(new Date(editing.scheduledAt).getTime() - new Date(editing.scheduledAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : undefined} /></label><label className="field-label">Candidate instructions<textarea name="instructions" maxLength={2000} rows={3} defaultValue={editing?.instructions} placeholder="What should the candidate prepare? (optional)" /></label>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button button-light" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save new time' : 'Create interview'}<ArrowRight size={16} /></button></div></form></div></div>;
}

function CallRoom({ interview, token, user, onClose, onStatusChange }: { interview: Interview; token: string; user: User; onClose: () => void; onStatusChange: (id: string, status: Interview['status']) => void }) {
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const queuedCandidates = useRef<RTCIceCandidateInit[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [chatSearch, setChatSearch] = useState('');
  const [unreadChat, setUnreadChat] = useState(0);
  const [chatError, setChatError] = useState('');
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [speakerDevices, setSpeakerDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamera, setSelectedCamera] = useState('');
  const [selectedAudio, setSelectedAudio] = useState('');
  const [selectedSpeaker, setSelectedSpeaker] = useState('');
  const [connectionQuality, setConnectionQuality] = useState<'checking' | 'good' | 'fair' | 'poor'>('checking');
  const [showSettings, setShowSettings] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [typing, setTyping] = useState('');
  const [online, setOnline] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [mediaError, setMediaError] = useState('');
  const [connected, setConnected] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const videoGrid = useRef<HTMLDivElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const chatOpenRef = useRef(true);
  const recordingCanvas = useRef<HTMLCanvasElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunks = useRef<Blob[]>([]);
  const captureTracks = useRef<MediaStream[]>([]);
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [recordingAllowed, setRecordingAllowed] = useState(false);
  const [recording, setRecording] = useState(false);
  const other = user.role === 'interviewer' ? interview.candidate : interview.interviewer;
  const otherName = other?.name ?? interview.candidateEmail ?? 'Candidate';
  const otherId = other?._id ?? other?.id ?? '';
  useEffect(() => { chatOpenRef.current = chatOpen; }, [chatOpen]);

  useEffect(() => {
    let disposed = false;
    const socket = io(API, { auth: { token } });
    socketRef.current = socket;
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peerRef.current = peer;
    peer.ontrack = (event) => { if (remoteVideo.current) remoteVideo.current.srcObject = event.streams[0]; setConnected(true); };
    peer.onicecandidate = (event) => { if (event.candidate) socket.emit('webrtc:ice', { roomCode: interview.roomCode, payload: event.candidate.toJSON() }); };
    peer.onconnectionstatechange = () => {
      setConnected(peer.connectionState === 'connected');
      if (peer.connectionState === 'failed') {
        try { peer.restartIce(); }
        catch { setConnectionQuality('poor'); }
      }
    };

    const startMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (disposed) { stream.getTracks().forEach((track) => track.stop()); return; }
        localStream.current = stream;
        if (localVideo.current) localVideo.current.srcObject = stream;
        stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      } catch { setMediaError('Camera or microphone access is unavailable. You can still join the room and chat.'); }
    };
    socket.on('connect', () => {
      void (async () => {
        const iceConfiguration = await api<{ iceServers: RTCIceServer[] }>('/api/rtc/ice-servers', token).catch(() => null);
        if (iceConfiguration?.iceServers.length && !disposed) peer.setConfiguration({ iceServers: iceConfiguration.iceServers });
        if (!localStream.current) await startMedia();
        if (disposed) return;
        socket.emit('room:join', interview.roomCode, (result: { ok: boolean; message?: string }) => { if (result.ok) onStatusChange(interview._id, 'in-progress'); else setMediaError(result.message ?? 'You cannot join this room.'); });
      })();
    });
    socket.on('room:peer-joined', async () => {
      if (peer.signalingState !== 'stable') return;
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      socket.emit('webrtc:offer', { roomCode: interview.roomCode, payload: offer });
    });
    socket.on('webrtc:offer', async ({ payload }: { payload: RTCSessionDescriptionInit }) => {
      if (peer.signalingState !== 'stable') return;
      await peer.setRemoteDescription(payload);
      for (const candidate of queuedCandidates.current.splice(0)) await peer.addIceCandidate(candidate);
      const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
      socket.emit('webrtc:answer', { roomCode: interview.roomCode, payload: answer });
    });
    socket.on('webrtc:answer', async ({ payload }: { payload: RTCSessionDescriptionInit }) => {
      if (peer.signalingState === 'have-local-offer') {
        await peer.setRemoteDescription(payload);
        for (const candidate of queuedCandidates.current.splice(0)) await peer.addIceCandidate(candidate);
      }
    });
    socket.on('webrtc:ice', async ({ payload }: { payload: RTCIceCandidateInit }) => {
      if (peer.remoteDescription) await peer.addIceCandidate(payload);
      else queuedCandidates.current.push(payload);
    });
    socket.on('chat:message', (message: ChatMessage) => {
      setMessages((items) => [...items, message]);
      if (message.senderId !== user.id) { setUnreadChat((count) => chatOpenRef.current ? count : count + 1); if (chatOpenRef.current) socket.emit('chat:read', { roomCode: interview.roomCode }); }
    });
    socket.on('chat:updated', (message: ChatMessage) => setMessages((items) => items.map((item) => item.id === message.id ? message : item)));
    socket.on('chat:read', ({ messageIds, readAt }: { messageIds: string[]; readAt: string }) => {
      const readIds = new Set(messageIds);
      setMessages((items) => items.map((message) => readIds.has(message.id) ? { ...message, deliveredAt: message.deliveredAt ?? readAt, readAt } : message));
    });
    socket.on('chat:typing', ({ name, isTyping }: { name: string; isTyping: boolean }) => setTyping(isTyping ? `${name} is typing…` : ''));
    socket.on('presence:update', ({ userId, online: isOnline }: { userId: string; online: boolean }) => { if (userId === otherId) setOnline(isOnline); });
    socket.on('call:recording-consent', ({ allowed }: { allowed: boolean }) => setRecordingAllowed(allowed));
    void api<ChatMessage[]>(`/api/interviews/${interview.roomCode}/messages`, token).then(setMessages).catch(() => undefined);
    return () => {
      disposed = true; socket.disconnect(); peer.close(); localStream.current?.getTracks().forEach((track) => track.stop());
      screenStream.current?.getTracks().forEach((track) => track.stop());
      for (const capture of captureTracks.current) capture.getTracks().forEach((track) => track.stop());
    };
  }, [interview.roomCode, interview._id, otherId, token, onStatusChange]);

  useEffect(() => {
    if (!chatOpen) return;
    setUnreadChat(0);
    socketRef.current?.emit('chat:read', { roomCode: interview.roomCode });
  }, [chatOpen, interview.roomCode]);

  useEffect(() => {
    if (!showSettings) return;
    void navigator.mediaDevices.enumerateDevices().then((devices) => {
      setCameraDevices(devices.filter((device) => device.kind === 'videoinput'));
      setAudioDevices(devices.filter((device) => device.kind === 'audioinput'));
      setSpeakerDevices(devices.filter((device) => device.kind === 'audiooutput'));
    }).catch(() => undefined);
  }, [showSettings]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void peerRef.current?.getStats().then((stats) => {
        let rtt: number | undefined;
        stats.forEach((report) => { if (report.type === 'candidate-pair' && report.state === 'succeeded' && typeof report.currentRoundTripTime === 'number') rtt = report.currentRoundTripTime; });
        if (rtt !== undefined) setConnectionQuality(rtt < 0.15 ? 'good' : rtt < 0.35 ? 'fair' : 'poor');
      }).catch(() => setConnectionQuality('checking'));
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  function sendMessage(event: { preventDefault: () => void }) {
    event.preventDefault(); if (!draft.trim()) return;
    if (editingMessage) socketRef.current?.emit('chat:edit', { messageId: editingMessage.id, text: draft });
    else socketRef.current?.emit('chat:send', { roomCode: interview.roomCode, text: draft, replyTo: replyingTo?.id });
    setDraft(''); setReplyingTo(null); setEditingMessage(null); socketRef.current?.emit('chat:typing', { roomCode: interview.roomCode, isTyping: false });
  }
  const sendAttachment = async (file?: File) => {
    if (!file) return;
    const form = new FormData(); form.append('file', file);
    try {
      const uploadResponse = await fetch(`${API}/api/interviews/${interview.roomCode}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      const upload = await uploadResponse.json();
      if (!uploadResponse.ok) throw new Error(upload.message ?? 'Could not upload this file.');
      socketRef.current?.emit('chat:send', { roomCode: interview.roomCode, text: '', attachmentKey: upload.storageKey });
    } catch (error) { setChatError(error instanceof Error ? error.message : 'Could not upload this file.'); }
  };
  const downloadAttachment = async (message: ChatMessage) => {
    if (!message.attachment) return;
    try {
      const response = await fetch(`${API}${message.attachment.url}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('Attachment unavailable.');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = message.attachment.name; anchor.click(); URL.revokeObjectURL(url);
    } catch (error) { setChatError(error instanceof Error ? error.message : 'Could not download attachment.'); }
  };
  const reactToMessage = (message: ChatMessage, emoji: string) => socketRef.current?.emit('chat:reaction', { messageId: message.id, emoji });
  const deleteMessage = (message: ChatMessage) => { if (window.confirm('Delete this message for everyone in the room?')) socketRef.current?.emit('chat:delete', { messageId: message.id }); };
  const editMessage = (message: ChatMessage) => { setEditingMessage(message); setReplyingTo(null); setDraft(message.text); };
  const replyMessage = (message: ChatMessage) => { setReplyingTo(message); setEditingMessage(null); setDraft(''); };
  const changeDevice = async (kind: 'video' | 'audio', deviceId: string) => {
    const current = localStream.current;
    if (!current || !deviceId) return;
    try {
      const replacement = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: { deviceId: { exact: deviceId } }, audio: false } : { video: false, audio: { deviceId: { exact: deviceId } } });
      const track = kind === 'video' ? replacement.getVideoTracks()[0] : replacement.getAudioTracks()[0];
      const previous = kind === 'video' ? current.getVideoTracks() : current.getAudioTracks();
      for (const oldTrack of previous) { current.removeTrack(oldTrack); oldTrack.stop(); }
      if (track) {
        current.addTrack(track);
        const sender = peerRef.current?.getSenders().find((item) => item.track?.kind === kind);
        await sender?.replaceTrack(track);
        if (kind === 'video' && localVideo.current) localVideo.current.srcObject = current;
      }
      (kind === 'video' ? setSelectedCamera : setSelectedAudio)(deviceId);
    } catch { setMediaError(`Could not switch ${kind === 'video' ? 'camera' : 'microphone'}.`); }
  };
  const changeSpeaker = async (deviceId: string) => {
    const remote = remoteVideo.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!remote?.setSinkId) { setMediaError('Speaker selection is not supported by this browser.'); return; }
    try { await remote.setSinkId(deviceId); setSelectedSpeaker(deviceId); }
    catch { setMediaError('Could not switch speaker output.'); }
  };
  const togglePictureInPicture = async () => {
    const video = remoteVideo.current;
    if (!video) return;
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); }
    catch { setMediaError('Picture-in-picture is not supported by this browser.'); }
  };
  const toggleReconnect = async () => {
    const peer = peerRef.current;
    if (!peer || peer.connectionState !== 'failed') return;
    try { await peer.restartIce(); const offer = await peer.createOffer({ iceRestart: true }); await peer.setLocalDescription(offer); socketRef.current?.emit('webrtc:offer', { roomCode: interview.roomCode, payload: offer }); }
    catch { setMediaError('Could not restart the video connection. Please rejoin.'); }
  };
  const toggleRecordingConsent = () => {
    const next = !recordingConsent; setRecordingConsent(next);
    socketRef.current?.emit('call:recording-consent', { roomCode: interview.roomCode, consent: next });
  };
  const startLocalRecording = async () => {
    if (!recordingAllowed || !recordingCanvas.current || !localVideo.current) return;
    try {
      const canvas = recordingCanvas.current; canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas recording unavailable.');
      let animation = 0;
      const draw = () => {
        context.fillStyle = '#171526'; context.fillRect(0, 0, canvas.width, canvas.height);
        const local = localVideo.current; const remote = remoteVideo.current;
        if (remote?.videoWidth) context.drawImage(remote, 0, 0, 840, 720);
        if (local?.videoWidth) context.drawImage(local, 850, 35, 400, 280);
        animation = requestAnimationFrame(draw);
      };
      draw();
      const videoCapture = canvas.captureStream(15); captureTracks.current.push(videoCapture);
      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      for (const stream of [localStream.current, remoteVideo.current?.srcObject as MediaStream | null]) {
        if (!stream?.getAudioTracks().length) continue;
        const source = audioContext.createMediaStreamSource(stream); source.connect(destination);
      }
      const combined = new MediaStream([...videoCapture.getVideoTracks(), ...destination.stream.getAudioTracks()]);
      captureTracks.current.push(destination.stream);
      const recorder = new MediaRecorder(combined, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm' });
      recorderRef.current = recorder; recordingChunks.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunks.current.push(event.data); };
      recorder.onstop = () => {
        cancelAnimationFrame(animation); void audioContext.close();
        const blob = new Blob(recordingChunks.current, { type: recorder.mimeType });
        const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `interview-${interview.roomCode}.webm`; anchor.click(); URL.revokeObjectURL(url);
        setRecording(false); recorderRef.current = null;
      };
      recorder.start(1000); setRecording(true);
    } catch (error) { setMediaError(error instanceof Error ? error.message : 'Local recording could not start.'); }
  };
  const stopLocalRecording = () => recorderRef.current?.stop();
  const toggleMic = () => { const next = !micOn; setMicOn(next); localStream.current?.getAudioTracks().forEach((track) => { track.enabled = next; }); };
  const toggleCamera = () => { const next = !cameraOn; setCameraOn(next); localStream.current?.getVideoTracks().forEach((track) => { track.enabled = next; }); };
  const toggleScreenShare = async () => {
    if (screenStream.current) {
      screenStream.current.getTracks().forEach((track) => track.stop());
      screenStream.current = null;
      const cameraTrack = localStream.current?.getVideoTracks()[0];
      await peerRef.current?.getSenders().find((sender) => sender.track?.kind === 'video')?.replaceTrack(cameraTrack ?? null);
      if (localVideo.current && localStream.current) localVideo.current.srcObject = localStream.current;
      setSharingScreen(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      screenStream.current = stream;
      await peerRef.current?.getSenders().find((sender) => sender.track?.kind === 'video')?.replaceTrack(track);
      if (localVideo.current) localVideo.current.srcObject = stream;
      setSharingScreen(true);
      track.onended = () => { void toggleScreenShare(); };
    } catch { setMediaError('Screen sharing was cancelled or is not available in this browser.'); }
  };
  const toggleFullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void videoGrid.current?.requestFullscreen(); };
  const copyRoom = async () => { await navigator.clipboard.writeText(interview.roomCode); setCopied(true); window.setTimeout(() => setCopied(false), 1800); };
  const elapsedLabel = `${Math.floor(elapsedSeconds / 60).toString().padStart(2, '0')}:${(elapsedSeconds % 60).toString().padStart(2, '0')}`;

  return <div className="call-layout"><header className="call-header"><button className="call-back" onClick={onClose}><ArrowLeft size={18} /><span>Back to workspace</span></button><div className="call-title"><span className="live-dot" />{interview.title}<span className="call-divider">·</span><span className="call-room-label">Room {interview.roomCode}</span><button className="copy-room" onClick={() => void copyRoom()} title="Copy room code">{copied ? <Check size={14} /> : <Copy size={14} />}</button></div><div className="call-secure"><ShieldCheck size={15} /> Private room</div></header>
    <main className="call-body"><div className="video-column"><div className="video-topline"><div><div className="eyebrow">FACE TO FACE</div><h1>Good conversations start here.</h1>{interview.instructions && user.role === 'candidate' && <p className="call-instructions">{interview.instructions}</p>}</div><div className="call-duration"><span className="live-dot" />{elapsedLabel} / {interview.durationMinutes ?? 45}:00<span className="call-duration-divider">·</span>{connected ? 'Connected' : 'Waiting for ' + otherName.split(' ')[0]}{connected && <><span className="call-duration-divider">·</span>{connectionQuality} connection</>}</div></div>
      {mediaError && <div className="media-warning">{mediaError}</div>}
      {chatError && <div className="media-warning">{chatError}</div>}
      <div className="video-grid" ref={videoGrid}><div className="video-tile remote-tile"><video ref={remoteVideo} autoPlay playsInline /><div className="video-empty"><div className="avatar avatar-large">{initials(otherName)}</div><strong>{otherName}</strong><span>{connected ? 'Connecting video…' : 'They’ll appear when they join'}</span></div><div className="video-name-tag"><span className={`presence-dot ${online ? 'online' : ''}`} />{otherName}{!online && <small> · offline</small>}</div><div className="video-status"><span className="sound-bars"><i /><i /><i /><i /></span></div></div><div className="video-tile self-tile"><video ref={localVideo} autoPlay muted playsInline /><div className="video-empty"><div className="avatar avatar-large">{initials(user.name)}</div><strong>{user.name} (you)</strong><span>Camera preview</span></div><div className="video-name-tag">{sharingScreen ? 'Your screen' : `${user.name} (you)`}</div>{!micOn && <div className="muted-badge"><MicOff size={13} /> Muted</div>}</div></div>
      <div className="call-controls"><div className="control-left"><span className="encrypted-note"><ShieldCheck size={14} /> Participant-only room</span></div><div className="control-center"><button onClick={toggleMic} className={`control-button ${!micOn ? 'control-off' : ''}`} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}>{micOn ? <Mic size={19} /> : <MicOff size={19} />}<span>{micOn ? 'Mute' : 'Unmute'}</span></button><button onClick={toggleCamera} className={`control-button ${!cameraOn ? 'control-off' : ''}`} aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}>{cameraOn ? <Video size={19} /> : <VideoOff size={19} />}<span>{cameraOn ? 'Camera' : 'Camera off'}</span></button><button className={`control-button ${sharingScreen ? 'control-active' : ''}`} onClick={() => void toggleScreenShare()} aria-label={sharingScreen ? 'Stop sharing screen' : 'Share screen'}><ScreenShare size={19} /><span>{sharingScreen ? 'Stop share' : 'Share screen'}</span></button><button className={`control-button ${chatOpen ? 'control-active' : ''}`} onClick={() => setChatOpen((open) => !open)} aria-label="Toggle chat"><MessageCircle size={19} />{unreadChat > 0 && <i className="chat-unread-dot" /> }<span>Chat</span></button><button className="control-button" onClick={togglePictureInPicture} title="Picture in picture"><Maximize2 size={19} /><span>PiP</span></button><button className="control-button" onClick={toggleFullscreen} title="Toggle video fullscreen"><Maximize2 size={19} /><span>Fullscreen</span></button><button className="control-button" onClick={() => setShowSettings((shown) => !shown)} title="Call settings"><Settings2 size={19} /><span>Devices</span></button>{peerRef.current?.connectionState === 'failed' && <button className="control-button control-off" onClick={() => void toggleReconnect()} title="Reconnect call">Reconnect</button>}</div><div className="control-right"><button className="button button-end" onClick={() => { onStatusChange(interview._id, 'completed'); onClose(); }}><span>✕</span> Leave</button></div></div>
      {showSettings && <div className="device-settings"><label>Camera<select value={selectedCamera} onChange={(event) => void changeDevice('video', event.target.value)}>{cameraDevices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></label><label>Microphone<select value={selectedAudio} onChange={(event) => void changeDevice('audio', event.target.value)}>{audioDevices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></label>{speakerDevices.length > 0 && <label>Speaker<select value={selectedSpeaker} onChange={(event) => void changeSpeaker(event.target.value)}>{speakerDevices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index + 1}`}</option>)}</select></label>}<button className="button button-light" onClick={toggleRecordingConsent}>{recordingConsent ? 'Withdraw recording consent' : 'Consent to local recording'}</button>{recordingAllowed && <button className="button button-primary" onClick={recording ? stopLocalRecording : () => void startLocalRecording()}>{recording ? 'Stop & download recording' : 'Start local recording'}</button>}<span className="recording-note">Both participants must consent. The recording is saved only on this device.</span></div>}
      <canvas ref={recordingCanvas} className="recording-canvas" aria-hidden="true" />
      <div className="room-tip"><input ref={attachmentInput} type="file" hidden accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain" onChange={(event) => { void sendAttachment(event.target.files?.[0]); event.target.value = ''; }} /><button className="call-attach" onClick={() => attachmentInput.current?.click()} title="Attach image, PDF or text file"><Paperclip size={14} /> Attach</button><button className="call-attach" onClick={() => setShowCode((shown) => !shown)}><Code2 size={14} /> {showCode ? 'Hide code' : 'Code round'}</button><Sparkles size={15} /><span>Take a breath. You’re in the right place.</span><span className="tip-dot">✳</span></div>
      {showCode && <CollaborativeEditor token={token} roomCode={interview.roomCode} />}
    </div>
    {chatOpen && <aside className="chat-panel"><div className="chat-header"><div><h2>Conversation</h2><button className="chat-find-button" type="button" onClick={() => { const query = window.prompt('Search messages in this room', chatSearch); if (query !== null) setChatSearch(query); }}><Search size={13} /> Search</button><span><span className="presence-dot online" /> Messages stay in this room</span></div><button className="icon-button" onClick={() => setChatOpen(false)} aria-label="Close chat"><X size={18} /></button></div><div className="chat-date"><span />TODAY<span /></div><div className="messages-list">{messages.filter((message) => !chatSearch || message.text.toLowerCase().includes(chatSearch.toLowerCase()) || message.attachment?.name.toLowerCase().includes(chatSearch.toLowerCase())).map((message) => <ChatMessageBubble key={message.id} message={message} own={message.senderId === user.id} onReply={() => replyMessage(message)} onEdit={() => editMessage(message)} onDelete={() => deleteMessage(message)} onReact={(emoji) => reactToMessage(message, emoji)} onDownload={() => void downloadAttachment(message)} />)}{typing && <div className="typing-label">{typing}</div>}{messages.length === 0 && <div className="chat-empty"><div className="chat-empty-icon"><MessageCircle size={20} /></div><strong>Say hello</strong><span>Your conversation is just between you two.</span></div>}</div><form className="chat-compose" onSubmit={sendMessage}><textarea value={draft} onChange={(event) => { setDraft(event.target.value); socketRef.current?.emit('chat:typing', { roomCode: interview.roomCode, isTyping: Boolean(event.target.value) }); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(event); } }} placeholder="Write a message…" rows={2} /><div className="compose-footer"><span>Press <kbd>Enter</kbd> to send</span><input ref={attachmentInput} type="file" hidden accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain" onChange={(event) => { void sendAttachment(event.target.files?.[0]); event.target.value = ''; }} /><button type="button" aria-label="Attach file" title="Attach image, PDF or text file" onClick={() => attachmentInput.current?.click()}><Paperclip size={15} /></button>
        </div></form><div className="chat-search-results">Search active: {chatSearch}</div>{chatError && <div className="form-error chat-error">{chatError}</div>}
        {(replyingTo || editingMessage) && <div className="chat-context-banner"><span>{editingMessage ? 'Editing message' : `Replying to ${replyingTo?.senderName}`}</span><button type="button" onClick={() => { setReplyingTo(null); setEditingMessage(null); setDraft(''); }}>Cancel</button></div>}
        <div className="chat-privacy"><ShieldCheck size={13} /> Private interview chat</div></aside>}
    </main></div>;
}

function ChatMessageBubble({ message, own, onReply, onEdit, onDelete, onReact, onDownload }: { message: ChatMessage; own: boolean; onReply: () => void; onEdit: () => void; onDelete: () => void; onReact: (emoji: string) => void; onDownload: () => void }) {
  return <div className={`message-row ${own ? 'own-message' : ''}`}>
    <div className="message-avatar">{initials(message.senderName)}</div>
    <div className="message-content">
      <div className="message-meta"><strong>{own ? 'You' : message.senderName}</strong><time>{prettyTime(message.createdAt)}{message.editedAt ? ' · edited' : ''}</time></div>
      {message.replyTo && <div className="message-reply-preview">↪ {message.replyTo.senderName}: {message.replyTo.text}</div>}
      {message.deleted ? <div className="message-bubble deleted-message">This message was deleted</div> : <>
        {message.text && <div className="message-bubble">{message.text}</div>}
        {message.attachment && <button type="button" className="message-attachment" onClick={onDownload}><Paperclip size={14} />{message.attachment.name}<small>{Math.ceil(message.attachment.size / 1024)} KB</small></button>}
        {!!message.reactions?.length && <div className="reaction-list">{message.reactions.map((reaction, index) => <button type="button" key={`${reaction.userId}-${reaction.emoji}-${index}`} onClick={() => onReact(reaction.emoji)}>{reaction.emoji}</button>)}</div>}
        <div className="message-actions"><button type="button" onClick={onReply} title="Reply">↩</button><button type="button" onClick={() => onReact('👍')} title="React with thumbs up">👍</button><button type="button" onClick={() => onReact('❤️')} title="React with heart">❤️</button>{own && <><button type="button" onClick={onEdit} title="Edit message">Edit</button><button type="button" onClick={onDelete} title="Delete message">Delete</button></>}</div>
      </>}
      {own && !message.deleted && <span className={`message-receipt ${message.readAt ? 'receipt-read' : ''}`} title={message.readAt ? 'Read' : message.deliveredAt ? 'Delivered' : 'Sent'}>{message.readAt ? '✓✓' : message.deliveredAt ? '✓' : '·'}</span>}
    </div>
  </div>;
}
