import { useState } from 'react';
import { Paperclip } from 'lucide-react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

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
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Upload failed.');
      setMessage(`Uploaded ${result.name}. Recruiters can download it after you apply to one of their jobs.`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not upload résumé.'); }
    finally { setBusy(false); }
  }
  return <section className="resume-upload-panel"><div><div className="eyebrow">PRIVATE DOCUMENT</div><h3>Résumé</h3><p>PDF or DOCX, up to 10 MB. Recruiters see it only for applications to their jobs.</p></div><label className="button button-light"><Paperclip size={15} />{busy ? 'Uploading…' : 'Choose file'}<input type="file" hidden disabled={busy} accept="application/pdf,.pdf,.docx" onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ''; }} /></label>{message && <div className="form-info">{message}</div>}{error && <div className="form-error">{error}</div>}</section>;
}
