import assert from 'node:assert/strict';
import test from 'node:test';
test('built app renders the local workspace shell without starter metadata',async()=>{
 const { default:worker }=await import('../dist/server/index.js');
 const response=await worker.fetch(new Request('http://localhost/',{headers:{accept:'text/html'}}),{ASSETS:{fetch:async()=>new Response('Not found',{status:404})}},{waitUntil(){},passThroughOnException(){}});
 assert.equal(response.status,200);const html=await response.text();
 assert.match(html,/Recruiter Outreach/);assert.doesNotMatch(html,/First Role/i);assert.match(html,/Find recruiters/);assert.doesNotMatch(html,/codex-preview|react-loading-skeleton|Your site is taking shape/);
});
