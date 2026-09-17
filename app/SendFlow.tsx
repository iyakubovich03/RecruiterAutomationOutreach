"use client";
import { useEffect, useState } from 'react';
import { automaticRecipients } from './outreach.mjs';

export type Batch = { id: string; from: string; status: string; attachment?: string | null; rows: { id: string; to: string; name: string; subject: string; message: string; status: string; error?: string }[] };
export type Resume = { filename: string; type: string; size: number; savedAt: string };
type Contact = { id: string; name: string; company: string; selected: string | null; candidates: { email: string; evidence: string }[] };
type Props = {
  mode: 'default' | 'custom'; contactIds: string[]; contacts: Contact[]; history: { contactId: string | null; to: string; status: string }[];
  connected: boolean; account: string | null; template: { subject: string; message: string }; resume: Resume | null;
  post: (path: string, body?: unknown) => Promise<{ batch?: Batch }>; refresh: () => Promise<unknown>;
  onClose: () => void; onConnect: () => void; onResume: () => void; onSent: () => void;
};
const placeholders = ['{first_name}', '{full_name}', '{company}', '{email}'];

export default function SendFlow({ mode, contactIds, contacts, history, connected, account, template, resume, post, refresh, onClose, onConnect, onResume, onSent }: Props) {
  const [stage, setStage] = useState<'compose' | 'confirm'>(mode === 'custom' ? 'compose' : 'confirm');
  const [subject, setSubject] = useState(template.subject), [message, setMessage] = useState(template.message), [saveDefault, setSaveDefault] = useState(false);
  const [batch, setBatch] = useState<Batch | null>(null), [authorized, setAuthorized] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const recipients = automaticRecipients(contacts, contactIds, history) as { contact: Contact; email: string; skipped: string }[];
  const ready = recipients.filter(r => !r.skipped).slice(0, 8);

  useEffect(() => {
    if (stage !== 'confirm' || !connected || !resume || !ready.length || batch || busy) return;
    let active = true;
    (async () => {
      setBusy('prepare'); setError('');
      try {
        if (saveDefault) await post('template', { subject, message });
        const result = await post('batch/prepare', { recipients: ready.map(r => ({ id: r.contact.id, to: r.email })), subject, message, attachResume: true });
        if (active) setBatch(result.batch || null);
      } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Could not prepare the emails.'); }
      finally { if (active) setBusy(''); }
    })();
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, connected]);

  async function send() {
    if (!batch || !authorized || busy) return;
    setBusy('send'); setError('');
    try { const result = await post('batch/send', { batchId: batch.id, confirmed: true }); setBatch(result.batch || null); await refresh(); }
    catch (e) { setError((e instanceof Error ? e.message : 'Send status unavailable.') + ' Check Outreach history before trying again.'); setBatch(null); setAuthorized(false); await refresh().catch(() => {}); }
    finally { setBusy(''); }
  }
  const finished = batch && batch.status !== 'draft';
  const sentCount = batch?.rows.filter(r => r.status === 'sent').length || 0;
  const resumeLine = resume && <p className="hint">📎 {resume.filename} ({Math.round(resume.size / 1024)} KB) is attached to every recruiter email.</p>;

  return <div className="modal-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="send-title">
      {error && <div className="alert error" role="alert">{error}</div>}
      {!resume && <>
        <div className="eyebrow">RESUME REQUIRED</div>
        <h2 id="send-title">Upload your resume first</h2>
        <p className="hint">Every recruiter email goes out with your resume attached, and none is saved yet. Add it under Default email, then come back — your results stay here.</p>
        <div className="cta-row"><button className="secondary" onClick={onClose}>Not now</button><button className="primary" onClick={onResume}>Go to Default email →</button></div>
      </>}
      {resume && stage === 'compose' && <>
        <div className="eyebrow">YOUR MESSAGE</div>
        <h2 id="send-title">Write the email for {ready.length} recruiter{ready.length === 1 ? '' : 's'}</h2>
        <p className="hint">Placeholders are filled in per person: {placeholders.join(' · ')}</p>
        <label>Subject<input maxLength={200} value={subject} onChange={e => setSubject(e.target.value)} /></label>
        <label>Message<textarea rows={12} maxLength={20000} value={message} onChange={e => setMessage(e.target.value)} /></label>
        <label className="confirm"><input type="checkbox" checked={saveDefault} onChange={e => setSaveDefault(e.target.checked)} />Save this as my default email</label>
        {resumeLine}
        <div className="cta-row"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!subject.trim() || !message.trim()} onClick={() => setStage('confirm')}>Continue to review →</button></div>
      </>}
      {resume && stage === 'confirm' && <>
        <div className="eyebrow">{finished ? 'RESULT' : 'AUTHORIZE SENDING'}</div>
        <h2 id="send-title">{finished ? `${sentCount} of ${batch.rows.length} emails submitted to Gmail` : `Send ${ready.length} email${ready.length === 1 ? '' : 's'} from ${account || 'Gmail'}`}</h2>
        {!connected && <><p className="hint">Connect Gmail once, then come back — your results stay here.</p><div className="cta-row"><button className="secondary" onClick={onClose}>Not now</button><button className="primary" onClick={onConnect}>Connect Gmail ↗</button></div></>}
        {connected && !finished && <>
          <ul className="recipient-list">
            {recipients.map(r => <li key={r.contact.id + r.email} className={r.skipped ? 'skipped' : ''}><span><strong>{r.contact.name}</strong> · {r.contact.company}</span><span>{r.email || '—'}{r.skipped && <small> · {r.skipped}</small>}</span></li>)}
            {recipients.filter(r => !r.skipped).length > 8 && <li className="skipped"><small>Only the first eight addresses are sent in one batch.</small></li>}
          </ul>
          {!ready.length && <><p className="hint">Nobody left to email — everyone here was already contacted.</p><div className="cta-row"><button className="secondary" onClick={onClose}>Close</button></div></>}
          {ready.length > 0 && resumeLine}
          {ready.length > 0 && busy === 'prepare' && <p className="hint"><span className="spinner" /> Preparing personalized emails…</p>}
          {batch && <>
            <p className="hint">Each recruiter gets a separate email with {batch.attachment} attached. Expand any row to read exactly what will be sent.</p>
            {batch.rows.map((row, i) => <details className="history-item" key={row.id + row.to} open={i === 0}><summary><span><strong>{row.name}</strong><small>{row.to} · {row.subject} · 📎</small></span><span className="tag">Ready</span></summary><pre>{row.message}</pre></details>)}
            <label className="confirm" style={{ marginTop: 20 }}><input type="checkbox" checked={authorized} disabled={!!busy} onChange={e => setAuthorized(e.target.checked)} />I authorize sending these {batch.rows.length} emails with {batch.attachment} attached. The addresses are best guesses and are not verified.</label>
            <div className="cta-row"><button className="secondary" disabled={!!busy} onClick={onClose}>Cancel</button><button className="primary" disabled={!authorized || !!busy} onClick={send}>{busy === 'send' ? 'Sending…' : `Authorize & send ${batch.rows.length} email${batch.rows.length === 1 ? '' : 's'} ↗`}</button></div>
          </>}
        </>}
        {finished && <>
          <ul className="recipient-list">{batch.rows.map(row => <li key={row.id + row.to}><span><strong>{row.name}</strong></span><span>{row.to} · <span className={'status ' + row.status}>{row.status === 'sent' ? 'Submitted' : row.status === 'not_started' ? 'Not attempted' : row.status}</span>{row.error && <small> · {row.error}</small>}</span></li>)}</ul>
          <p className="hint">Gmail accepted these for sending with {batch.attachment} attached; delivery and mailbox ownership are not confirmed. Replies and bounces arrive in your Gmail inbox.</p>
          <div className="cta-row"><button className="primary" onClick={onSent}>Done</button></div>
        </>}
      </>}
    </section>
  </div>;
}
