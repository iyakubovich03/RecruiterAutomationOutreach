import assert from 'node:assert/strict';
const base='http://localhost:3000';
const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/first role/);
const status=await fetch(base+'/api/status');assert.equal(status.status,200);const data=await status.json();
assert.equal(typeof data.configured,'boolean');assert.equal(data.redirect,base+'/api/auth/callback');
assert.equal('tokens' in data,false);assert.equal('client_secret' in data,false);
for (const path of ['/.env.local','/.local-data/workspace.json']) { const response=await fetch(base+path);assert.ok([403,404].includes(response.status),`${path} must be inaccessible`);await response.body?.cancel(); }
console.log('PASS: local page, API status, callback configuration, and private-file protection.');
