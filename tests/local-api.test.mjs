import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidates, domainOf, mimeMessage, htmlBody } from '../server/core.mjs';
const part=(raw,type)=>{const m=raw.match(new RegExp('Content-Type: '+type.replace('/','\\/')+'[^]*?\\r\\n\\r\\n([^]*?)\\r\\n--'));return Buffer.from(m[1].replaceAll('\r\n',''),'base64').toString();};
import { createLocalApi, CALLBACK } from '../server/local-api.mjs';
import { buildBatch } from '../server/batch.mjs';
import { automaticRecipients } from '../app/outreach.mjs';
function harness(seed, services = { findPatterns: async domain=>({domain,checkedAt:new Date().toISOString(),reportedPatterns:[],sources:[],warnings:[]}) }) {
  const dir=mkdtempSync(join(tmpdir(),'recruiter-test-'));
  if(seed)writeFileSync(join(dir,'workspace.json'),JSON.stringify(seed));
  const api=createLocalApi(()=>({GOOGLE_CLIENT_ID:'dummy',GOOGLE_CLIENT_SECRET:'dummy'}),dir,services);
  let cookie='',csrf='';
  return { dir, async call(path,body,headers={}) {
    const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);
    req.url='/api/'+path;req.method=body===undefined?'GET':'POST';
    req.headers={host:'localhost:3000',cookie,...(body!==undefined?{origin:'http://localhost:3000','content-type':'application/json','x-csrf-token':csrf}:{}),...headers};
    const out={status:200,headers:{},body:null};
    const res={set statusCode(s){out.status=s},setHeader(k,v){out.headers[k]=v},end(v){out.body=v?JSON.parse(v):null}};
    await api(req,res,()=>assert.fail('Unexpected fallthrough'));
    if(out.headers['Set-Cookie'])cookie=out.headers['Set-Cookie'].split(';')[0];
    if(out.body?.csrf)csrf=out.body.csrf;
    return out;
  }};
}
test('deduplicates candidates and preserves imported-address evidence',()=>{
  const c=candidates('Jane Smith','https://www.example.com','Contact Jane: Jane.Smith@example.com');
  assert.equal(c[0].email,'jane.smith@example.com');assert.equal(c[0].format,'Imported address');
  assert.equal(c.filter(x=>x.email==='jane.smith@example.com').length,1);
  assert.ok(c.every(x=>x.status==='unverified'));
  assert.throws(()=>domainOf('localhost')); assert.throws(()=>candidates('Jane','example.com'));
});
test('MIME supports Unicode and rejects header injection and unresolved placeholders',()=>{
  const payload={to:'jane@example.com',from:'me@example.org',subject:'Hello, résumé',message:'Hi Jane,\n你好'};
  const raw=Buffer.from(mimeMessage(payload),'base64url').toString();
  assert.match(raw,/Content-Type: multipart\/alternative; boundary="alt_[0-9a-f]+"/);
  assert.equal(part(raw,'text/plain'),payload.message);
  assert.equal(part(raw,'text/html'),htmlBody(payload.message));
  assert.equal(htmlBody('Hi <Jane> & co,\nline two\n\nSecond paragraph'),'<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124"><p style="margin:0 0 1em">Hi &lt;Jane&gt; &amp; co,<br>line two</p><p style="margin:0 0 1em">Second paragraph</p></div>');
  assert.match(htmlBody('LinkedIn: https://www.linkedin.com/in/jane-smith/. Site (www.example.com) or me@example.org.'),/<a href="https:\/\/www\.linkedin\.com\/in\/jane-smith\/" style="color:#1a73e8">https:\/\/www\.linkedin\.com\/in\/jane-smith\/<\/a>\. Site \(<a href="https:\/\/www\.example\.com"[^>]*>www\.example\.com<\/a>\) or <a href="mailto:me@example\.org"[^>]*>me@example\.org<\/a>\./);
  assert.equal(htmlBody('see https://x.com/?a=1&b=<2>'),'<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124"><p style="margin:0 0 1em">see <a href="https://x.com/?a=1&amp;b=" style="color:#1a73e8">https://x.com/?a=1&amp;b=</a>&lt;2&gt;</p></div>');
  assert.throws(()=>mimeMessage({...payload,to:'jane@example.com\r\nBcc: victim@example.com'}));
  assert.throws(()=>mimeMessage({...payload,subject:'Hi\r\nBcc: victim@example.com'}));
  assert.throws(()=>mimeMessage({...payload,message:'Hi {first_name}'}));
});
test('blocks foreign origins, host rebinding, and missing CSRF tokens',async()=>{
  const h=harness();await h.call('status');
  assert.equal((await h.call('contacts',{}, {origin:'https://evil.example'})).status,403);
  assert.equal((await h.call('contacts',{}, {'x-csrf-token':''})).status,403);
  assert.equal((await h.call('status',undefined,{host:'evil.example:3000'})).status,403);
});
test('OAuth uses fixed redirect, state, PKCE, and send scope; callback rejects bad state',async()=>{
  const h=harness();const initial=await h.call('status');assert.equal(initial.body.configured,true);
  assert.equal(JSON.stringify(initial.body).includes('dummy'),false);
  const auth=await h.call('auth/start',{});const url=new URL(auth.body.url);
  assert.equal(url.searchParams.get('redirect_uri'),CALLBACK);assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.match(url.searchParams.get('scope'),/gmail.send/);assert.doesNotMatch(url.searchParams.get('scope'),/gmail.readonly/);
  assert.ok(url.searchParams.get('state').length>30);
  const callback=await h.call('auth/callback?state=wrong&code=anything');assert.equal(callback.headers.Location,'/?auth=invalid_state');
});
test('imports contacts, prevents duplicates, validates selection, persists data',async()=>{
  const h=harness();await h.call('status');
  const result=await h.call('contacts',{name:'Jane Smith',company:'Example',domain:'example.com',title:'University recruiter',sourceText:'jane.smith@example.com'});
  assert.equal(result.status,200);const c=result.body.contact;
  assert.equal(c.focus,'Early careers');assert.equal(c.selected,null);
  assert.equal((await h.call('contacts',{name:'Jane Smith',company:'Example',domain:'example.com'})).status,409);
  assert.equal((await h.call('contacts/select',{id:c.id,email:'unrelated@example.com'})).status,400);
  assert.equal((await h.call('contacts/select',{id:c.id,email:c.candidates[0].email})).status,200);
  const disk=JSON.parse(readFileSync(join(h.dir,'workspace.json'),'utf8'));assert.equal(disk.contacts[0].selected,'jane.smith@example.com');
  assert.equal((await h.call('send',{id:c.id,to:c.candidates[0].email,confirmed:true})).status,401);
});
test('profile fetch rejects arbitrary URLs without making a network request',async()=>{
  const h=harness();await h.call('status');
  for(const url of ['http://localhost:22','https://127.0.0.1','https://www.linkedin.com:444/in/jane','https://www.linkedin.com@evil.example/in/jane']) assert.equal((await h.call('profile',{url})).status,400);
});
function seed() { return { contacts:[{id:'jane',name:'Jane Smith',selected:'jane@example.com'}],history:[],template:{},tokens:{email:'me@example.org',access_token:'test-token',expires:Date.now()+3600000} }; }
function batchSeed() {
 const data=seed();data.contacts=[{id:'jane',name:'Jane Smith',company:'Example',selected:null,candidates:[{email:'jane@example.com'}]},{id:'alex',name:'Alex Chen',company:'Example',selected:null,candidates:[{email:'alex@example.com'}]}];return data;
}
const batchBody={recipients:[{id:'jane',to:'jane@example.com'},{id:'alex',to:'alex@example.com'}],subject:'Opportunities at {company}',message:'Hi {first_name},\nThis is for {full_name} at {email}.'};
test('outreach automatically includes the whole search with top-ranked addresses, ignoring old manual selections',()=>{
 const contacts=batchSeed().contacts;
 contacts[0].selected='obsolete@example.com';
 contacts.push({id:'unrelated',name:'Other Recruiter',candidates:[{email:'other@example.com'}]});
 const rows=automaticRecipients(contacts,['jane','alex'],[]);
 assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.email),['jane@example.com','alex@example.com']);assert.ok(rows.every(r=>!r.skipped));
});
test('automatic outreach skips previously contacted and duplicate addresses without asking for selection',()=>{
 const contacts=batchSeed().contacts;
 contacts.push({id:'duplicate',name:'Duplicate Person',candidates:[{email:'alex@example.com'}]});
 const rows=automaticRecipients(contacts,['jane','alex','duplicate'],[{contactId:'jane',to:'jane@example.com',status:'sent'}]);
 assert.deepEqual(rows.map(r=>r.skipped),['Already contacted or pending','','Duplicate email address']);
});
test('batch preview personalizes all messages and rejects duplicate addresses and unknown placeholders',()=>{
 const data=batchSeed();const rows=buildBatch(batchBody.recipients,data.contacts,[],data.tokens.email,batchBody.subject,batchBody.message);
 assert.equal(rows[0].subject,'Opportunities at Example');assert.equal(rows[1].message,'Hi Alex,\nThis is for Alex Chen at alex@example.com.');
 assert.throws(()=>buildBatch([batchBody.recipients[0],batchBody.recipients[0]],data.contacts,[],data.tokens.email,'Hi','Message'),/only once/);
 assert.throws(()=>buildBatch(batchBody.recipients,data.contacts,[],data.tokens.email,'Hi','Hello {unknown}'),/placeholders/);
});
test('batch sends exactly the immutable preview, one message per person, once',async t=>{
 const messages=[];t.mock.method(globalThis,'fetch',async(url,opts)=>{messages.push(Buffer.from(JSON.parse(opts.body).raw,'base64url').toString());return Response.json({id:'gmail-'+messages.length});});
 const h=harness(batchSeed());await h.call('status');const prepared=await h.call('batch/prepare',batchBody);
 assert.equal(prepared.status,200);assert.equal(messages.length,0);const batch=prepared.body.batch;
 assert.equal((await h.call('batch/send',{batchId:batch.id})).status,400);
 const sent=await h.call('batch/send',{batchId:batch.id,confirmed:true,message:'Ignore reviewed content'});
 assert.equal(sent.body.batch.status,'complete');assert.equal(messages.length,2);
 assert.match(messages[0],/To: jane@example.com/);assert.doesNotMatch(messages[0],/alex@example.com/);
 assert.equal(part(messages[1],'text/plain'),batch.rows[1].message);
 assert.equal((await h.call('batch/send',{batchId:batch.id,confirmed:true})).status,409);
 assert.equal((await h.call('batch/prepare',batchBody)).status,400);
});
test('MIME attachments use multipart/mixed with the original bytes and enforce the size limit',()=>{
  const content=Buffer.from('%PDF-1.4 fake resume bytes');
  const raw=Buffer.from(mimeMessage({to:'jane@example.com',from:'me@example.org',subject:'Hi',message:'Body',attachment:{filename:'Jane "Resume".pdf',type:'application/pdf',content}}),'base64url').toString();
  assert.match(raw,/Content-Type: multipart\/mixed; boundary="part_[0-9a-f]+"/);
  assert.match(raw,/Content-Disposition: attachment; filename="Jane Resume.pdf"/);
  const boundary=raw.match(/boundary="([^"]+)"/)[1], parts=raw.split('--'+boundary).slice(1,-1);
  assert.equal(parts.length,2);
  assert.match(parts[0],/^\r\nContent-Type: multipart\/alternative/);assert.equal(part(parts[0],'text/plain'),'Body');
  assert.deepEqual(Buffer.from(parts[1].split('\r\n\r\n')[1].replaceAll('\r\n',''),'base64'),content);
  assert.throws(()=>mimeMessage({to:'jane@example.com',from:'me@example.org',subject:'Hi',message:'Body',attachment:{filename:'big.pdf',type:'application/pdf',content:Buffer.alloc(5*1024*1024+1)}}),/5 MB/);
});
test('resume is stored locally, attached to batches on request, and validated',async t=>{
  const messages=[];t.mock.method(globalThis,'fetch',async(url,opts)=>{messages.push(Buffer.from(JSON.parse(opts.body).raw,'base64url').toString());return Response.json({id:'gmail-'+messages.length});});
  const h=harness(batchSeed());await h.call('status');
  assert.equal((await h.call('resume',{filename:'malware.exe',type:'application/octet-stream',data:Buffer.from('MZ').toString('base64')})).status,400);
  assert.equal((await h.call('resume',{filename:'notes.pdf',type:'application/pdf',data:Buffer.from('plain text').toString('base64')})).status,400);
  assert.equal((await h.call('batch/prepare',{...batchBody,attachResume:true})).status,409);
  const saved=await h.call('resume',{filename:'Jane Resume.pdf',type:'application/pdf',data:Buffer.from('%PDF-1.7 resume').toString('base64')});
  assert.equal(saved.status,200);assert.equal(saved.body.resume.filename,'Jane Resume.pdf');assert.equal(saved.body.resume.size,15);
  assert.equal(readFileSync(join(h.dir,'resume.bin'),'utf8'),'%PDF-1.7 resume');
  const status=await h.call('status');assert.equal(status.body.resume.filename,'Jane Resume.pdf');assert.equal(JSON.stringify(status.body).includes('data'),false);
  const prepared=await h.call('batch/prepare',{...batchBody,attachResume:true});assert.equal(prepared.body.batch.attachment,'Jane Resume.pdf');
  const sent=await h.call('batch/send',{batchId:prepared.body.batch.id,confirmed:true});assert.equal(sent.body.batch.status,'complete');
  assert.equal(messages.length,2);assert.match(messages[0],/multipart\/mixed/);assert.match(messages[0],/filename="Jane Resume.pdf"/);
  assert.equal((await h.call('status')).body.history[0].attachment,'Jane Resume.pdf');
  assert.equal((await h.call('resume/remove',{})).status,200);assert.equal((await h.call('status')).body.resume,null);
});
test('test sends personalize the editor text for any address and are flagged as tests',async t=>{
  const messages=[];t.mock.method(globalThis,'fetch',async(url,opts)=>{messages.push(Buffer.from(JSON.parse(opts.body).raw,'base64url').toString());return Response.json({id:'gmail-test'});});
  const h=harness(batchSeed());await h.call('status');
  const body={to:'me@example.org',company:'Acme',name:'Sam Rivera',subject:'Roles at {company}',message:'Hi {first_name}, I am interested in {company}.'};
  assert.equal((await h.call('test-send',{...body,to:'not-an-email'})).status,400);
  assert.equal((await h.call('test-send',{...body,attachResume:true})).status,409);
  const sent=await h.call('test-send',body);assert.equal(sent.status,200);assert.equal(sent.body.record.status,'sent');assert.equal(sent.body.record.test,true);
  assert.match(messages[0],/To: me@example.org/);
  assert.equal(part(messages[0],'text/plain'),'Hi Sam, I am interested in Acme.');
  assert.equal((await h.call('test-send',body)).status,200);
  const status=await h.call('status');assert.equal(status.body.history.length,2);assert.ok(status.body.history.every(r=>r.test===true&&r.contactId===null));
  const offline=seed();offline.tokens=null;const unconnected=harness(offline);await unconnected.call('status');assert.equal((await unconnected.call('test-send',body)).status,401);
});
test('batch stops on uncertainty and leaves later recipients unattempted',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Network timeout');});
 const h=harness(batchSeed());await h.call('status');const {body}=await h.call('batch/prepare',batchBody);
 const sent=await h.call('batch/send',{batchId:body.batch.id,confirmed:true});
 assert.equal(calls,1);assert.equal(sent.body.batch.status,'stopped');assert.deepEqual(sent.body.batch.rows.map(r=>r.status),['uncertain','not_started']);
 const status=await h.call('status');assert.equal(status.body.history[0].status,'uncertain');assert.equal(status.body.batches[0].owner,undefined);
});
test('whole batch validates before any sending; interrupted batches cannot restart',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({id:'not-expected'});});
 const data=batchSeed();data.batches=[{id:'old',status:'sending',rows:[{id:'jane',status:'pending'},{id:'alex',status:'not_started'}]}];
 const h=harness(data);await h.call('status');const status=await h.call('status');assert.equal(status.body.batches[0].status,'interrupted');
 const result=await h.call('batch/prepare',{...batchBody,recipients:[batchBody.recipients[0],{id:'alex',to:'wrong@example.com'}]});assert.equal(result.status,400);assert.equal(calls,0);
});
test('Gmail submission is recorded once and duplicate outreach is blocked',async t=>{
  let count=0;t.mock.method(globalThis,'fetch',async(url)=>{assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');count++;return Response.json({id:'gmail-test-id'});});
  const h=harness(seed());await h.call('status');const body={id:'jane',to:'jane@example.com',subject:'Hello',message:'An introduction.',confirmed:true};
  assert.equal((await h.call('send',{...body,confirmed:false})).status,400);
  assert.equal((await h.call('send',body)).body.record.status,'sent');
  assert.equal((await h.call('send',body)).status,409);assert.equal(count,1);
});
test('ambiguous network failure is persisted and never automatically retried',async t=>{
  let count=0;t.mock.method(globalThis,'fetch',async()=>{count++;throw new Error('Timeout');});
  const h=harness(seed());await h.call('status');const body={id:'jane',to:'jane@example.com',subject:'Hello',message:'An introduction.',confirmed:true};
  assert.equal((await h.call('send',body)).status,502);
  assert.equal((await h.call('status')).body.history[0].status,'uncertain');
  assert.equal((await h.call('send',body)).status,409);assert.equal(count,1);
});

test('URL import returns parsed name and published email evidence through the API',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('<title>Jane Smith - University Recruiter at Example | LinkedIn</title><main><h1>Jane Smith</h1><a href="mailto:jane@example.com">Email</a></main>',{headers:{'Content-Type':'text/html'}}));
 const h=harness();await h.call('status');const out=await h.call('profile',{url:'https://www.linkedin.com/in/jane-smith'});
 assert.equal(out.status,200);assert.equal(out.body.name,'Jane Smith');assert.equal(out.body.company,'Example');assert.equal(out.body.domain,'example.com');assert.equal(out.body.extraction.method,'Profile heading');
});

test('company search and bulk save work without opening individual profiles; duplicates are skipped',async t=>{
 t.mock.method(globalThis,'fetch',async url=>String(url).includes('duckduckgo.com/html')?new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Example | LinkedIn</a><div class="result__snippet">Recruiter at Example</div></div>'):new Response('Blocked',{status:403}));
 const h=harness();await h.call('status');const out=await h.call('discover',{company:'Example',domain:'example.com'});
 assert.equal(out.status,200);assert.equal(out.body.results.length,1);
 const body={domain:'example.com',sources:[out.body.results[0].source]};
 assert.equal((await h.call('discover/save',{...body,sources:['https://evil.example']})).status,400);
 assert.equal((await h.call('discover/save',body)).body.saved,1);
 assert.equal((await h.call('discover/save',body)).body.skipped,1);
 const status=await h.call('status');assert.equal(status.body.contacts[0].selected,null);assert.equal(status.body.contacts[0].candidates.length,6);
});

test('company search automatically researches patterns and passes ranked emails to outreach',async t=>{
 t.mock.method(globalThis,'fetch',async url=>String(url).includes('duckduckgo.com/html')?new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Example | LinkedIn</a></div>'):new Response('Blocked',{status:403}));
 let researchCalls=0;const h=harness(undefined,{findPatterns:async domain=>{researchCalls++;return {domain,checkedAt:new Date().toISOString(),reportedPatterns:[{format:'flast',percentage:60,source:'https://rocketreach.co/example-email-format_123'}],sources:[],warnings:[]};}});
 await h.call('status');const result=await h.call('discover',{company:'Example',domain:'example.com'});
 assert.equal(researchCalls,1);assert.equal(result.body.results[0].candidates[0].email,'jsmith@example.com');assert.equal(result.body.results[0].candidates[0].status,'unverified');
 await h.call('discover',{company:'Example',domain:'example.com'});assert.equal(researchCalls,1);
 const saved=await h.call('discover/save',{sources:[result.body.results[0].source],domain:'example.com'});
 assert.equal(saved.body.contactIds.length,1);const status=await h.call('status');assert.equal(status.body.contacts[0].candidates[0].email,'jsmith@example.com');
});

test('company-only search resolves the domain and prepares emails without manual domain input',async t=>{
 t.mock.method(globalThis,'fetch',async url=>String(url).includes('duckduckgo.com/html')?new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Example | LinkedIn</a></div>'):new Response('Blocked',{status:403}));
 const h=harness(undefined,{discoverCompanyDomain:async()=>({domain:'examplehq.com',status:'published',sources:['https://examplehq.com'],message:'Published company email domain'}),findPatterns:async domain=>({domain,checkedAt:new Date().toISOString(),reportedPatterns:[],sources:[],warnings:[]})});
 await h.call('status');const result=await h.call('discover',{company:'Example'});
 assert.equal(result.status,200);assert.equal(result.body.domain,'examplehq.com');assert.equal(result.body.results[0].candidates[0].email,'jane.smith@examplehq.com');
 const saved=await h.call('discover/save',{sources:result.body.results.map(r=>r.source)});assert.equal(saved.status,200);assert.equal(saved.body.saved,1);
});

test('profile discovery runs first; zero matches skips domain and pattern research with diagnostics',async t=>{
 t.mock.method(globalThis,'fetch',async url=>new Response(String(url).includes('bing.com')?'<rss><channel/></rss>':'<html>No results</html>'));
 const h=harness(undefined,{discoverCompanyDomain:async()=>assert.fail('No profiles: must skip domain'),findPatterns:async()=>assert.fail('No profiles: must skip formats')});
 await h.call('status');const result=await h.call('discover',{company:'Example'});
 assert.equal(result.status,200);assert.equal(result.body.results.length,0);assert.equal(result.body.domainResolution.status,'skipped');
 assert.ok(result.body.diagnostics.events.some(e=>e.stage==='Recruiter discovery'&&e.status==='empty'));
});
test('fresh recruiter search reuses unexpired company format evidence',async t=>{
 t.mock.method(globalThis,'fetch',async url=>String(url).includes('duckduckgo.com/html')?new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - Recruiter at Example | LinkedIn</a></div>'):new Response('Blocked',{status:403}));
 let calls=0;const h=harness(undefined,{findPatterns:async domain=>{calls++;return {domain,checkedAt:new Date().toISOString(),reportedPatterns:[{format:'last.first',percentage:90,source:'https://rocketreach.co/example-email-format_123'}],sources:[],warnings:[]};}});
 await h.call('status');await h.call('discover',{company:'Example',domain:'example.com'});await h.call('discover',{company:'Example',domain:'example.com',fresh:true});assert.equal(calls,1);
});
test('multiple candidate mode requires explicit preparation and still rejects duplicate or uncertain addresses',async t=>{
 const data=batchSeed();data.contacts[0].candidates.push({email:'jane.smith@example.com'});
 const recipients=[{id:'jane',to:'jane@example.com'},{id:'jane',to:'jane.smith@example.com'}];
 assert.throws(()=>buildBatch(recipients,data.contacts,[],data.tokens.email,'Hello','Hi'),/only once/);
 assert.equal(buildBatch(recipients,data.contacts,[],data.tokens.email,'Hello','Hi',true).length,2);
 assert.throws(()=>buildBatch(recipients,data.contacts,[{contactId:'jane',to:'another@example.com',status:'uncertain'}],data.tokens.email,'Hello','Hi',true),/already exists/);
 let sent=0;t.mock.method(globalThis,'fetch',async()=>Response.json({id:'message-'+(++sent)}));
 const h=harness(data);await h.call('status');const preview=await h.call('batch/prepare',{recipients,subject:'Hello',message:'Hi {first_name}',multipleCandidates:true});
 assert.equal(preview.body.batch.multipleCandidates,true);
 const result=await h.call('batch/send',{batchId:preview.body.batch.id,confirmed:true});assert.equal(result.body.batch.status,'complete');assert.equal(sent,2);
 assert.equal((await h.call('batch/prepare',{recipients,subject:'Hello',message:'Hi',multipleCandidates:true})).status,400);
});
