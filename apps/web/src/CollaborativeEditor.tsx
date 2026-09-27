import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { io } from 'socket.io-client';
import { Code2 } from 'lucide-react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
type Language = 'javascript' | 'typescript' | 'python' | 'java' | 'cpp';
const monacoLanguage: Record<Language, string> = { javascript: 'javascript', typescript: 'typescript', python: 'python', java: 'java', cpp: 'cpp' };

export function CollaborativeEditor({ token, roomCode }: { token: string; roomCode: string }) {
  const [source, setSource] = useState('// Work through the problem together.\n');
  const [language, setLanguage] = useState<Language>('javascript');
  const [status, setStatus] = useState('Connecting editor…');
  const [peerEditing, setPeerEditing] = useState(false);
  const [stdin, setStdin] = useState('');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [runnerAvailable, setRunnerAvailable] = useState(true);
  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const ignoreRemoteChange = useRef(false);
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
    const socket = io(API, { auth: { token } }); socketRef.current = socket;
    socket.on('connect', () => socket.emit('code:join', roomCode, (result: { ok: boolean; message?: string; source?: string; language?: Language }) => {
      if (!result.ok) { setStatus(result.message ?? 'Could not join the shared editor.'); return; }
      ignoreRemoteChange.current = true;
      setSource(result.source ?? ''); setLanguage(result.language ?? 'javascript'); setStatus('Collaborating live');
    }));
    socket.on('code:change', ({ source: remoteSource, language: remoteLanguage, updatedBy }: { source: string; language: Language; updatedBy: string }) => {
      ignoreRemoteChange.current = true; setSource(remoteSource); setLanguage(remoteLanguage); setPeerEditing(true);
      window.setTimeout(() => setPeerEditing(false), 1800);
      if (updatedBy === '') setPeerEditing(false);
    });
    socket.on('disconnect', () => setStatus('Reconnecting…'));
    return () => { socket.disconnect(); if (debounce.current) window.clearTimeout(debounce.current); };
  }, [roomCode, token]);

  const update = (nextSource: string | undefined) => {
    if (nextSource === undefined) return;
    setSource(nextSource);
    if (ignoreRemoteChange.current) { ignoreRemoteChange.current = false; return; }
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => socketRef.current?.emit('code:update', { roomCode, source: nextSource, language }), 250);
  };
  const updateLanguage = (next: Language) => { setLanguage(next); socketRef.current?.emit('code:update', { roomCode, source, language: next }); };
  const runCode = async () => {
    if (language === 'typescript') { setOutput('The configured runner supports JavaScript, Python, Java and C++; choose JavaScript to run JS code.'); return; }
    setRunning(true); setOutput('Running in the configured isolated code runner…');
    try {
      const response = await fetch(`${API}/api/interviews/${roomCode}/code/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ language, source, stdin }) });
      const result = await response.json();
      if (response.status === 503) setRunnerAvailable(false);
      if (!response.ok) throw new Error(result.message ?? 'Code runner unavailable.');
      setRunnerAvailable(true);
      setOutput([result.status, result.stdout, result.stderr, result.compileOutput, result.message].filter(Boolean).join('\n'));
    } catch (error) { setOutput(error instanceof Error ? error.message : 'Could not execute code.'); }
    finally { setRunning(false); }
  };

  return <section className="collab-editor"><header><div><Code2 size={15} /><strong>Collaborative code</strong><span className="editor-live"><i />{status}</span>{peerEditing && <small>Interviewer is editing</small>}</div><label>Language<select value={language} onChange={(event) => updateLanguage(event.target.value as Language)}>{Object.keys(monacoLanguage).map((item) => <option key={item} value={item}>{item}</option>)}</select></label></header><Editor height="260px" language={monacoLanguage[language]} value={source} onChange={update} theme="vs-dark" options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2 }} /><div className="code-run-controls"><label>Standard input (optional)<textarea value={stdin} onChange={(event) => setStdin(event.target.value)} rows={2} placeholder="Input sent to stdin" /></label><button className="button button-primary" disabled={running || !runnerAvailable} onClick={() => void runCode()}>{running ? 'Running…' : runnerAvailable ? 'Run code' : 'Runner not configured'}</button></div>{output && <pre className="code-output">{output}</pre>}<footer>Execution requires a separately configured Judge0-compatible isolated runner. Code never runs on the Interviewly API process.</footer></section>;
}
