/* global chrome */
const $ = id => document.getElementById(id);
const ask = message => new Promise(resolve => chrome.runtime.sendMessage(message, response => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : response)));

async function refresh() {
  const { extensionToken } = await chrome.storage.local.get('extensionToken');
  $('token').value = extensionToken || '';
  const status = await ask({ type: 'status' });
  const box = $('status');
  if (status.error) { box.innerHTML = `<div class="alert"></div>`; box.firstChild.textContent = status.error; $('run').disabled = true; return; }
  const line = (label, ok, text) => `<li><span>${label}</span><span class="${ok ? 'ok' : 'bad'}">${text}</span></li>`;
  box.innerHTML = '<ul>' + line('App', true, 'running on localhost:3000') + line('Gmail', status.connected, status.connected ? status.account : 'not connected') + line('Resume', !!status.resume, status.resume ? status.resume.filename : 'not uploaded') + line('Default email', status.template, status.template ? 'saved' : 'not set') + line('Search API', status.searchProviders.length > 0, status.searchProviders[0] || 'no key') + '</ul>';
  $('run').disabled = !(status.connected && status.resume && status.template && status.searchProviders.length);
}
$('save').addEventListener('click', async () => { await chrome.storage.local.set({ extensionToken: $('token').value.trim() }); await refresh(); });
$('open').addEventListener('click', () => ask({ type: 'open-app', path: '/' }));
$('run').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:/.test(tab.url || '')) { $('status').insertAdjacentHTML('beforeend', '<div class="alert">Open a normal https page first, then run from here.</div>'); return; }
  chrome.tabs.sendMessage(tab.id, { type: 'open-panel', company: $('company').value.trim() }, () => { if (chrome.runtime.lastError) $('status').insertAdjacentHTML('beforeend', '<div class="alert">Reload this page once so the extension can attach to it, then try again.</div>'); else window.close(); });
});
refresh();
