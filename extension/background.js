/* global chrome */
// Service worker: the only place that talks to the local app. Content scripts and the popup
// send messages here so page CORS rules never apply and the token never reaches a web page.
const BASE = 'http://localhost:3000';

async function getToken() { const { extensionToken } = await chrome.storage.local.get('extensionToken'); return extensionToken || ''; }

async function api(path, body) {
  const token = await getToken();
  if (!token) return { error: 'Paste your extension token in the Recruiter Outreach popup first.', setup: true };
  try {
    const response = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'X-Extension-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { error: data.error || `The app answered with HTTP ${response.status}.`, status: response.status, setup: response.status === 403 };
    return data;
  } catch {
    return { error: 'The Recruiter Outreach app is not running on localhost:3000. Start it (npm run dev, or the launch agent) and try again.', offline: true };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'status': sendResponse(await api('/api/extension/status')); break;
      case 'progress': sendResponse(await api('/api/extension/progress')); break;
      case 'preview': sendResponse(await api('/api/extension/preview', { company: String(message.company || ''), fresh: message.fresh === true, siteHint: String(message.siteHint || ''), pageUrl: String(message.pageUrl || '') })); break;
      case 'update': sendResponse(await api('/api/extension/update', { batchId: String(message.batchId || ''), rows: Array.isArray(message.rows) ? message.rows.map(r => ({ id: String(r.id || ''), to: String(r.to || ''), subject: String(r.subject || ''), message: String(r.message || '') })) : [] })); break;
      case 'send': sendResponse(await api('/api/extension/send', { batchId: String(message.batchId || ''), confirmed: true })); break;
      case 'bounces': sendResponse(await api('/api/extension/bounces', { batchId: String(message.batchId || '') })); break;
      case 'run-start': sendResponse(await api('/api/extension/run/start', { batchId: String(message.batchId || ''), confirmed: true })); break;
      case 'run-status': sendResponse(await api('/api/extension/run?id=' + encodeURIComponent(String(message.id || '')))); break;
      case 'run-active': sendResponse(await api('/api/extension/run/active')); break;
      case 'run-resume': sendResponse(await api('/api/extension/run/resume', { runId: String(message.id || '') })); break;
      case 'remove': sendResponse(await api('/api/extension/remove', { batchId: String(message.batchId || ''), contactId: String(message.contactId || '') })); break;
      case 'run-stop': sendResponse(await api('/api/extension/run/stop', { runId: String(message.id || '') })); break;
      case 'open-app': await chrome.tabs.create({ url: BASE + (message.path || '/') }); sendResponse({ ok: true }); break;
      default: sendResponse({ error: 'Unknown request.' });
    }
  })();
  return true;
});
