"use client";
import { useEffect, useState } from 'react';
import { automaticRecipients } from './outreach.mjs';

export type Batch = { id: string; from: string; status: string; attachment?: string | null; retryOf?: string; removed?: { id: string; name: string; to: string }[]; rows: { id: string; to: string; name: string; source?: string; subject: string; message: string; status: string; error?: string; edited?: boolean }[] };
type Draft = { subject: string; message: string };
export type Resume = { filename: string; type: string; size: number; savedAt: string };
export type RunPerson = { id: string; name: string; title: string; source?: string; attempts: { to: string; format: string; status: string; date: string; bounce: { at: string; subject: string } | null }[]; outcome: string };
export type Run = { id: string; company: string; domain: string; originalDomain: string; alternates: string[]; status: string; stage: string; mode: string; verifiedFormat: string | null; error: string | null; stoppedBy?: string | null; startedAt: string; finishedAt: string | null; attachment: string | null; watchSeconds: number; wave: { kind: string; secondsLeft: number; checks: number; contactIds: string[] } | null; people: RunPerson[]; summary: { reached: number; watching: number; retrying: number; exhausted: number; queued: number }; log: { at: string; status: string; detail: string }[] };
type Contact = { id: string; name: string; company: string; source?: string; selected: string | null; candidates: { email: string; evidence: string }[] };
// Every recruiter name links to the LinkedIn result it came from, so a quick check is one click away wherever the name appears.
export const personLink = (name: string, source?: string) => source ? <a className="person-link" href={source} target="_blank" rel="noreferrer" title="Open LinkedIn profile">{name} ↗</a> : <>{name}</>;
type Props = {
  mode: 'default' | 'custom'; contactIds: string[]; runId?: string | null; contacts: Contact[]; history: { contactId: string | null; to: string; status: string }[];
  connected: boolean; account: string | null; template: { subject: string; message: string }; resume: Resume | null; bounceDetection: boolean;
  post: (path: string, body?: unknown) => Promise<{ batch?: Batch; run?: Run }>; refresh: () => Promise<unknown>;
  onClose: () => void; onConnect: () => void; onResume: () => void; onSent: () => void;
};
const placeholders = ['{first_name}', '{full_name}', '{company}', '{email}'];
const outcomeLabel: Record<string, string> = { queued: 'Queued', watching: 'Sent · watching', reached: 'Reached', retrying: 'Bounced · retrying', exhausted: 'All addresses bounced', uncertain: 'Uncertain', failed: 'Failed', pending: 'Pending' };
const attemptLabel = (status: string) => status === 'sent' ? 'Submitted' : status === 'bounced' ? 'Bounced' : status;

export function runHeadline(run: Run) {
  if (run.status === 'complete') return `Done · ${run.summary.reached} reached${run.summary.exhausted ? ` · ${run.summary.exhausted} could not be reached` : ''}`;
  if (run.status !== 'running') return `${run.stoppedBy ? 'Stopped' : 'Paused'} · ${run.summary.reached} reached so far`;
  if (!run.wave) return 'Preparing the next step…';
  if (run.wave.kind === 'probe') { const person = run.people.find(p => run.wave!.contactIds.includes(p.id)); const attempt = person?.attempts.at(-1); return `Testing the “${attempt?.format || 'top'}” format on ${person?.name || 'the first recruiter'} (${attempt?.to || ''})`; }
  return `Emailing everyone at “${run.verifiedFormat}” · watching for bounces`;
}

export default function SendFlow({ mode, contactIds, runId = null, contacts, history, connected, account, template, resume, bounceDetection, post, refresh, onClose, onConnect, onResume, onSent }: Props) {
  const [stage, setStage] = useState<'compose' | 'confirm'>(mode === 'custom' ? 'compose' : 'confirm');
  const [subject, setSubject] = useState(template.subject), [message, setMessage] = useState(template.message), [saveDefault, setSaveDefault] = useState(false);
  const [batch, setBatch] = useState<Batch | null>(null), [authorized, setAuthorized] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  // Unsaved per-row edits, keyed by recipient. Authorizing is blocked until every edit is saved or discarded, so what is shown is what is sent.
  const [edits, setEdits] = useState<Record<string, Draft>>({});
  const unsaved = Object.keys(edits).length > 0;
  const recipients = automaticRecipients(contacts, contactIds, history) as { contact: Contact; email: string; skipped: string }[];
  const ready = recipients.filter(r => !r.skipped).slice(0, 8);

  useEffect(() => {
    if (!runId || run) return;
    let active = true;
    (async () => { try { const r = await fetch('/api/run?id=' + encodeURIComponent(runId)); const d = await r.json() as { run?: Run; error?: string }; if (!r.ok) throw new Error(d.error || 'Run not found.'); if (active) setRun(d.run || null); } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Could not load the run.'); } })();
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    if (stage !== 'confirm' || runId || !connected || !resume || !ready.length || batch || busy) return;
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

  // The run lives on the server; this just polls it while it is running.
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    let active = true;
    const timer = setInterval(async () => {
      try { const r = await fetch('/api/run?id=' + encodeURIComponent(run.id)); const d = await r.json() as { run?: Run }; if (active && d.run) { setRun(d.run); if (d.run.status !== 'running') await refresh(); } } catch { /* next poll retries */ }
    }, 3000);
    return () => { active = false; clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.status]);

  async function startRun(target: Batch) {
    setBusy('send'); setError('');
    try { const result = await post('run/start', { batchId: target.id, confirmed: true }); setRun(result.run || null); await refresh(); }
    catch (e) { setError((e instanceof Error ? e.message : 'The run could not start.') + ' Check Outreach history before trying again.'); setBatch(null); setAuthorized(false); await refresh().catch(() => {}); }
    finally { setBusy(''); }
  }
  async function resumeRun() {
    if (!run) return; setBusy('resume'); setError('');
    try { const result = await post('run/resume', { runId: run.id }); setRun(result.run || null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not resume.'); }
    finally { setBusy(''); }
  }
  // Stopping takes two clicks so a stray click never halts a run; once stopped, nothing more is sent until Resume.
  const [confirmStop, setConfirmStop] = useState(false);
  async function stopRun() {
    if (!run) return; setBusy('stop'); setError('');
    try { const result = await post('run/stop', { runId: run.id }); setRun(result.run || null); setConfirmStop(false); await refresh().catch(() => {}); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not stop.'); }
    finally { setBusy(''); }
  }
  const resumeLine = resume && <p className="hint">📎 {resume.filename} ({Math.round(resume.size / 1024)} KB) is attached to every recruiter email.</p>;
  async function saveRow(target: Batch, row: Batch['rows'][number], apply: (batch: Batch) => void) {
    const key = row.id + '|' + row.to, draft = edits[key]; if (!draft) return;
    setBusy('edit'); setError('');
    try {
      const result = await post('batch/update', { batchId: target.id, rows: [{ id: row.id, to: row.to, subject: draft.subject, message: draft.message }] });
      if (result.batch) apply(result.batch);
      setEdits(current => { const next = { ...current }; delete next[key]; return next; });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the edit.'); }
    finally { setBusy(''); }
  }
  // Every email can be rewritten in place before it is authorized; the app validates each edit like a generated one.
  // Dropping a person from the draft happens on the server so what is authorized is exactly what is shown.
  async function removeRow(target: Batch, row: Batch['rows'][number], apply: (batch: Batch) => void) {
    setBusy('remove'); setError('');
    try { const result = await post('batch/remove', { batchId: target.id, contactId: row.id }); if (result.batch) apply(result.batch); setEdits(current => { const rest = { ...current }; delete rest[row.id + '|' + row.to]; return rest; }); setAuthorized(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove.'); }
    finally { setBusy(''); }
  }
  const rowDetails = (target: Batch, attachment: string | null | undefined, apply: (batch: Batch) => void) => target.rows.map((row, i) => {
    const key = row.id + '|' + row.to, draft = edits[key] || { subject: row.subject, message: row.message }, dirty = !!edits[key];
    const change = (patch: Partial<Draft>) => setEdits(current => { const next = { ...current[key] || { subject: row.subject, message: row.message }, ...patch }; if (next.subject === row.subject && next.message === row.message) { const rest = { ...current }; delete rest[key]; return rest; } return { ...current, [key]: next }; });
    return <details className="history-item" key={key} open={i === 0 || row.edited}>
      <summary><span><strong>{personLink(row.name, row.source)}</strong><small>{row.to} · {row.subject}{attachment ? ' · 📎' : ''}</small></span>{target.rows.length > 1 && <button className="remove-person" title={`Leave ${row.name} out`} aria-label={`Remove ${row.name}`} disabled={!!busy} onClick={e => { e.preventDefault(); void removeRow(target, row, apply); }}>×</button>}<span className={'tag' + (dirty ? ' warn' : row.edited ? ' green' : '')}>{dirty ? 'Unsaved' : row.edited ? 'Edited' : 'Ready'}</span></summary>
      <label className="field">Subject<input maxLength={200} value={draft.subject} disabled={!!busy} onChange={e => change({ subject: e.target.value })} /></label>
      <label className="field">Message<textarea rows={10} maxLength={20000} value={draft.message} disabled={!!busy} onChange={e => change({ message: e.target.value })} /></label>
      {dirty && <div className="edit-row"><span className="hint">Save this email before authorizing the batch.</span><button className="secondary" disabled={!!busy} onClick={() => setEdits(current => { const rest = { ...current }; delete rest[key]; return rest; })}>Discard</button><button className="primary" disabled={!!busy} onClick={() => saveRow(target, row, apply)}>{busy === 'edit' ? 'Saving…' : 'Save changes'}</button></div>}
    </details>;
  });
  const probeName = batch?.rows[0]?.name;

  return <div className="modal-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="send-title">
      {error && <div className="alert error" role="alert">{error}</div>}
      {run && <>
        <div className="eyebrow">{run.status === 'running' ? 'VERIFIED SEND · IN PROGRESS' : run.status === 'complete' ? 'VERIFIED SEND · DONE' : run.stoppedBy ? 'VERIFIED SEND · STOPPED' : 'VERIFIED SEND · PAUSED'} · {run.company}</div>
        <h2 id="send-title">{runHeadline(run)}</h2>
        {run.status === 'running' && run.wave && <p className="hint"><span className="spinner" /> Watching the inbox — moves on the moment a bounce arrives, or after {run.wave.secondsLeft}s more if nothing comes back{run.wave.checks ? ` · checked ${run.wave.checks}×` : ''}. You can close this — the run keeps going on the server and shows on the Find page.</p>}
        {run.status === 'running' && run.mode === 'direct' && <div className="alert">Bounce detection is off, so this run sends to everyone at their top address without verifying. Reconnect Gmail once to enable verified runs.</div>}
        {run.error && <div className="alert error">{run.error}</div>}
        {run.verifiedFormat && <p className="hint ok">✓ The “{run.verifiedFormat}” format got through{run.domain !== run.originalDomain ? ` at ${run.domain} (switched from ${run.originalDomain})` : ''}; everyone else is emailed at that format.</p>}
        {!run.verifiedFormat && run.alternates.length > 0 && run.status === 'running' && <p className="hint">If every address at {run.domain} bounces, {run.alternates.join(' and ')} will be tried next.</p>}
        <ul className="recipient-list">{run.people.map(p => <li key={p.id}><span><strong>{personLink(p.name, p.source)}</strong>{p.title && <small> · {p.title}</small>}<br /><small>{p.attempts.length ? p.attempts.map((a, i) => <span key={a.to + i}>{i > 0 ? ' → ' : ''}{a.to} <span className={'status ' + a.status}>{attemptLabel(a.status)}</span></span>) : 'Waiting for the verified format'}</small></span><span className={'status ' + (p.outcome === 'reached' ? 'sent' : p.outcome === 'exhausted' ? 'bounced' : '')}>{outcomeLabel[p.outcome] || p.outcome}</span></li>)}</ul>
        <details className="pattern-detail"><summary>Activity ({run.log.length})</summary>{run.log.map((l, i) => <p key={i} className={l.status === 'error' ? 'diagnostic-error' : ''}>{new Date(l.at).toLocaleTimeString()} · {l.detail}</p>)}</details>
        <div className="cta-row">
          {run.status === 'running' && !confirmStop && <button className="secondary" onClick={onClose}>Run in background</button>}
          {run.status === 'running' && !confirmStop && <button className="secondary danger" disabled={!!busy} onClick={() => setConfirmStop(true)}>Stop sending</button>}
          {run.status === 'running' && confirmStop && <><button className="primary danger" disabled={!!busy} onClick={stopRun}>{busy === 'stop' ? 'Stopping…' : 'Yes, stop now — send nothing more'}</button><button className="secondary" disabled={!!busy} onClick={() => setConfirmStop(false)}>Keep going</button><span className="hint" style={{ margin: 0 }}>Emails already sent can’t be recalled. You can resume later.</span></>}
          {['stopped', 'interrupted'].includes(run.status) && <button className="primary" disabled={!!busy} onClick={resumeRun}>{busy === 'resume' ? 'Resuming…' : 'Resume run'}</button>}
          {run.status !== 'running' && <button className={run.status === 'complete' ? 'primary' : 'secondary'} onClick={onSent}>Done</button>}
        </div>
      </>}
      {!run && !runId && !resume && <>
        <div className="eyebrow">RESUME REQUIRED</div>
        <h2 id="send-title">Upload your resume first</h2>
        <p className="hint">Every recruiter email goes out with your resume attached, and none is saved yet. Add it under Default email, then come back — your results stay here.</p>
        <div className="cta-row"><button className="secondary" onClick={onClose}>Not now</button><button className="primary" onClick={onResume}>Go to Default email →</button></div>
      </>}
      {!run && !runId && resume && stage === 'compose' && <>
        <div className="eyebrow">YOUR MESSAGE</div>
        <h2 id="send-title">Write the email for {ready.length} recruiter{ready.length === 1 ? '' : 's'}</h2>
        <p className="hint">Placeholders are filled in per person: {placeholders.join(' · ')}</p>
        <label>Subject<input maxLength={200} value={subject} onChange={e => setSubject(e.target.value)} /></label>
        <label>Message<textarea rows={12} maxLength={20000} value={message} onChange={e => setMessage(e.target.value)} /></label>
        <label className="confirm"><input type="checkbox" checked={saveDefault} onChange={e => setSaveDefault(e.target.checked)} />Save this as my default email</label>
        {resumeLine}
        <div className="cta-row"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!subject.trim() || !message.trim()} onClick={() => setStage('confirm')}>Continue to review →</button></div>
      </>}
      {!run && !runId && resume && stage === 'confirm' && <>
        <div className="eyebrow">AUTHORIZE THE RUN</div>
        <h2 id="send-title">Email {ready.length} recruiter{ready.length === 1 ? '' : 's'} from {account || 'Gmail'}</h2>
        {!connected && <><p className="hint">Connect Gmail once, then come back — your results stay here.</p><div className="cta-row"><button className="secondary" onClick={onClose}>Not now</button><button className="primary" onClick={onConnect}>Connect Gmail ↗</button></div></>}
        {connected && <>
          <ul className="recipient-list">
            {recipients.map(r => <li key={r.contact.id + r.email} className={r.skipped ? 'skipped' : ''}><span><strong>{personLink(r.contact.name, r.contact.source)}</strong> · {r.contact.company}</span><span>{r.email || '—'}{r.skipped && <small> · {r.skipped}</small>}</span></li>)}
            {recipients.filter(r => !r.skipped).length > 8 && <li className="skipped"><small>Only the first eight people are included in one run.</small></li>}
          </ul>
          {!ready.length && <><p className="hint">Nobody left to email — everyone here was already contacted.</p><div className="cta-row"><button className="secondary" onClick={onClose}>Close</button></div></>}
          {ready.length > 0 && resumeLine}
          {ready.length > 0 && busy === 'prepare' && <p className="hint"><span className="spinner" /> Preparing personalized emails…</p>}
          {busy === 'send' && <p className="hint"><span className="spinner" /> Starting the run…</p>}
          {batch && busy !== 'send' && <>
            <div className="alert" style={{ background: '#f3f6ed', borderColor: '#d2e3c5', color: '#3f5f44' }}>{bounceDetection ? <><strong>How this run works:</strong> {probeName} is emailed first at the top-ranked format. If that bounces (usually within seconds; 60s at most), the next format is tried on {probeName}. Once a format gets through, everyone else is emailed at that format, and anyone who bounces is retried at their next address (up to 3 tries each). It keeps going even if you close this window.</> : <>Bounce detection is off, so everyone is emailed once at their top address. Reconnect Gmail to enable format verification.</>}</div>
            <p className="hint">Each recruiter gets a separate email with {batch.attachment} attached. Expand any row to read exactly what will be sent, change anything you like, or remove a person with ×.</p>
            {rowDetails(batch, batch.attachment, setBatch)}
            {batch.removed?.length ? <p className="hint">Left out: {batch.removed.map(r => r.name).join(', ')}.</p> : null}
            <label className="confirm" style={{ marginTop: 20 }}><input type="checkbox" checked={authorized && !unsaved} disabled={!!busy || unsaved} onChange={e => setAuthorized(e.target.checked)} />I authorize this run: up to {batch.rows.length} recruiters, up to 3 addresses each, with {batch.attachment} attached. The addresses are best guesses and are not verified.{unsaved ? ' Save or discard your edits first.' : ''}</label>
            <div className="cta-row"><button className="secondary" disabled={!!busy} onClick={onClose}>Cancel</button><button className="primary" disabled={!authorized || unsaved || !!busy} onClick={() => startRun(batch)}>Authorize & start the run ↗</button></div>
          </>}
        </>}
      </>}
      {!run && runId && !error && <p className="hint"><span className="spinner" /> Loading the run…</p>}
    </section>
  </div>;
}
