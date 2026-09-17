"use client";
import { useEffect, useState } from 'react';
import SearchDiagnostics, { type SearchDebug } from './SearchDiagnostics';
import SearchProgress from './SearchProgress';
import SendFlow, { type Batch, type Resume } from './SendFlow';

type PatternReport = { expiresAt?: string; retryAfter?: string; refreshError?: string; reportedPatterns?: { format: string; percentage: number | null; source: string; context: string }[]; domain: string; checkedAt: string; sources: { source: string; status: string; examples: number; detail?: string }[]; warnings: string[] };
type Candidate = { source?: string; email: string; format: string; evidence: string; status: string; percentage?: number | null };
type Profile = { association?: { basis: string; text: string }; source: string; name: string; title: string; snippet: string; focus: string; basis: string; profileStatus: string; candidates: Candidate[] };
type Discovery = { diagnostics?: SearchDebug; domainResolution?: { domain: string; status: string; sources: string[]; message: string }; company: string; domain: string; provider: string; searchedAt: string; warnings: string[]; patternReport?: PatternReport | null; results: Profile[] };
type Contact = { id: string; name: string; title: string; company: string; domain: string; source: string; focus: string; selected: string | null; candidates: Candidate[] };
type History = { id: string; contactId: string | null; name: string; to: string; subject: string; message: string; attachment?: string | null; test?: boolean; date: string; status: string };
type Template = { subject: string; message: string };
type Profile_ = { workspace: { label: string; focus: string }; search: { roleKeyword: string; audience: string; exampleCompanies: string[] }; focusLabels: string[] };
type Status = { csrf: string; configured: boolean; connected: boolean; account: string | null; redirect: string; searchProviders: string[]; contacts: Contact[]; history: History[]; patterns: Record<string, PatternReport>; batches: Batch[]; template: Template; resume: Resume | null; profile?: Profile_ };
type PostResponse = Partial<Discovery> & { error?: string; contactIds?: string[]; saved?: number; skipped?: number; batch?: Batch; url?: string; resume?: Resume; record?: History & { gmailId?: string } };

const views: [string, string, string][] = [['find', '⌕', 'Find recruiters'], ['requests', '≡', 'Requests'], ['template', '✎', 'Default email'], ['history', '↗', 'Outreach history'], ['settings', '⚙', 'Connections']];
const placeholders = ['{first_name}', '{full_name}', '{company}', '{email}'];
const initials = (name: string) => name.split(' ').map(x => x[0]).slice(0, 2).join('');
const formatLabel = (c: Candidate) => c.percentage != null ? `${c.format} · used by ${c.percentage}% at this company (RocketReach)` : c.format === 'Imported address' ? 'Found in supplied text' : `${c.format} · generic guess, no RocketReach data`;
const sample = (text: string, company: string) => text.replaceAll('{first_name}', 'Jane').replaceAll('{full_name}', 'Jane Doe').replaceAll('{company}', company || 'Acme').replaceAll('{email}', 'jane@example.com');

export default function Home() {
  const [data, setData] = useState<Status | null>(null);
  const [view, setView] = useState('find');
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState('');
  const [query, setQuery] = useState(''); const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [flow, setFlow] = useState<{ mode: 'default' | 'custom'; ids: string[] } | null>(null);
  const [template, setTemplate] = useState<Template>({ subject: '', message: '' });
  const [testSend, setTestSend] = useState({ to: '', company: '', name: 'Jane Doe', attachResume: true });
  const searching = busy === 'Finding recruiters';

  async function refresh() { const r = await fetch('/api/status'); const d = await r.json() as Status & { error?: string }; if (!r.ok) throw new Error(d.error || 'Could not load workspace.'); setData(d); return d as Status; }
  useEffect(() => {
    (async () => {
      try {
        const d = await refresh();
        setTemplate(d.template);
        const auth = new URLSearchParams(location.search).get('auth');
        if (auth) { if (auth === 'connected') setNotice('Gmail connected. You can now send outreach.'); else setError(auth === 'cancelled' ? 'Google sign-in was cancelled.' : auth === 'missing_permission' ? 'Approve Gmail sending permission when connecting.' : 'Google sign-in failed. Check your redirect URL and account access, then reconnect.'); history.replaceState(null, '', '/'); }
      } catch (e) { setError(e instanceof Error ? e.message : 'Could not load workspace.'); }
      try {
        const r = await fetch('/api/discover/last');
        const last = r.ok ? await r.json() as Discovery | null : null;
        if (last?.company) { setDiscovery(last); setQuery(last.company); }
      } catch { /* results simply start empty */ }
    })();
  }, []);
  async function post(path: string, body: unknown = {}): Promise<PostResponse> { const r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': data?.csrf || '' }, body: JSON.stringify(body) }); const d = await r.json() as PostResponse; if (!r.ok) throw new Error(d.error || 'Request failed.'); return d; }
  async function run(label: string, fn: () => Promise<void>) { if (busy) return; setBusy(label); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); } finally { setBusy(''); } }
  async function searchCompany(fresh = false) {
    await run('Finding recruiters', async () => {
      setDiscovery(null); setFlow(null);
      const result = await post('discover', { company: query, fresh }) as Discovery;
      setDiscovery(result); await refresh();
      if (!result.results.length) setNotice('No recruiters were found. The Requests tab shows what each search returned.');
    });
  }
  async function startSend(mode: 'default' | 'custom') {
    if (!discovery) return;
    await run('Preparing recipients', async () => {
      const result = await post('discover/save', { sources: discovery.results.map(r => r.source), domain: discovery.domain });
      await refresh(); setFlow({ mode, ids: result.contactIds || [] });
    });
  }
  async function uploadResume(file: File | undefined) {
    if (!file) return;
    await run('Saving resume', async () => {
      if (file.size > 5 * 1024 * 1024) throw new Error('The resume must be 5 MB or smaller.');
      const data64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(new Error('The file could not be read.')); reader.readAsDataURL(file); });
      await post('resume', { filename: file.name, type: file.type, data: data64 });
      await refresh(); setNotice(`Resume saved: ${file.name}. It will be offered as an attachment on every send.`);
    });
  }
  const sent = data?.history.filter(h => h.status === 'sent' && !h.test).length || 0;
  const topFormat = discovery?.patternReport?.reportedPatterns?.[0];
  const hasDefault = !!(data?.template.subject.trim() && data?.template.message.trim());

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" aria-label="First Role home" onClick={() => setView('find')}><span className="brand-mark">f.</span>first role<span className="brand-dot">®</span></button>
      <div className="workspace-label">PERSONAL WORKSPACE</div>
      <nav aria-label="Main navigation">{views.map(([id, icon, label]) => <button key={id} className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => setView(id)}><span aria-hidden="true">{icon}</span>{label}{id === 'history' && sent > 0 && <small>{sent}</small>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="local-dot" /> Runs on your computer<p>Your next chapter starts<br />with a conversation.</p><span className="avatar">YOU</span><strong>{data?.profile?.workspace.label ?? 'Your job search'}<small>{data?.profile?.workspace.focus ?? 'Recruiter outreach'}</small></strong></div>
    </aside>
    <main>
      <header className="topbar"><div>Workspace <span>/</span> {views.find(v => v[0] === view)?.[2]}</div><button className="connection" onClick={() => setView('settings')}><i className={data?.connected ? 'online' : ''} />{data?.connected ? `Gmail · ${data.account}` : 'Connect Gmail'} <span>↗</span></button></header>
      <div className="content">
        {error && <div className="alert error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        {notice && <div className="alert success" role="status">{notice}<button aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}
        {!data && <div className="loading">{error ? 'Workspace unavailable. Start the app with npm run dev.' : 'Opening your workspace…'}</div>}
        {data && <>
          {view === 'find' && <>
            <div className="page-heading"><div><div className="eyebrow">A MORE PERSONAL WAY IN</div><h1>Find your next conversation.</h1><p>Type a company. We find its recruiters, work out their email format, and you decide what to send.</p></div></div>
            <section className="search-panel"><div className="search-intro"><span className="step-number">01</span><div><h2>Start with a company</h2><p>{data.profile?.search.audience ?? 'Recruiters at the companies on your list.'}</p></div>{data.searchProviders.length === 0 && <span className="pill">NO SEARCH API KEY</span>}</div><form className="search-row" onSubmit={e => { e.preventDefault(); void searchCompany(); }}><label className="search-input"><span aria-hidden="true">⌕</span><input aria-label="Company to search" placeholder="Which company is on your list?" value={query} onChange={e => setQuery(e.target.value)} required maxLength={100} /></label><button className="primary" disabled={!!busy || query.trim().length < 2}>{searching ? 'Finding recruiters…' : 'Find recruiters →'}</button></form><div className="search-foot"><span>Names come from LinkedIn search results; email formats from RocketReach. Nothing is sent until you authorize it.</span><div>Try {(data.profile?.search.exampleCompanies ?? ['Stripe', 'Microsoft', 'Datadog']).map(x => <button key={x} disabled={!!busy} onClick={() => setQuery(x)}>{x}</button>)}</div></div></section>
            <SearchProgress running={searching} onViewRequests={() => setView('requests')} />
            {discovery && !searching && <section className="panel discovery-results">
              <div className="section-heading"><div><h2>{discovery.results.length} recruiter{discovery.results.length === 1 ? '' : 's'} at {discovery.company}</h2><p>Found {new Date(discovery.searchedAt).toLocaleString()}. Nothing has been sent.</p></div><button className="plain" onClick={() => setView('requests')}>See the requests behind this →</button></div>
              <div className="results-head">
                <span className={'chip' + (discovery.domain ? '' : ' warn')}>{discovery.domain ? `Email domain · ${discovery.domain}` : 'Email domain not established'}</span>
                {discovery.patternReport && <span className={'chip' + (discovery.patternReport.reportedPatterns?.length ? '' : ' warn')}>{discovery.patternReport.reportedPatterns?.length ? `${discovery.patternReport.reportedPatterns.length} RocketReach formats · most common ${topFormat?.format} (${topFormat?.percentage}%)` : 'No RocketReach formats · generic guesses'}</span>}
                <span className="chip">{discovery.provider}</span>
              </div>
              {!discovery.domain && discovery.domainResolution && <p className="hint">{discovery.domainResolution.message}</p>}
              {discovery.results.length === 0 ? <div className="empty"><span className="empty-icon">↗</span><h3>No recruiters found</h3><p>Try the company’s common short name, or open Requests to see exactly what the search returned.</p><button className="secondary" onClick={() => void searchCompany(true)}>Search again</button></div> : <>
                <div className="profile-grid">{discovery.results.map(row => <article className="profile-card" key={row.source}>
                  <header><span className="person-avatar">{initials(row.name)}</span><div><strong>{row.name}</strong><small>{row.title}</small></div><span className="tag">{row.focus}</span></header>
                  {row.candidates[0] ? <div className="email-primary"><strong>{row.candidates[0].email}</strong><small>{formatLabel(row.candidates[0])}</small></div> : <div className="email-primary"><strong>No address yet</strong><small>Company email domain unresolved</small></div>}
                  {row.candidates.length > 1 && <details className="pattern-detail"><summary>All {row.candidates.length} possible formats</summary><ul className="email-list">{row.candidates.map(c => <li key={c.email}><span>{c.email}</span><span>{c.percentage != null ? `${c.percentage}%` : c.format}</span></li>)}</ul></details>}
                  {row.association && <details className="pattern-detail"><summary>Why this profile matched</summary><p>{row.association.text}</p><p>{row.association.basis} · current employment is not independently confirmed.</p></details>}
                  <footer><a href={row.source} target="_blank" rel="noreferrer">LinkedIn profile ↗</a><span>{row.candidates.length ? `${row.candidates.length} format${row.candidates.length === 1 ? '' : 's'}` : ''}</span></footer>
                </article>)}</div>
                {discovery.domain && <div className="cta-row">
                  <button className="primary" disabled={!!busy || !hasDefault} onClick={() => void startSend('default')}>Send my default email to all {discovery.results.length} →</button>
                  <button className="secondary" disabled={!!busy} onClick={() => void startSend('custom')}>Write a custom message</button>
                  <span className="hint" style={{ margin: 0 }}>{hasDefault ? 'You review every email and authorize before anything is sent.' : <>Set a default email first in <button className="plain" onClick={() => setView('template')}>Default email</button>.</>}</span>
                </div>}
              </>}
              {discovery.warnings.length > 0 && <details className="pattern-detail" style={{ marginTop: 16 }}><summary>{discovery.warnings.length} note{discovery.warnings.length === 1 ? '' : 's'}</summary>{discovery.warnings.map(w => <p key={w}>{w}</p>)}</details>}
            </section>}
            <div className="stats"><div><span>Recruiters saved</span><strong>{String(data.contacts.length).padStart(2, '0')}</strong><small>Across all searches</small></div><div><span>Emails submitted</span><strong>{String(sent).padStart(2, '0')}</strong><small>Through Gmail</small></div><div><span>Sending from</span><strong style={{ fontSize: 16 }}>{data.account || '—'}</strong><small>{data.connected ? 'Gmail connected' : 'Connect Gmail in Connections'}</small></div></div>
          </>}
          {view === 'requests' && <>
            <div className="page-heading"><div><div className="eyebrow">UNDER THE HOOD</div><h1>Every request, and what came back.</h1><p>Search queries, pages read, formats extracted, and anything that failed for the latest company search.</p></div></div>
            <SearchDiagnostics running={searching} report={discovery?.diagnostics} retry={() => { setView('find'); void searchCompany(true); }} />
          </>}
          {view === 'template' && <>
            <div className="page-heading"><div><div className="eyebrow">WRITE ONCE</div><h1>Your default email.</h1><p>Sent to every recruiter when you choose “Send my default email”. Keep the company-specific parts as placeholders.</p></div></div>
            <div className="template-layout">
              <section className="panel"><label>Subject<input maxLength={200} value={template.subject} onChange={e => setTemplate({ ...template, subject: e.target.value })} /></label><label>Message<textarea rows={14} maxLength={20000} value={template.message} onChange={e => setTemplate({ ...template, message: e.target.value })} /></label><p className="hint">Placeholders filled in per recruiter: {placeholders.join(' · ')}</p><div className="cta-row"><button className="primary" disabled={!!busy || !template.subject.trim() || !template.message.trim()} onClick={() => run('Saving default email', async () => { await post('template', template); await refresh(); setNotice('Default email saved.'); })}>Save default email</button>{data.template.subject !== template.subject || data.template.message !== template.message ? <span className="hint" style={{ margin: 0 }}>Unsaved changes</span> : null}</div></section>
              <aside className="compose-guide"><span className="step-number">✎</span><h2>Preview</h2><p><strong>{sample(template.subject, discovery?.company || '')}</strong></p><pre>{sample(template.message, discovery?.company || '')}</pre></aside>
            </div>
            <section className="panel"><div className="section-heading"><div><h2>Send yourself a test</h2><p>Sends the text in the editor above through Gmail, with the placeholders filled in from the values below. Recorded as a test, not as outreach.</p></div></div>
              <form className="form-grid" onSubmit={e => { e.preventDefault(); void run('Sending test email', async () => { const result = await post('test-send', { ...testSend, subject: template.subject, message: template.message, attachResume: !!data.resume && testSend.attachResume }); await refresh(); setNotice(`Test email submitted to ${testSend.to}${result.record?.attachment ? ` with ${result.record.attachment} attached` : ''}. Check that inbox.`); }); }}>
                <label>Send to<input type="email" required placeholder="you@gmail.com" value={testSend.to} onChange={e => setTestSend({ ...testSend, to: e.target.value })} /></label>
                <label>Company name<input required maxLength={100} placeholder="Amazon" value={testSend.company} onChange={e => setTestSend({ ...testSend, company: e.target.value })} /></label>
                <label>Recruiter name (for {'{first_name}'})<input maxLength={100} value={testSend.name} onChange={e => setTestSend({ ...testSend, name: e.target.value })} /></label>
                <div style={{ alignSelf: 'end', marginBottom: 17 }}>{data.resume ? <label className="confirm" style={{ margin: 0 }}><input type="checkbox" checked={testSend.attachResume} onChange={e => setTestSend({ ...testSend, attachResume: e.target.checked })} />Attach {data.resume.filename}</label> : <span className="hint" style={{ margin: 0 }}>No resume saved yet — see below.</span>}</div>
                <div className="cta-row" style={{ marginTop: 0 }}><button className="primary" disabled={!!busy || !data.connected || !template.subject.trim() || !template.message.trim()}>{busy === 'Sending test email' ? 'Sending…' : 'Send test email ↗'}</button>{!data.connected && <span className="hint" style={{ margin: 0 }}>Connect Gmail first.</span>}</div>
              </form>
            </section>
            <section className="panel"><div className="section-heading"><div><h2>Resume</h2><p>Saved on this computer and offered as an attachment every time you send. PDF, DOC, or DOCX up to 5 MB.</p></div>{data.resume && <span className="tag green">Saved</span>}</div>
              <div className="domain-status"><div><strong>{data.resume ? `📎 ${data.resume.filename}` : 'No resume saved yet'}</strong><p>{data.resume ? `${Math.round(data.resume.size / 1024)} KB · saved ${new Date(data.resume.savedAt).toLocaleString()}` : 'If your default email says a resume is attached, upload it here.'}</p></div><div className="button-row"><label className="secondary" style={{ margin: 0, cursor: 'pointer' }}>{busy === 'Saving resume' ? 'Saving…' : data.resume ? 'Replace file' : 'Upload resume'}<input type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} disabled={!!busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; void uploadResume(file); }} /></label>{data.resume && <button className="secondary" disabled={!!busy} onClick={() => run('Removing resume', async () => { await post('resume/remove'); await refresh(); setNotice('Resume removed.'); })}>Remove</button>}</div></div>
            </section>
          </>}
          {view === 'history' && <>
            <div className="page-heading"><div><div className="eyebrow">KEEP THE CONVERSATION IN VIEW</div><h1>Your introductions.</h1><p>Gmail submission history. Replies and bounces arrive in your Gmail inbox.</p></div><a className="secondary" href="https://mail.google.com/mail/u/0/#sent" target="_blank" rel="noreferrer">Open Gmail Sent ↗</a></div>
            <section className="panel">{data.batches?.filter(b => b.status !== 'draft').map(b => <details className="history-item" key={b.id}><summary>Batch · {b.status} · {b.rows.filter(r => r.status === 'sent').length}/{b.rows.length} submitted</summary>{b.rows.map(r => <p key={r.id + r.to}>{r.name} · {r.to} · {r.status}{r.error ? ` — ${r.error}` : ''}</p>)}</details>)}{!data.history.length ? <div className="empty"><span className="empty-icon">✉</span><h3>No outreach yet</h3><p>Emails you authorize will appear here after they are sent.</p><button className="secondary" onClick={() => setView('find')}>Find recruiters</button></div> : data.history.map(h => <details className="history-item" key={h.id}><summary><span><strong>{h.name}</strong><small>{h.to} · {new Date(h.date).toLocaleString()}{h.attachment ? ` · 📎 ${h.attachment}` : ''}</small></span><span>{h.test && <span className="tag" style={{ marginRight: 8 }}>Test</span>}<span className={'status ' + h.status}>{h.status === 'sent' ? 'Submitted to Gmail' : h.status === 'pending' ? 'Check Gmail Sent' : h.status}</span></span></summary><h3>{h.subject}</h3><pre>{h.message}</pre><p className="hint">{h.status === 'sent' ? 'Submission does not confirm delivery or mailbox ownership.' : 'Check Gmail Sent before attempting any further outreach.'}</p></details>)}</section>
          </>}
          {view === 'settings' && <>
            <div className="page-heading"><div><div className="eyebrow">YOUR TOOLS, CONNECTED</div><h1>Send from your own inbox.</h1><p>Your credentials and Gmail tokens stay on this computer.</p></div></div>
            <section className="panel settings"><div className="section-heading"><div className="gmail-title"><span className="gmail-logo">M</span><div><h2>Gmail</h2><p>{data.connected ? data.account : 'Connect your Google account for personal outreach.'}</p></div></div><span className={'tag ' + (data.connected ? 'green' : '')}>{data.connected ? 'Connected' : 'Not connected'}</span></div><div className="setup-step"><span>1</span><div><h3>OAuth credentials</h3><p>{data.configured ? 'Client ID and secret found in .env.local.' : 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.local.'}</p></div><span className="setup-state">{data.configured ? '✓ Ready' : 'Needs setup'}</span></div><div className="setup-step"><span>2</span><div><h3>Register your redirect URL</h3><p>Google Auth Platform → Clients → your Web application → Authorized redirect URIs.</p><code>{data.redirect}</code><button className="plain" onClick={() => run('Copying', async () => { await navigator.clipboard.writeText(data.redirect); setNotice('Redirect URL copied. Paste it into your Google OAuth client and save.'); })}>Copy URL</button></div></div><div className="setup-step"><span>3</span><div><h3>Authorize your account</h3><p>Sign in with the Gmail account you want to send from. We request your email identity and permission to send; inbox reading is not requested.</p><div className="button-row"><button className="primary" disabled={!data.configured || !!busy} onClick={() => run('Connecting Gmail', async () => { const d = await post('auth/start'); window.location.assign(d.url || '/'); })}>{data.connected ? 'Reconnect Gmail' : 'Connect Gmail'} ↗</button>{data.connected && <button className="secondary" disabled={!!busy} onClick={() => run('Disconnecting', async () => { await post('auth/disconnect'); await refresh(); setNotice('Gmail access revoked and local tokens removed.'); })}>Disconnect</button>}</div></div></div></section>
            <section className="panel settings"><div className="section-heading"><div><h2>Search API</h2><p>{data.searchProviders.length ? `Using ${data.searchProviders.join(', ')}.` : 'No search API key found. Add SERPAPI_KEY or SERPER_API_KEY to .env.local — public search pages block automated LinkedIn queries.'}</p></div><span className={'tag ' + (data.searchProviders.length ? 'green' : '')}>{data.searchProviders.length ? 'Ready' : 'Needs setup'}</span></div></section>
            <div className="privacy-note"><h3>Local by design</h3><p>Contacts, your default email, and outreach history are stored on your computer. Searches contact external websites; Gmail receives messages only when you authorize a send. Automatic bounce tracking is not enabled.</p></div>
          </>}
        </>}
      </div>
    </main>
    {flow && data && <SendFlow mode={flow.mode} contactIds={flow.ids} contacts={data.contacts} history={data.history} connected={data.connected} account={data.account} template={data.template} resume={data.resume} post={post} refresh={refresh} onClose={() => setFlow(null)} onConnect={() => { setFlow(null); setView('settings'); }} onResume={() => { setFlow(null); setView('template'); }} onSent={() => { setFlow(null); setView('history'); setNotice('Emails submitted to Gmail.'); }} />}
  </div>;
}
