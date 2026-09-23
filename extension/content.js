/* global chrome */
// Watches the page for an application confirmation, then offers to email the company's recruiters
// through the local Recruiter Outreach app. All UI lives in a shadow root so page CSS can't touch it.
(() => {
  if (window.top !== window || document.getElementById('recruiter-outreach-host')) return;
  const detect = globalThis.RecruiterOutreachDetect;
  const ask = message => new Promise(resolve => { try { chrome.runtime.sendMessage(message, response => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message, offline: true } : response || { error: 'No response from the extension.' })); } catch { resolve({ error: 'The extension was reloaded. Refresh this page.', offline: true }); } });
  const storage = { get: async key => (await chrome.storage.local.get(key))[key], set: (key, value) => chrome.storage.local.set({ [key]: value }) };
  const pageKey = () => 'ro-seen:' + location.href.split('#')[0];

  // ---------- page facts ----------
  // Job boards and ATSs never own the employer's email domain; the first outbound link that isn't one usually does.
  const NOT_EMPLOYER = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|smartrecruiters\.com|icims\.com|jobvite\.com|taleo\.net|successfactors\.com|bamboohr\.com|breezy\.hr|workable\.com|wellfound\.com|ziprecruiter\.com|monster\.com|dice\.com|builtin\.com|simplify\.jobs|linkedin\.com|facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|glassdoor\.com|indeed\.com|google\.com|gstatic\.com|googleapis\.com|cloudflare\.com|w3\.org|apps\.apple\.com|play\.google\.com|github\.com|medium\.com|tiktok\.com|vimeo\.com)$/i;
  const registrable = host => { const labels = host.toLowerCase().split('.'); const keep = labels.length >= 3 && /^(?:co|com|org|net|ac|gov|edu)$/.test(labels.at(-2)) && labels.at(-1).length === 2 ? 3 : 2; return labels.slice(-keep).join('.'); };
  function siteHint() {
    if (!NOT_EMPLOYER.test(location.hostname)) return registrable(location.hostname);
    for (const a of document.querySelectorAll('a[href^="https://"]')) {
      try { const host = new URL(a.href).hostname; if (host !== location.hostname && !NOT_EMPLOYER.test(host) && !/^(?:cdn|static|assets|fonts|api)\./.test(host)) return registrable(host); } catch { /* skip malformed hrefs */ }
    }
    return '';
  }
  function pageFacts() {
    const meta = name => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') || '';
    const parts = [];
    for (const el of document.querySelectorAll('h1, h2, h3, [role="dialog"], [role="alert"], [role="status"], main, .application-confirmation, #application-confirmation, [class*="confirmation"], [class*="thank"], [data-automation-id*="confirm"]')) {
      const text = (el.innerText || '').trim(); if (text) parts.push(text);
      if (parts.join('\n').length > 6000) break;
    }
    const jobCompany = document.querySelector('.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, [data-test-id="job-company-name"], a[href*="/company/"], .company-name, [class*="company-name"]')?.textContent || '';
    return { hostname: location.hostname, pathname: location.pathname, title: document.title, siteName: meta('og:site_name'), jobCompany: jobCompany.trim(), text: parts.join('\n').slice(0, 6000) };
  }

  // ---------- UI ----------
  const host = document.createElement('div'); host.id = 'recruiter-outreach-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#182821;line-height:1.5}
    .badge{position:fixed;right:20px;bottom:20px;z-index:2147483646;display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #dfe6d5;border-radius:999px;padding:8px 14px 8px 8px;box-shadow:0 10px 30px #18282133;cursor:pointer;max-width:360px}
    .mark{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:#285740;color:#fff;font-weight:800;font-size:18px;flex-shrink:0}
    .badge strong{display:block;font-size:12px}.badge small{display:block;color:#748078;font-size:11px}
    .panel{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:440px;max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);overflow:auto;background:#fafbf8;border:1px solid #dfe6d5;border-radius:14px;box-shadow:0 20px 60px #18282144;padding:18px}
    .head{display:flex;align-items:center;gap:10px;margin-bottom:10px}.head h2{margin:0;font-size:15px;flex:1}.close{border:0;background:none;font-size:20px;cursor:pointer;color:#748078}
    .eyebrow{font-size:10px;letter-spacing:2px;color:#668357;font-weight:700}
    p{margin:6px 0;color:#4f5f4a}.hint{font-size:11px;color:#748078}
    input[type=text]{width:100%;border:1px solid #dde3d8;border-radius:6px;padding:9px 10px;background:#fff;font-size:13px}
    .row{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}
    .remove-person{float:right;margin-left:8px;width:22px;height:22px;border:1px solid #d9dfd4;border-radius:50%;background:#fff;color:#748078;font-size:14px;line-height:1;cursor:pointer}.remove-person:hover{color:#8f3a2a;border-color:#e2c2b8;background:#fff6f3}
    .person-link{color:inherit;text-decoration:none;border-bottom:1px dotted #9fb08f}.person-link:hover{color:#285740;border-bottom-style:solid}
    .btn{border:0;border-radius:7px;padding:10px 14px;font-weight:600;cursor:pointer;background:#fff;border:1px solid #d9dfd4;color:#42513c}
    .btn.primary{background:#285740;color:#fff;border-color:#285740}.btn.danger{color:#8f3a2a;border-color:#e2c2b8;background:#fff6f3}.btn:disabled{opacity:.45;cursor:not-allowed}
    .steps{display:grid;gap:6px;margin:10px 0}.step{padding:8px 10px;border-radius:7px;background:#f0f4e9;font-size:12px;color:#748078}.step.active{background:#e0e8d9;color:#244c31;font-weight:600}.step.done{color:#3f6b48}
    ul{list-style:none;margin:10px 0;padding:0}li{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid #e4e8e2;font-size:12px}li.skipped{opacity:.55}li span:last-child{color:#748078;text-align:right;overflow-wrap:anywhere}
    .chip{display:inline-block;font-size:11px;background:#f2f4ec;border:1px solid #e5e9de;border-radius:6px;padding:4px 8px;margin:4px 6px 4px 0;color:#4f5f4a}
    details{border-top:1px solid #e4e8e2;padding:8px 0}summary{cursor:pointer;font-size:12px}pre{white-space:pre-wrap;background:#fff;border-radius:6px;padding:12px;font:12px/1.6 inherit;margin:8px 0;max-height:220px;overflow:auto}
    .field{display:block;font-size:11px;color:#748078;margin:8px 0 0}.field input,.field textarea{display:block;width:100%;margin-top:4px;border:1px solid #dde3d8;border-radius:6px;padding:8px 10px;background:#fff;font:12px/1.55 inherit;color:#182821}.field textarea{min-height:150px;resize:vertical}
    .edit-row{display:flex;gap:8px;align-items:center;margin-top:8px}.edit-row .hint{flex:1}.edited{font-size:10px;color:#3f6b48;font-weight:700;margin-left:6px}
    label.confirm{display:flex;gap:10px;align-items:flex-start;font-size:12px;color:#717d65;margin-top:12px}label.confirm input{margin-top:3px}
    .alert{background:#fff4ef;border:1px solid #eed4c5;color:#946246;border-radius:7px;padding:10px 12px;font-size:12px;margin:8px 0}
    .ok{color:#3f6b48}.bad{color:#b42318}
    .spinner{display:inline-block;width:11px;height:11px;border:2px solid #cfd8c7;border-top-color:#285740;border-radius:50%;animation:ro-spin 1s linear infinite;vertical-align:middle}@keyframes ro-spin{to{transform:rotate(360deg)}}
  `;
  shadow.appendChild(style);
  const root = document.createElement('div'); shadow.appendChild(root);
  const h = (tag, attrs = {}, ...children) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined) el.setAttribute(k, v); } for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c); return el; };
  const mounted = () => { if (!host.isConnected) document.documentElement.appendChild(host); };
  const clear = () => { root.replaceChildren(); };
  const hide = () => { clear(); host.remove(); if (typeof runTimer !== 'undefined') clearInterval(runTimer); };

  let state = { company: '', adapter: '', busy: false, status: null };

  // Every email in a draft batch can be rewritten before it is authorized. Edits are saved to the app,
  // which validates them like generated ones; `onSaved` receives the updated batch and re-renders.
  // Every recruiter name links to the LinkedIn result it came from.
  const personLink = (name, source) => source ? h('a', { class: 'person-link', href: source, target: '_blank', rel: 'noreferrer', title: 'Open LinkedIn profile' }, `${name} ↗`) : name;
  function editableRows(batch, onSaved, onDirty = () => {}) {
    const dirty = new Set();
    return batch.rows.map((row, i) => {
      const subject = h('input', { type: 'text', value: row.subject, maxlength: '200' }), message = h('textarea', { maxlength: '20000' }, row.message);
      const status = h('span', { class: 'hint' }), save = h('button', { class: 'btn primary', disabled: '' }, 'Save changes'), discard = h('button', { class: 'btn', disabled: '' }, 'Discard');
      const key = row.id + '|' + row.to;
      const changed = () => subject.value !== row.subject || message.value !== row.message;
      const sync = () => { if (changed()) { dirty.add(key); save.removeAttribute('disabled'); discard.removeAttribute('disabled'); status.textContent = 'Unsaved changes'; } else { dirty.delete(key); save.setAttribute('disabled', ''); discard.setAttribute('disabled', ''); status.textContent = ''; } onDirty(dirty.size > 0); };
      subject.addEventListener('input', sync); message.addEventListener('input', sync);
      discard.addEventListener('click', () => { subject.value = row.subject; message.value = row.message; sync(); });
      save.addEventListener('click', async () => {
        save.setAttribute('disabled', ''); status.textContent = 'Saving…';
        const result = await ask({ type: 'update', batchId: batch.id, rows: [{ id: row.id, to: row.to, subject: subject.value, message: message.value }] });
        if (result.error) { status.textContent = result.error; status.className = 'hint bad'; save.removeAttribute('disabled'); return; }
        dirty.delete(key); onDirty(dirty.size > 0); onSaved(result.batch);
      });
      const remove = batch.rows.length > 1 ? h('button', { class: 'remove-person', title: `Leave ${row.name} out`, onclick: async e => { e.preventDefault(); remove.disabled = true; const result = await ask({ type: 'remove', batchId: batch.id, contactId: row.id }); if (result.error) { status.textContent = result.error; status.className = 'hint bad'; remove.disabled = false; } else { dirty.delete(key); onDirty(dirty.size > 0); onSaved(result.batch); } } }, '×') : null;
      const d = h('details', {}, h('summary', {}, h('strong', {}, personLink(row.name, row.source)), ` · ${row.to} · 📎`, row.edited ? h('span', { class: 'edited' }, 'EDITED') : null, remove),
        h('label', { class: 'field' }, 'Subject', subject), h('label', { class: 'field' }, 'Message', message), h('div', { class: 'edit-row' }, status, discard, save));
      if (i === 0 || row.edited) d.setAttribute('open', '');
      return d;
    });
  }

  function showBadge(company) {
    mounted(); clear();
    root.append(h('div', { class: 'badge', onclick: () => openPanel(company) }, h('span', { class: 'mark' }, 'R'), h('div', {}, h('strong', {}, `Applied to ${company || 'this company'}?`), h('small', {}, 'Email its recruiters with your default message + resume'))));
  }
  function panelShell(title, ...body) {
    mounted(); clear();
    root.append(h('div', { class: 'panel' }, h('div', { class: 'head' }, h('span', { class: 'mark' }, 'R'), h('h2', {}, title), h('button', { class: 'close', 'aria-label': 'Close', onclick: () => { if (!state.busy) hide(); } }, '×')), ...body));
  }
  async function openPanel(company) {
    state.company = company || state.company;
    const status = await ask({ type: 'status' });
    if (status.error) return showSetup(status);
    state.status = status;
    const missing = [!status.connected && 'connect Gmail', !status.resume && 'upload your resume', !status.template && 'save a default email', !status.searchProviders?.length && 'add a search API key'].filter(Boolean);
    if (missing.length) return showSetup({ error: `In the Recruiter Outreach app, ${missing.join(', ')} first.`, setup: true });
    // A run that is still going (or paused) re-attaches here, even after the page was closed.
    const active = await ask({ type: 'run-active' });
    if (active.run && ['running', 'stopped', 'interrupted'].includes(active.run.status)) return watchRun(active.run.id, () => showPrompt(status));
    showPrompt(status);
  }
  function showSetup(problem) {
    panelShell('Recruiter Outreach', h('div', { class: 'alert' }, problem.error), problem.offline ? h('p', { class: 'hint' }, 'Tip: run npm run agent:install once so the app starts at login.') : null, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => ask({ type: 'open-app', path: problem.setup ? '/' : '/' }) }, 'Open the app ↗'), h('button', { class: 'btn', onclick: hide }, 'Close')));
  }
  function showPrompt(status) {
    const input = h('input', { type: 'text', value: state.company, placeholder: 'Company name' });
    panelShell('Email the recruiters', h('div', { class: 'eyebrow' }, 'STEP 1 · CONFIRM THE COMPANY'), h('p', {}, `We'll search for recruiters at this company, work out their email format, and show you every email before anything is sent.`), input, h('p', { class: 'hint' }, `Sending from ${status.account} · 📎 ${status.resume.filename} attached · your default email`), h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => runPreview(input.value.trim()) }, 'Find recruiters →'), h('button', { class: 'btn', onclick: async () => { await storage.set(pageKey(), 'skipped'); hide(); } }, 'Not now')));
    setTimeout(() => input.focus(), 50);
  }
  const STEPS = [['Searching LinkedIn results', ['Search', 'Recruiter search', 'Profile filter', 'Recruiter discovery', 'Company association', 'Cache']], ['Checking the company domain', ['Domain search', 'Company website', 'Mail servers', 'Domain decision', 'Domain discovery']], ['Reading RocketReach formats', ['Email pattern cache', 'RocketReach search', 'RocketReach page', 'RocketReach format', 'RocketReach formats', 'Email patterns']], ['Building email candidates', ['Email candidates']]];
  function renderProgress(company, progress) {
    const events = progress?.events || []; const reached = Math.max(0, ...events.map(e => STEPS.findIndex(([, names]) => names.includes(e.stage))));
    panelShell(`Finding recruiters at ${company}`, h('div', { class: 'steps' }, STEPS.map(([label], i) => h('div', { class: 'step ' + (i < reached ? 'done' : i === reached ? 'active' : '') }, `${i < reached ? '✓' : i === reached ? '…' : '○'} ${label}`))), h('p', { class: 'hint' }, events.at(-1)?.detail || 'Starting search…'));
  }
  async function runPreview(company, fresh = false) {
    if (company.length < 2) return;
    state.company = company; state.busy = true;
    renderProgress(company, null);
    const timer = setInterval(async () => { const progress = await ask({ type: 'progress' }); if (state.busy && progress?.company === company) renderProgress(company, progress); }, 1500);
    const result = await ask({ type: 'preview', company, fresh, siteHint: siteHint(), pageUrl: location.href.split('#')[0] });
    clearInterval(timer); state.busy = false;
    if (result.error) return showSetup(result);
    showPreview(result);
  }
  function showPreview(result) {
    const { discovery, recipients, batch, reason } = result;
    const chips = h('div', {}, h('span', { class: 'chip', title: discovery.domainMessage || '' }, discovery.domain ? `Email domain · ${discovery.domain}` : 'Email domain not established'), discovery.formats ? h('span', { class: 'chip' }, `${discovery.formats} RocketReach formats · most common ${discovery.topFormat.format} (${discovery.topFormat.percentage}%)`) : h('span', { class: 'chip' }, 'No RocketReach formats · generic guesses'), discovery.domainMessage ? h('p', { class: 'hint' }, discovery.domainMessage) : null);
    const people = h('ul', {}, discovery.results.map(r => { const skip = recipients.find(x => x.name === r.name)?.skipped; return h('li', { class: skip ? 'skipped' : '' }, h('span', {}, h('strong', {}, personLink(r.name, r.source)), h('br'), h('span', { class: 'hint' }, r.title)), h('span', {}, r.candidates[0]?.email || '—', skip ? h('br') : null, skip ? h('span', { class: 'hint' }, skip) : null)); }));
    if (!batch) {
      const retry = h('input', { type: 'text', value: state.company, placeholder: 'Company name' });
      return panelShell(`${discovery.results.length} recruiters at ${discovery.company}`, chips, people, h('div', { class: 'alert' }, reason), h('p', { class: 'hint' }, 'Tip: use the company’s everyday name (for example “Scale AI”, not “scaleai”). Every request is listed under Requests in the app.'), retry, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => runPreview(retry.value.trim(), true) }, 'Search again →'), h('button', { class: 'btn', onclick: () => ask({ type: 'open-app' }) }, 'Open app ↗'), h('button', { class: 'btn', onclick: hide }, 'Close')));
    }
    const authorize = h('input', { type: 'checkbox' });
    const sendButton = h('button', { class: 'btn primary', disabled: '' , onclick: () => startRun(batch) }, 'Authorize & start the run ↗');
    let unsaved = false;
    const syncSend = () => { if (authorize.checked && !unsaved) sendButton.removeAttribute('disabled'); else sendButton.setAttribute('disabled', ''); };
    authorize.addEventListener('change', syncSend);
    const rows = editableRows(batch, updated => showPreview({ ...result, batch: updated }), flag => { unsaved = flag; authorize.disabled = flag; if (flag) authorize.checked = false; syncSend(); });
    const first = batch.rows[0]?.name, verified = !!state.status?.bounceDetection;
    const plan = h('div', { class: 'alert', style: 'background:#f3f6ed;border-color:#d2e3c5;color:#3f5f44' }, verified ? `How this run works: ${first} is emailed first at the top-ranked format. If that bounces (usually within seconds; 60s at most), the next format is tried on ${first}. Once a format gets through, everyone else is emailed at it, and anyone who bounces is retried at their next address (up to 3 tries each). It keeps going even if you close this panel.` : 'Bounce detection is off, so everyone is emailed once at their top address. Reconnect Gmail in the app to enable format verification.');
    panelShell(`Email ${batch.rows.length} recruiter${batch.rows.length === 1 ? '' : 's'} at ${discovery.company}`, h('div', { class: 'eyebrow' }, 'STEP 2 · REVIEW, EDIT AND AUTHORIZE'), chips, people, plan, h('p', { class: 'hint' }, `Each recruiter gets a separate email with ${batch.attachment} attached. Expand a row to read it, and change anything you like; save each edit before authorizing.`), rows, h('label', { class: 'confirm' }, authorize, `I authorize this run: up to ${batch.rows.length} recruiters, up to 3 addresses each, with ${batch.attachment} attached. The addresses are best guesses and are not verified.`), h('div', { class: 'row' }, sendButton, h('button', { class: 'btn', onclick: hide }, 'Cancel')));
  }
  // ---------- verified run (server-owned; closing the panel never stops it) ----------
  let runTimer = null;
  const outcomeLabel = { queued: 'Queued', watching: 'Sent · watching', reached: 'Reached', retrying: 'Bounced · retrying', exhausted: 'All addresses bounced' };
  function runHeadline(run) {
    if (run.status === 'complete') return `Done · ${run.summary.reached} reached${run.summary.exhausted ? ` · ${run.summary.exhausted} could not be reached` : ''}`;
    if (run.status !== 'running') return `${run.stoppedBy ? 'Stopped' : 'Paused'} · ${run.summary.reached} reached so far`;
    if (!run.wave) return 'Preparing the next step…';
    if (run.wave.kind === 'probe') { const person = run.people.find(p => run.wave.contactIds.includes(p.id)); const attempt = person?.attempts.at(-1); return `Testing the “${attempt?.format || 'top'}” format on ${person?.name || 'the first recruiter'}`; }
    return `Emailing everyone at “${run.verifiedFormat}” · watching for bounces`;
  }
  function renderRun(run, onNew) {
    const people = h('ul', {}, run.people.map(p => h('li', {}, h('span', {}, h('strong', {}, personLink(p.name, p.source)), h('br'), h('span', { class: 'hint' }, p.attempts.length ? p.attempts.map((a, i) => `${i ? ' → ' : ''}${a.to} (${statusLabel(a)})`).join('') : 'Waiting for the verified format')), h('span', { class: p.outcome === 'reached' ? 'ok' : p.outcome === 'exhausted' ? 'bad' : '' }, outcomeLabel[p.outcome] || p.outcome))));
    const parts = [h('div', { class: 'eyebrow' }, `${run.status === 'running' ? 'VERIFIED SEND · IN PROGRESS' : run.status === 'complete' ? 'VERIFIED SEND · DONE' : run.stoppedBy ? 'VERIFIED SEND · STOPPED' : 'VERIFIED SEND · PAUSED'} · ${run.company}`)];
    if (run.status === 'running' && run.wave) parts.push(h('p', { class: 'hint' }, h('span', { class: 'spinner' }), ` Watching the inbox — moves on the moment a bounce arrives, or after ${run.wave.secondsLeft}s more if nothing comes back${run.wave.checks ? ` · checked ${run.wave.checks}×` : ''}. You can close this panel — the run continues in the app.`));
    if (run.error) parts.push(h('div', { class: 'alert' }, run.error));
    if (run.verifiedFormat) parts.push(h('p', { class: 'hint ok' }, `✓ The “${run.verifiedFormat}” format got through${run.domain !== run.originalDomain ? ` at ${run.domain} (switched from ${run.originalDomain})` : ''}; everyone else is emailed at that format.`));
    else if (run.alternates?.length && run.status === 'running') parts.push(h('p', { class: 'hint' }, `If every address at ${run.domain} bounces, ${run.alternates.join(' and ')} will be tried next.`));
    parts.push(people);
    const log = h('details', {}, h('summary', {}, `Activity (${run.log.length})`), ...run.log.map(l => h('p', { class: 'hint' }, `${new Date(l.at).toLocaleTimeString()} · ${l.detail}`)));
    parts.push(log);
    const buttons = [];
    if (run.status === 'running') {
      buttons.push(h('button', { class: 'btn', onclick: hide }, 'Run in background'));
      // Two clicks to stop: the first swaps the button for an explicit confirmation.
      const stop = h('button', { class: 'btn danger', onclick: () => { stop.replaceWith(h('button', { class: 'btn danger', onclick: async () => { clearInterval(runTimer); const r = await ask({ type: 'run-stop', id: run.id }); if (r.error) renderRun({ ...run, error: r.error }, onNew); else renderRun(r.run, onNew); } }, 'Yes, stop now — send nothing more'), h('button', { class: 'btn', onclick: () => renderRun(run, onNew) }, 'Keep going')); } }, 'Stop sending');
      buttons.push(stop);
    }
    if (['stopped', 'interrupted'].includes(run.status)) buttons.push(h('button', { class: 'btn primary', onclick: async () => { const r = await ask({ type: 'run-resume', id: run.id }); if (r.error) renderRun({ ...run, error: r.error }, onNew); else watchRun(run.id, onNew); } }, 'Resume run'));
    if (run.status !== 'running') { buttons.push(h('button', { class: 'btn primary', onclick: hide }, 'Done')); if (onNew) buttons.push(h('button', { class: 'btn', onclick: onNew }, 'New search')); }
    buttons.push(h('button', { class: 'btn', onclick: () => ask({ type: 'open-app', path: '/' }) }, 'Open app ↗'));
    parts.push(h('div', { class: 'row' }, ...buttons));
    panelShell(runHeadline(run), ...parts);
  }
  async function watchRun(id, onNew) {
    clearInterval(runTimer);
    const tick = async () => { const r = await ask({ type: 'run-status', id }); if (r.error) { clearInterval(runTimer); return showSetup(r); } renderRun(r.run, onNew); if (r.run.status !== 'running') clearInterval(runTimer); };
    await tick(); runTimer = setInterval(tick, 3000);
  }
  async function startRun(batch) {
    state.busy = true;
    panelShell('Starting the run…', h('p', {}, h('span', { class: 'spinner' }), ' Sending the first email.'));
    const result = await ask({ type: 'run-start', batchId: batch.id });
    state.busy = false;
    if (result.error) return showSetup(result);
    await storage.set(pageKey(), 'sent');
    watchRun(result.run.id, null);
  }
  // After sending, stay open for about a minute and poll for bounce notices; offer the next-best address for any bounce.
  const WATCH_SECONDS = 60, CHECK_EVERY = 10;
  const statusLabel = r => r.status === 'sent' ? 'Submitted' : r.status === 'bounced' ? 'Bounced' : r.status === 'not_started' ? 'Not attempted' : r.status;
  function rowsList(rows) {
    return h('ul', {}, rows.map(r => h('li', {}, h('span', {}, h('strong', {}, personLink(r.name, r.source))), h('span', { class: r.status === 'sent' ? 'ok' : r.status === 'bounced' ? 'bad' : '' }, `${r.to} · ${statusLabel(r)}${r.error ? ' · ' + r.error : ''}`, r.status === 'bounced' ? h('br') : null, r.status === 'bounced' ? h('span', { class: 'hint' }, r.next ? `Next best: ${r.next.email}${r.next.percentage != null ? ` (${r.next.format}, ${r.next.percentage}%)` : ''}` : 'No other address left to try') : null))));
  }
  async function runSend(batch) {
    state.busy = true;
    panelShell('Sending…', h('p', {}, h('span', { class: 'spinner' }), ` Submitting ${batch.rows.length} emails to Gmail.`));
    const result = await ask({ type: 'send', batchId: batch.id });
    if (result.error) { state.busy = false; return showSetup(result); }
    await storage.set(pageKey(), 'sent');
    const sentBatch = result.batch;
    if (!state.status?.bounceDetection) { state.busy = false; return showOutcome(sentBatch, { rows: sentBatch.rows, retryBatch: null, retryError: null }, { noDetection: true }); }
    let secondsLeft = WATCH_SECONDS, latest = { rows: sentBatch.rows, retryBatch: null, retryError: null }, checks = 0;
    const render = () => panelShell(`${latest.rows.filter(r => r.status === 'sent').length} of ${latest.rows.length} submitted`, h('div', { class: 'eyebrow' }, 'SENT · WATCHING FOR BOUNCES'), h('p', { class: 'hint' }, h('span', { class: 'spinner' }), ` Watching your inbox for delivery failures — ${secondsLeft}s left${checks ? ` · checked ${checks}×` : ''}. Keep this panel open.`), rowsList(latest.rows));
    render();
    while (secondsLeft > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000)); secondsLeft--;
      if (secondsLeft % CHECK_EVERY === 0 || secondsLeft <= 0) { const check = await ask({ type: 'bounces', batchId: sentBatch.id }); if (!check.error) { latest = check; checks++; } else latest.retryError = check.error; }
      render();
    }
    state.busy = false;
    showOutcome(sentBatch, latest, { checks });
  }
  function showOutcome(sentBatch, latest, { noDetection = false, checks = 0 } = {}) {
    const bounced = latest.rows.filter(r => r.status === 'bounced').length;
    const parts = [h('div', { class: 'eyebrow' }, 'RESULT'), rowsList(latest.rows)];
    if (noDetection) parts.push(h('div', { class: 'alert' }, 'Bounce detection is off. Reconnect Gmail once in the app (it adds the “message headers” permission) and undeliverable addresses will be caught automatically.'));
    else if (!bounced) parts.push(h('p', { class: 'hint' }, `No delivery failures were reported within ${WATCH_SECONDS} seconds (checked ${checks}×). Late bounces still arrive in your inbox.`));
    if (latest.retryError) parts.push(h('div', { class: 'alert' }, latest.retryError));
    const buttons = [];
    if (latest.retryBatch) {
      const retry = latest.retryBatch, authorize = h('input', { type: 'checkbox' });
      const sendRetry = h('button', { class: 'btn primary', disabled: '', onclick: () => runSend(retry) }, `Authorize & send ${retry.rows.length} retr${retry.rows.length === 1 ? 'y' : 'ies'} ↗`);
      let unsaved = false;
      const syncRetry = () => { if (authorize.checked && !unsaved) sendRetry.removeAttribute('disabled'); else sendRetry.setAttribute('disabled', ''); };
      authorize.addEventListener('change', syncRetry);
      const rows = editableRows(retry, updated => showOutcome(sentBatch, { ...latest, retryBatch: updated }, { noDetection, checks }), flag => { unsaved = flag; authorize.disabled = flag; if (flag) authorize.checked = false; syncRetry(); });
      parts.push(h('div', { class: 'eyebrow' }, 'RETRY AT THE NEXT-BEST ADDRESS'), rows, h('label', { class: 'confirm' }, authorize, `I authorize sending ${retry.rows.length} retr${retry.rows.length === 1 ? 'y' : 'ies'} to the next-best address${retry.rows.length === 1 ? '' : 'es'}.`));
      buttons.push(sendRetry);
    }
    if (!noDetection) buttons.push(h('button', { class: 'btn', onclick: async () => { const check = await ask({ type: 'bounces', batchId: sentBatch.id }); showOutcome(sentBatch, check.error ? { ...latest, retryError: check.error } : check, { checks: checks + 1 }); } }, 'Check again'));
    buttons.push(h('button', { class: latest.retryBatch ? 'btn' : 'btn primary', onclick: hide }, 'Done'), h('button', { class: 'btn', onclick: () => ask({ type: 'open-app', path: '/' }) }, 'Open app ↗'));
    parts.push(h('div', { class: 'row' }, ...buttons));
    panelShell(`${latest.rows.filter(r => r.status === 'sent').length} of ${latest.rows.length} submitted${bounced ? ` · ${bounced} bounced` : ''}`, ...parts);
  }

  // ---------- detection loop ----------
  let lastCheck = 0, pending = null, done = false;
  async function check() {
    if (done) return;
    const now = Date.now(); if (now - lastCheck < 1500) { clearTimeout(pending); pending = setTimeout(check, 1600); return; }
    lastCheck = now;
    const hit = detect.detect(pageFacts());
    if (!hit) return;
    done = true;
    const seen = await storage.get(pageKey()); if (seen) return;
    await storage.set(pageKey(), 'shown');
    state.adapter = hit.adapter; showBadge(hit.company);
  }
  const observer = new MutationObserver(() => { clearTimeout(pending); pending = setTimeout(check, 800); });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  let lastHref = location.href;
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; done = false; check(); } }, 1000);
  check();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'open-panel') { openPanel(message.company || detect.detect(pageFacts())?.company || pageFacts().siteName || ''); sendResponse({ ok: true }); }
    return false;
  });
})();
