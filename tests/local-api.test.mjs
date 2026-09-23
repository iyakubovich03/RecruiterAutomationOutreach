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
function harness(seed, services = { findPatterns: async domain=>({domain,checkedAt:new Date().toISOString(),reportedPatterns:[],sources:[],warnings:[]}), findRocketReachCompany: async()=>null }) {
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
test('extension token gates the extension API both ways',async()=>{
  const h=harness(batchSeed());const status=await h.call('status');const token=status.body.extensionToken;
  assert.match(token,/^[a-f0-9]{64}$/);assert.match(status.body.extensionPath,/extension$/);
  assert.equal((await h.call('extension/status')).status,403);
  assert.equal((await h.call('extension/status',undefined,{'x-extension-token':'wrong'})).status,403);
  assert.equal((await h.call('status',undefined,{'x-extension-token':token})).status,403);
  const ok=await h.call('extension/status',undefined,{'x-extension-token':token});
  assert.equal(ok.status,200);assert.equal(ok.body.connected,true);assert.equal(ok.body.template,false);assert.equal(ok.body.resume,null);
  assert.equal(JSON.stringify(ok.body).includes(token),false);
});
test('extension preview runs the pipeline, always attaches the resume, and sends only on confirmation',async t=>{
  const messages=[];
  t.mock.method(globalThis,'fetch',async(url,opts)=>{const u=String(url);if(u.includes('duckduckgo.com/html'))return new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Example | LinkedIn</a><div class="result__snippet">Recruiter at Example</div></div>');if(u.includes('gmail.googleapis.com')){messages.push(Buffer.from(JSON.parse(opts.body).raw,'base64url').toString());return Response.json({id:'gmail-'+messages.length});}return new Response('Blocked',{status:403});});
  const data=batchSeed();data.template={subject:'Roles at {company}',message:'Hi {first_name}, my resume is attached.'};data.resume={filename:'Resume.pdf',type:'application/pdf',size:15,savedAt:'2026-09-17T00:00:00.000Z'};
  const h=harness(data,{discoverCompanyDomain:async()=>({domain:'example.com',status:'published',sources:[],message:'Published'}),findPatterns:async domain=>({domain,checkedAt:new Date().toISOString(),reportedPatterns:[{format:'flast',percentage:60,source:'https://rocketreach.co/example-email-format_1'}],sources:[],warnings:[]})});
  writeFileSync(join(h.dir,'resume.bin'),'%PDF-1.7 resume');
  const token=(await h.call('status')).body.extensionToken;const ext={'x-extension-token':token};
  assert.equal((await h.call('extension/preview',{company:'X'},ext)).status,400);
  const preview=await h.call('extension/preview',{company:'Example'},ext);
  assert.equal(preview.status,200);assert.equal(preview.body.reason,'');
  assert.equal(preview.body.discovery.results[0].name,'Jane Smith');assert.equal(preview.body.discovery.topFormat.format,'flast');
  assert.deepEqual(preview.body.recipients,[{name:'Jane Smith',company:'Example',email:'jsmith@example.com',skipped:''}]);
  assert.equal(preview.body.batch.attachment,'Resume.pdf');assert.equal(preview.body.batch.rows[0].message,'Hi Jane, my resume is attached.');assert.equal(preview.body.batch.owner,undefined);
  assert.equal((await h.call('batch/send',{batchId:preview.body.batch.id,confirmed:true})).status,409);
  assert.equal((await h.call('extension/send',{batchId:preview.body.batch.id},ext)).status,400);
  const sent=await h.call('extension/send',{batchId:preview.body.batch.id,confirmed:true},ext);
  assert.equal(sent.status,200,JSON.stringify(sent.body));assert.equal(sent.body.batch.status,'complete');assert.equal(messages.length,1);assert.match(messages[0],/multipart\/mixed/);assert.match(messages[0],/filename="Resume.pdf"/);
  const again=await h.call('extension/preview',{company:'Example'},ext);
  assert.equal(again.body.batch,null);assert.match(again.body.reason,/already contacted/);assert.equal(again.body.recipients[0].skipped,'Already contacted or pending');
  const progress=await h.call('extension/progress',undefined,ext);assert.equal(progress.body.company,'Example');assert.equal(progress.body.running,false);
  data.resume=null;const noResume=harness(data);const t2=(await noResume.call('status')).body.extensionToken;
  assert.equal((await noResume.call('extension/preview',{company:'Example'},{'x-extension-token':t2})).status,409);
});
test('extension preview uses the application page domain when it has mail servers, and the profiles’ spelling of the company',async t=>{
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('duckduckgo.com/html')?new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Scale AI | LinkedIn</a></div>'):new Response('Blocked',{status:403}));
  const data=batchSeed();data.template={subject:'Roles at {company}',message:'Hi {first_name}'};data.resume={filename:'r.pdf',type:'application/pdf',size:5,savedAt:'2026-09-17T00:00:00.000Z'};
  const searched=[],patterned=[];
  const h=harness(data,{discoverCompanyDomain:async company=>{searched.push(company);return {domain:'scale.com',status:'inferred',sources:[],message:'Searched'};},findPatterns:async(domain,read,options)=>{patterned.push([domain,options.company]);return {domain,checkedAt:new Date().toISOString(),reportedPatterns:[],sources:[],warnings:[]};},resolveMx:async domain=>domain==='scale.com'?[{exchange:'mx.scale.com'}]:[]});
  writeFileSync(join(h.dir,'resume.bin'),'%PDF-1.7');
  const ext={'x-extension-token':(await h.call('status')).body.extensionToken};
  const hinted=await h.call('extension/preview',{company:'Scaleai',siteHint:'careers.scale.com',pageUrl:'https://careers.scale.com/thanks'},ext);
  assert.equal(hinted.status,200,JSON.stringify(hinted.body));assert.equal(hinted.body.discovery.domain,'scale.com');assert.match(hinted.body.discovery.domainMessage,/application page/);
  assert.equal(hinted.body.discovery.company,'Scale AI');assert.deepEqual(searched,[]);assert.deepEqual(patterned,[['scale.com','Scale AI']]);
  assert.equal(hinted.body.batch.rows[0].subject,'Roles at Scale AI');
  const atsHint=await h.call('extension/preview',{company:'Scaleai',fresh:true,siteHint:'jobs.lever.co',pageUrl:'https://jobs.lever.co/scaleai/1/thanks'},ext);
  assert.deepEqual(searched,['Scale AI']);assert.equal(atsHint.body.discovery.domain,'scale.com');
  const noMail=await h.call('extension/preview',{company:'Scaleai',fresh:true,siteHint:'nomail.example'},ext);
  assert.equal(noMail.status,200);assert.equal(searched.length,2);
  assert.ok(atsHint.body.discovery.results.length>=1);
});
test('re-searching a company refreshes already-saved recruiters with the corrected company name, domain, and addresses',async t=>{
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('duckduckgo.com/html')?new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Scale AI | LinkedIn</a></div>'):new Response('Blocked',{status:403}));
  let domain='scaleai.ca';
  const h=harness(undefined,{findRocketReachCompany:async()=>null,discoverCompanyDomain:async()=>({domain,status:'inferred',sources:[],message:'Searched'}),findPatterns:async d=>({domain:d,checkedAt:new Date().toISOString(),reportedPatterns:[{format:'first.last',percentage:90,source:'https://rocketreach.co/x-email-format_1'}],sources:[],warnings:[]})});
  await h.call('status');
  const first=await h.call('discover',{company:'Scaleai'});const saved=await h.call('discover/save',{sources:first.body.results.map(r=>r.source)});
  assert.equal(saved.body.saved,1);const id=saved.body.contactIds[0];
  let contact=(await h.call('status')).body.contacts[0];assert.equal(contact.domain,'scaleai.ca');assert.equal(contact.candidates[0].email,'jane.smith@scaleai.ca');
  await h.call('contacts/select',{id,email:'jane.smith@scaleai.ca'});
  domain='scale.ai';
  const second=await h.call('discover',{company:'Scaleai',fresh:true});const again=await h.call('discover/save',{sources:second.body.results.map(r=>r.source)});
  assert.deepEqual([again.body.saved,again.body.refreshed,again.body.contactIds],[0,1,[id]]);
  contact=(await h.call('status')).body.contacts[0];
  assert.equal(contact.company,'Scale AI');assert.equal(contact.domain,'scale.ai');assert.equal(contact.candidates[0].email,'jane.smith@scale.ai');assert.equal(contact.selected,null);
  assert.equal((await h.call('status')).body.contacts.length,1);
});
test('typed searches take the domain RocketReach states before searching for an official website',async t=>{
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('duckduckgo.com/html')?new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Scale AI | LinkedIn</a></div>'):new Response('Blocked',{status:403}));
  const rocketUrl='https://rocketreach.co/scale-ai-email-format_1';const patterned=[];
  const h=harness(undefined,{findRocketReachCompany:async company=>company==='Scale AI'?{domain:'scale.com',source:rocketUrl,title:'Scale AI Email Format | scale.com Emails',mentions:3,urls:[rocketUrl]}:null,discoverCompanyDomain:async()=>assert.fail('RocketReach settled the domain; no website search expected'),findPatterns:async(domain,read,options)=>{patterned.push([domain,options.company,options.rocketReachUrls]);return {domain,checkedAt:new Date().toISOString(),reportedPatterns:[{format:'first',percentage:50,source:rocketUrl}],sources:[],warnings:[]};},resolveMx:async domain=>domain==='scale.com'?[{exchange:'mx.scale.com'}]:[]});
  await h.call('status');const result=await h.call('discover',{company:'Scaleai'});
  assert.equal(result.status,200);assert.equal(result.body.company,'Scale AI');assert.equal(result.body.domain,'scale.com');assert.equal(result.body.domainResolution.status,'rocketreach');
  assert.deepEqual(patterned,[['scale.com','Scale AI',[rocketUrl]]]);assert.equal(result.body.results[0].candidates[0].email,'jane@scale.com');
  const nomail=harness(undefined,{findRocketReachCompany:async()=>({domain:'scaleai.ca',source:rocketUrl,title:'x',mentions:1,urls:[rocketUrl]}),discoverCompanyDomain:async()=>({domain:'scale.com',status:'inferred',sources:[],message:'Searched'}),findPatterns:async domain=>({domain,checkedAt:new Date().toISOString(),reportedPatterns:[],sources:[],warnings:[]}),resolveMx:async()=>[]});
  await nomail.call('status');const fallback=await nomail.call('discover',{company:'Scale AI'});assert.equal(fallback.body.domain,'scale.com');assert.equal(fallback.body.domainResolution.status,'inferred');
});
test('bounced addresses are detected from Gmail headers, never retried, and the next-best address is queued',async t=>{
  const sent=[];
  t.mock.method(globalThis,'fetch',async(url,opts)=>{const u=String(url);
    if(u.endsWith('/messages/send')){const raw=Buffer.from(JSON.parse(opts.body).raw,'base64url').toString();sent.push({to:raw.match(/^To: (.+)$/m)[1],messageId:raw.match(/^Message-ID: <(.+)>$/m)[1]});return Response.json({id:'gmail-'+sent.length});}
    if(u.endsWith('/profile'))return Response.json({historyId:'1000'});
    if(u.includes('/history?'))return Response.json({history:[{messagesAdded:[{message:{id:'dsn-1'}}]},{messagesAdded:[{message:{id:'newsletter'}}]}]});
    if(u.includes('/messages/dsn-1?'))return Response.json({internalDate:String(Date.now()),payload:{headers:[{name:'From',value:'Mail Delivery Subsystem <mailer-daemon@googlemail.com>'},{name:'Subject',value:'Delivery Status Notification (Failure)'},{name:'X-Failed-Recipients',value:'jane@example.com'},{name:'In-Reply-To',value:'<'+sent[0].messageId+'>'}]}});
    if(u.includes('/messages/newsletter?'))return Response.json({internalDate:String(Date.now()),payload:{headers:[{name:'From',value:'news@example.org'},{name:'Subject',value:'Weekly digest'}]}});
    return new Response('Blocked',{status:403});});
  const data=batchSeed();data.tokens.scopes='openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata';
  data.contacts[0].candidates=[{email:'jane@example.com',format:'first',percentage:60},{email:'jsmith@example.com',format:'flast',percentage:30},{email:'jane.smith@example.com',format:'first.last',percentage:5}];
  const h=harness(data);await h.call('status');
  assert.equal((await h.call('status')).body.bounceDetection,true);
  const prepared=await h.call('batch/prepare',batchBody);const batch=prepared.body.batch;
  const done=await h.call('batch/send',{batchId:batch.id,confirmed:true});assert.equal(done.body.batch.status,'complete');assert.equal(sent.length,2);
  const grouped=await h.call('history/bounces',{contactIds:['jane','alex']});
  assert.equal(grouped.status,200,JSON.stringify(grouped.body));assert.deepEqual([grouped.body.batches,grouped.body.newlyBounced],[1,1]);
  assert.equal((await h.call('status')).body.history.find(r=>r.to==='jane@example.com').status,'bounced');
  const check=await h.call('batch/bounces',{batchId:batch.id});
  assert.equal(check.status,200,JSON.stringify(check.body));assert.equal(check.body.bounced,1);assert.equal(check.body.newlyBounced,0);
  const jane=check.body.rows.find(r=>r.id==='jane'),alex=check.body.rows.find(r=>r.id==='alex');
  assert.equal(jane.status,'bounced');assert.equal(alex.status,'sent');assert.deepEqual(jane.next,{email:'jsmith@example.com',format:'flast',percentage:30});assert.equal(alex.next,null);
  assert.equal(check.body.retryBatch.rows.length,1);assert.equal(check.body.retryBatch.rows[0].to,'jsmith@example.com');assert.equal(check.body.retryBatch.retryOf,batch.id);
  const status=await h.call('status');assert.equal(status.body.history.find(r=>r.to==='jane@example.com').status,'bounced');
  assert.equal((await h.call('batch/prepare',{...batchBody,recipients:[{id:'jane',to:'jane@example.com'}]})).status,400);
  const again=await h.call('batch/bounces',{batchId:batch.id});assert.equal(again.body.newlyBounced,0);assert.equal(again.body.bounced,1);
  const retry=await h.call('batch/send',{batchId:check.body.retryBatch.id,confirmed:true});assert.equal(retry.body.batch.status,'complete');assert.equal(sent.at(-1).to,'jsmith@example.com');
  const plain=batchSeed();const noScope=harness(plain);await noScope.call('status');assert.equal((await noScope.call('status')).body.bounceDetection,false);
  const p2=await noScope.call('batch/prepare',batchBody);await noScope.call('batch/send',{batchId:p2.body.batch.id,confirmed:true});
  assert.equal((await noScope.call('batch/bounces',{batchId:p2.body.batch.id})).status,403);
});
test('a verified run probes one recruiter per format, locks the format that sticks, emails the rest, and retries stragglers',async t=>{
  let clock=Date.now();const sent=[];let dsnFor=null;
  t.mock.method(globalThis,'fetch',async(url,opts)=>{const u=String(url);
    if(u.endsWith('/messages/send')){const raw=Buffer.from(JSON.parse(opts.body).raw,'base64url').toString();sent.push(raw.match(/^To: (.+)$/m)[1]);return Response.json({id:'g'+sent.length});}
    if(u.endsWith('/profile'))return Response.json({historyId:'1'});
    if(u.includes('/history?'))return Response.json({history:dsnFor?[{messagesAdded:[{message:{id:'dsn-'+dsnFor}}]}]:[]});
    if(u.includes('/messages/dsn-'))return Response.json({internalDate:String(clock),payload:{headers:[{name:'From',value:'mailer-daemon@googlemail.com'},{name:'Subject',value:'Delivery Status Notification (Failure)'},{name:'X-Failed-Recipients',value:dsnFor}]}});
    return new Response('Blocked',{status:403});});
  const data=batchSeed();data.tokens.scopes='openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata';
  data.contacts=[
    {id:'jane',name:'Jane Smith',company:'Example',selected:null,candidates:[{email:'jane@example.com',format:'first',percentage:60},{email:'jsmith@example.com',format:'flast',percentage:30}]},
    {id:'alex',name:'Alex Chen',company:'Example',selected:null,candidates:[{email:'alex@example.com',format:'first',percentage:60},{email:'achen@example.com',format:'flast',percentage:30}]},
    {id:'sam',name:'Sam Rivera',company:'Example',selected:null,candidates:[{email:'sam@example.com',format:'first',percentage:60}]}];
  const h=harness(data,{now:()=>clock,findRocketReachCompany:async()=>null});await h.call('status');
  const prepared=await h.call('batch/prepare',{recipients:[{id:'jane',to:'jane@example.com'},{id:'alex',to:'alex@example.com'},{id:'sam',to:'sam@example.com'}],subject:'Roles at {company}',message:'Hi {first_name}'});
  assert.equal((await h.call('run/start',{batchId:prepared.body.batch.id})).status,400);
  const started=await h.call('run/start',{batchId:prepared.body.batch.id,confirmed:true});
  assert.equal(started.status,200,JSON.stringify(started.body));let run=started.body.run;
  assert.equal(run.status,'running');assert.equal(run.stage,'probe');assert.equal(run.wave.kind,'probe');assert.deepEqual(sent,['jane@example.com']);
  assert.deepEqual(run.people.map(p=>p.outcome),['watching','queued','queued']);
  assert.equal((await h.call('batch/send',{batchId:prepared.body.batch.id,confirmed:true})).status,409);
  assert.equal((await h.call('status')).body.activeRun.id,run.id);
  dsnFor='jane@example.com';clock+=61000;run=(await h.call('run/tick',{})).body.run;
  assert.deepEqual(sent,['jane@example.com','jsmith@example.com']);assert.equal(run.stage,'probe');assert.equal(run.people[0].attempts.map(a=>a.status).join(','),'bounced,sent');
  dsnFor=null;clock+=61000;run=(await h.call('run/tick',{})).body.run;
  assert.equal(run.verifiedFormat,'flast');assert.equal(run.stage,'rest');assert.equal(run.wave.kind,'rest');
  assert.deepEqual(sent.slice(2),['achen@example.com','sam@example.com']);
  dsnFor='sam@example.com';clock+=61000;run=(await h.call('run/tick',{})).body.run;
  assert.equal(run.status,'complete',JSON.stringify(run.log));assert.deepEqual(run.summary,{reached:2,watching:0,retrying:0,exhausted:1,queued:0});
  assert.deepEqual(run.people.map(p=>p.outcome),['reached','reached','exhausted']);assert.equal(sent.length,4);
  assert.ok(run.log.some(l=>/jane@example.com bounced/.test(l.detail)));assert.ok(run.log.some(l=>/using the “flast” format/.test(l.detail)));
  assert.equal((await h.call('run/active')).body.run.id,run.id);
  const again=await h.call('batch/prepare',{recipients:[{id:'jane',to:'jsmith@example.com'}],subject:'x',message:'y'});assert.equal(again.status,400);
});
test('when every address at the saved domain bounces, a run probes the fallback domain, switches everyone, and the next search remembers it',async t=>{
  let clock=Date.now();const sent=[];const bouncing=new Set(['jane@example.com','jsmith@example.com']);
  t.mock.method(globalThis,'fetch',async(url,opts)=>{const u=String(url);
    if(u.endsWith('/messages/send')){const raw=Buffer.from(JSON.parse(opts.body).raw,'base64url').toString();sent.push(raw.match(/^To: (.+)$/m)[1]);return Response.json({id:'g'+sent.length});}
    if(u.endsWith('/profile'))return Response.json({historyId:'1'});
    if(u.includes('/history?')){const last=sent.at(-1);return Response.json({history:bouncing.has(last)?[{messagesAdded:[{message:{id:'dsn-'+last}}]}]:[]});}
    if(u.includes('/messages/dsn-')){const addr=decodeURIComponent(u.split('/messages/dsn-')[1].split('?')[0]);return Response.json({internalDate:String(clock),payload:{headers:[{name:'From',value:'mailer-daemon@googlemail.com'},{name:'Subject',value:'Delivery Status Notification (Failure)'},{name:'X-Failed-Recipients',value:addr}]}});}
    if(u.includes('duckduckgo.com/html'))return new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Example | LinkedIn</a></div>');
    return new Response('Blocked',{status:403});});
  const data=batchSeed();data.tokens.scopes='openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata';
  data.contacts=[
    {id:'jane',name:'Jane Smith',company:'Example',selected:null,domain:'example.com',alternateDomains:['alt.example'],candidates:[{email:'jane@example.com',format:'first',percentage:60},{email:'jsmith@example.com',format:'flast',percentage:30}]},
    {id:'alex',name:'Alex Chen',company:'Example',selected:null,domain:'example.com',alternateDomains:['alt.example'],candidates:[{email:'alex@example.com',format:'first',percentage:60}]}];
  const h=harness(data,{now:()=>clock,findRocketReachCompany:async()=>null,discoverCompanyDomain:async()=>assert.fail('verified domain must win'),findPatterns:async d=>({domain:d,checkedAt:new Date().toISOString(),reportedPatterns:[],sources:[],warnings:[]}),resolveMx:async()=>[{exchange:'mx.alt.example'}]});
  await h.call('status');
  const prepared=await h.call('batch/prepare',{recipients:[{id:'jane',to:'jane@example.com'},{id:'alex',to:'alex@example.com'}],subject:'Roles at {company}',message:'Hi {first_name}'});
  let run=(await h.call('run/start',{batchId:prepared.body.batch.id,confirmed:true})).body.run;
  assert.deepEqual(run.alternates,['alt.example']);assert.deepEqual(sent,['jane@example.com']);
  clock+=61000;run=(await h.call('run/tick',{})).body.run;assert.deepEqual(sent,['jane@example.com','jsmith@example.com']);
  clock+=61000;run=(await h.call('run/tick',{})).body.run;
  assert.equal(sent[2],'jane.smith@alt.example',JSON.stringify(run.log));assert.equal(run.domain,'example.com');
  clock+=61000;run=(await h.call('run/tick',{})).body.run;
  assert.equal(run.verifiedFormat,'first.last');assert.equal(run.domain,'alt.example');assert.equal(run.originalDomain,'example.com');
  assert.ok(run.log.some(l=>/Switched the email domain from example\.com to alt\.example/.test(l.detail)));
  assert.deepEqual(sent.slice(3),['alex.chen@alt.example']);
  clock+=61000;run=(await h.call('run/tick',{})).body.run;
  assert.equal(run.status,'complete');assert.deepEqual(run.people.map(p=>p.outcome),['reached','reached']);
  const contacts=(await h.call('status')).body.contacts;assert.ok(contacts.every(c=>c.domain==='alt.example'));assert.equal(contacts.find(c=>c.id==='alex').candidates[0].email,'alex.chen@alt.example');
  const again=await h.call('discover',{company:'Example',fresh:true});
  assert.equal(again.body.domain,'alt.example');assert.equal(again.body.domainResolution.status,'verified by delivery');
});
test('a domain with several bounces and no deliveries is probed after the fallback domain',async t=>{
  const sent=[];
  t.mock.method(globalThis,'fetch',async(url,opts)=>{const u=String(url);if(u.endsWith('/messages/send')){sent.push(Buffer.from(JSON.parse(opts.body).raw,'base64url').toString().match(/^To: (.+)$/m)[1]);return Response.json({id:'g'+sent.length});}if(u.endsWith('/profile'))return Response.json({historyId:'1'});if(u.includes('/history?'))return Response.json({history:[]});return new Response('Blocked',{status:403});});
  const data=batchSeed();data.tokens.scopes='openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata';
  data.history=[{id:'1',contactId:'old1',to:'a@example.com',status:'bounced',date:'2026-09-17T00:00:00Z'},{id:'2',contactId:'old2',to:'b@example.com',status:'bounced',date:'2026-09-17T00:00:00Z'},{id:'3',contactId:'old3',to:'c@example.com',status:'bounced',date:'2026-09-17T00:00:00Z'}];
  data.contacts=[{id:'jane',name:'Jane Smith',company:'Example',selected:null,domain:'example.com',alternateDomains:['alt.example'],candidates:[{email:'jane@example.com',format:'first',percentage:60}]}];
  const h=harness(data,{findRocketReachCompany:async()=>null,resolveMx:async()=>[{exchange:'mx'}]});await h.call('status');
  const prepared=await h.call('batch/prepare',{recipients:[{id:'jane',to:'jane@example.com'}],subject:'s',message:'m'});
  const run=(await h.call('run/start',{batchId:prepared.body.batch.id,confirmed:true})).body.run;
  assert.deepEqual(sent,['jane.smith@alt.example'],JSON.stringify(run.log));assert.equal(run.status,'running');
});
test('automatic recipients skip bounced addresses and report people whose every address bounced',()=>{
  const contacts=[{id:'jane',name:'Jane Smith',candidates:[{email:'a@x.com'},{email:'b@x.com'}]},{id:'alex',name:'Alex Chen',candidates:[{email:'c@x.com'}]}];
  const history=[{contactId:'jane',to:'a@x.com',status:'bounced'},{contactId:'alex',to:'c@x.com',status:'bounced'}];
  const rows=automaticRecipients(contacts,['jane','alex'],history);
  assert.deepEqual(rows.map(r=>[r.email,r.skipped]),[['b@x.com',''],['','Every address bounced']]);
  assert.equal(automaticRecipients(contacts,['jane'],[{contactId:'jane',to:'a@x.com',status:'sent'}])[0].skipped,'Already contacted or pending');
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
test('the RocketReach company lookup receives the employer text from each recruiter profile',async t=>{
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('duckduckgo.com/html')?new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Scale AI | LinkedIn</a></div>'):new Response('Blocked',{status:403}));
  const rocketUrl='https://rocketreach.co/scale-ai-email-format_1';let employers=null;
  const h=harness(undefined,{findRocketReachCompany:async(company,options)=>{employers=options.employers;return {domain:'scale.com',source:rocketUrl,title:'Scale AI Email Format | scale.com Emails',mentions:3,urls:[rocketUrl]};},discoverCompanyDomain:async()=>assert.fail('unexpected'),findPatterns:async domain=>({domain,checkedAt:new Date().toISOString(),reportedPatterns:[],sources:[],warnings:[]})});
  await h.call('status');const result=await h.call('discover',{company:'Scale AI'});
  assert.equal(result.body.domain,'scale.com');assert.equal(employers.length,1);assert.match(employers[0],/University Recruiter at Scale AI/);
});

test('any email in a draft batch can be rewritten before authorizing, and the edited text is what gets sent',async t=>{
 const messages=[];t.mock.method(globalThis,'fetch',async(url,opts)=>{messages.push(Buffer.from(JSON.parse(opts.body).raw,'base64url').toString());return Response.json({id:'gmail-'+messages.length});});
 const h=harness(batchSeed());await h.call('status');const batch=(await h.call('batch/prepare',batchBody)).body.batch;
 const jane=batch.rows[0],alex=batch.rows[1];
 const edited=await h.call('batch/update',{batchId:batch.id,rows:[{id:jane.id,to:jane.to,subject:'Quick question about Example',message:'Hi Jane,\r\nI rewrote this one by hand.\r\n'}]});
 assert.equal(edited.status,200,JSON.stringify(edited.body));assert.equal(edited.body.batch.rows[0].subject,'Quick question about Example');assert.equal(edited.body.batch.rows[0].message,'Hi Jane,\nI rewrote this one by hand.');
 assert.equal(edited.body.batch.rows[0].edited,true);assert.equal(edited.body.batch.rows[1].edited,undefined);assert.equal(edited.body.batch.owner,undefined);
 const restored=await h.call('batch/update',{batchId:batch.id,rows:[{id:alex.id,to:alex.to,subject:alex.subject,message:alex.message}]});assert.equal(restored.body.batch.rows[1].edited,false);
 for(const bad of [{id:jane.id,to:jane.to,message:'Hi {unknown}'},{id:jane.id,to:jane.to,subject:''},{id:jane.id,to:jane.to,subject:'x'.repeat(201)},{id:'nobody',to:jane.to,message:'x'},{id:jane.id,to:'other@example.com',message:'x'}]){const r=await h.call('batch/update',{batchId:batch.id,rows:[bad]});assert.equal(r.status,400,JSON.stringify(bad));}
 assert.equal((await h.call('batch/update',{batchId:batch.id,rows:[]})).status,400);
 assert.equal((await h.call('batch/update',{batchId:'missing',rows:[{id:jane.id,to:jane.to,message:'x'}]})).status,409);
 const sent=await h.call('batch/send',{batchId:batch.id,confirmed:true});assert.equal(sent.body.batch.status,'complete');
 assert.equal(part(messages[0],'text/plain'),'Hi Jane,\nI rewrote this one by hand.');assert.match(messages[0],/Subject: =\?UTF-8\?B\?/);assert.equal(part(messages[1],'text/plain'),alex.message);
 assert.equal((await h.call('batch/update',{batchId:batch.id,rows:[{id:jane.id,to:jane.to,message:'too late'}]})).status,409);
 const history=(await h.call('status')).body.history;assert.equal(history.find(r=>r.to===jane.to).message,'Hi Jane,\nI rewrote this one by hand.');
});
test('extension batches are edited through the extension route only',async t=>{
 const messages=[];
 t.mock.method(globalThis,'fetch',async(url,opts)=>{const u=String(url);if(u.includes('duckduckgo.com/html'))return new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Example | LinkedIn</a><div class="result__snippet">Recruiter at Example</div></div>');if(u.includes('gmail/v1/users/me/messages/send')){messages.push(Buffer.from(JSON.parse(opts.body).raw,'base64url').toString());return Response.json({id:'gmail-1'});}return new Response('Blocked',{status:403});});
 const data=batchSeed();data.template={subject:'Roles at {company}',message:'Hi {first_name}, my resume is attached.'};data.resume={filename:'Resume.pdf',type:'application/pdf',size:15,savedAt:'2026-09-17T00:00:00.000Z'};
 const h=harness(data,{discoverCompanyDomain:async()=>({domain:'example.com',status:'published',sources:[],message:'Published'}),findPatterns:async domain=>({domain,checkedAt:new Date().toISOString(),reportedPatterns:[],sources:[],warnings:[]}),findRocketReachCompany:async()=>null});
 writeFileSync(join(h.dir,'resume.bin'),'%PDF-1.7 resume');
 const token=(await h.call('status')).body.extensionToken;const ext={'x-extension-token':token};
 const preview=await h.call('extension/preview',{company:'Example'},ext);assert.equal(preview.status,200,JSON.stringify(preview.body));const row=preview.body.batch.rows[0];
 assert.equal((await h.call('batch/update',{batchId:preview.body.batch.id,rows:[{id:row.id,to:row.to,message:'from the web session'}]})).status,409);
 const edited=await h.call('extension/update',{batchId:preview.body.batch.id,rows:[{id:row.id,to:row.to,message:'Hi Jane, edited in the extension panel.'}]},ext);
 assert.equal(edited.status,200,JSON.stringify(edited.body));assert.equal(edited.body.batch.rows[0].message,'Hi Jane, edited in the extension panel.');assert.equal(edited.body.batch.rows[0].subject,'Roles at Example');
 const sent=await h.call('extension/send',{batchId:preview.body.batch.id,confirmed:true},ext);assert.equal(sent.status,200,JSON.stringify(sent.body));
 assert.equal(part(messages[0],'text/plain'),'Hi Jane, edited in the extension panel.');
});
test('a run moves on the moment a probe bounces instead of waiting out the watch window',async t=>{
  let clock=Date.now();const sent=[];let dsnFor=null;
  t.mock.method(globalThis,'fetch',async(url,opts)=>{const u=String(url);
    if(u.endsWith('/messages/send')){sent.push(Buffer.from(JSON.parse(opts.body).raw,'base64url').toString().match(/^To: (.+)$/m)[1]);return Response.json({id:'g'+sent.length});}
    if(u.endsWith('/profile'))return Response.json({historyId:'1'});
    if(u.includes('/history?'))return Response.json({history:dsnFor?[{messagesAdded:[{message:{id:'dsn-'+dsnFor}}]}]:[]});
    if(u.includes('/messages/dsn-'))return Response.json({internalDate:String(clock),payload:{headers:[{name:'From',value:'mailer-daemon@googlemail.com'},{name:'Subject',value:'Delivery Status Notification (Failure)'},{name:'X-Failed-Recipients',value:dsnFor}]}});
    return new Response('Blocked',{status:403});});
  const data=batchSeed();data.tokens.scopes='openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata';
  data.contacts=[{id:'jane',name:'Jane Smith',company:'Example',selected:null,candidates:[{email:'jane@example.com',format:'first',percentage:60},{email:'jsmith@example.com',format:'flast',percentage:30}]},
    {id:'alex',name:'Alex Chen',company:'Example',selected:null,candidates:[{email:'alex@example.com',format:'first',percentage:60},{email:'achen@example.com',format:'flast',percentage:30}]}];
  const h=harness(data,{now:()=>clock,findRocketReachCompany:async()=>null});await h.call('status');
  const prepared=await h.call('batch/prepare',{recipients:[{id:'jane',to:'jane@example.com'},{id:'alex',to:'alex@example.com'}],subject:'s',message:'m'});
  let run=(await h.call('run/start',{batchId:prepared.body.batch.id,confirmed:true})).body.run;assert.deepEqual(sent,['jane@example.com']);
  // The bounce lands 8 seconds in: the next format goes out on the very next check, not after 60s.
  dsnFor='jane@example.com';clock+=8000;run=(await h.call('run/tick',{})).body.run;
  assert.deepEqual(sent,['jane@example.com','jsmith@example.com'],JSON.stringify(run.log));assert.equal(run.wave.kind,'probe');
  assert.ok(run.log.some(l=>/jsmith@example\.com|bounced after 8s/.test(l.detail)));
  // An address that has not bounced is still watched for the full window before it counts as delivered.
  dsnFor=null;clock+=15000;run=(await h.call('run/tick',{})).body.run;assert.equal(run.stage,'probe');assert.equal(sent.length,2);
  clock+=50000;run=(await h.call('run/tick',{})).body.run;assert.equal(run.verifiedFormat,'flast');assert.deepEqual(sent.at(-1),'achen@example.com');
});
test('a delivery-verified domain reuses the RocketReach formats filed under the wrong domain and ranks the delivered format first',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{const u=String(url);
    if(u.includes('duckduckgo.com/html'))return new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Example | LinkedIn</a></div>');
    return new Response('Blocked',{status:403});});
  const data=batchSeed();
  data.verifiedDomains={example:{domain:'alt.example',format:'first.last',verifiedAt:'2026-09-18T15:50:55.773Z',run:'r1'}};
  data.contacts=[{id:'jane',name:'Jane Smith',company:'Example',selected:null,domain:'alt.example',candidates:[{email:'jane.smith@alt.example',format:'first.last'}]}];
  data.history=[{id:'h1',contactId:'jane',to:'jane@alt.example',status:'bounced',date:'2026-09-18T15:49:00Z'},{id:'h2',contactId:'jane',to:'jane.smith@alt.example',status:'sent',date:'2026-09-18T15:50:00Z'}];
  const patterns={format:'first',percentage:60,source:'https://rocketreach.co/example-email-format_b1',context:''};
  const researched=[];
  const h=harness(data,{
    findRocketReachCompany:async()=>({domain:'example.com',source:'https://rocketreach.co/example-email-format_b1',title:'Example Email Format | example.com Emails',pages:[{url:'https://rocketreach.co/example-email-format_b1',title:'Example Email Format | example.com Emails'}]}),
    findPatterns:async d=>{researched.push(d);return {domain:d,checkedAt:new Date().toISOString(),reportedPatterns:d==='example.com'?[patterns,{...patterns,format:'first.last',percentage:35}]:[],sources:[],warnings:[]};},
    resolveMx:async()=>[{exchange:'mx'}]});
  await h.call('status');
  const found=await h.call('discover',{company:'Example',fresh:true});
  assert.equal(found.body.domain,'alt.example');assert.equal(found.body.domainResolution.status,'verified by delivery');
  assert.deepEqual(researched,['example.com'],'formats come from the RocketReach page, never a hunt for the verified domain');
  assert.equal(found.body.patternReport.carriedFrom,'example.com');assert.equal(found.body.patternReport.verifiedFormat,'first.last');
  const top=found.body.results[0].candidates[0];
  assert.equal(top.email,'jane.smith@alt.example');assert.ok(top.verified);assert.match(top.evidence,/Delivered without a bounce on 2026-09-18/);
  assert.deepEqual(found.body.formatEvidence,{first:{sent:0,bounced:1},'first.last':{sent:1,bounced:0}});
  assert.ok(found.body.diagnostics.events.some(e=>/applying them at alt\.example/.test(e.detail)));
});
test('resuming a paused run whose probe recruiter has since been reached never emails that person again',async t=>{
  let clock=Date.now();const sent=[];
  t.mock.method(globalThis,'fetch',async(url,opts)=>{const u=String(url);if(u.endsWith('/messages/send')){sent.push(Buffer.from(JSON.parse(opts.body).raw,'base64url').toString().match(/^To: (.+)$/m)[1]);return Response.json({id:'g'+sent.length});}if(u.endsWith('/profile'))return Response.json({historyId:'1'});if(u.includes('/history?'))return Response.json({history:[]});return new Response('Blocked',{status:403});});
  const data=batchSeed();data.tokens.scopes='openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata';
  data.contacts=[{id:'jane',name:'Jane Smith',company:'Example',selected:null,domain:'example.com',candidates:[{email:'jane@example.com',format:'first',percentage:60},{email:'jane.smith@example.com',format:'first.last',percentage:30}]},
    {id:'alex',name:'Alex Chen',company:'Example',selected:null,domain:'example.com',candidates:[{email:'alex@example.com',format:'first',percentage:60},{email:'alex.chen@example.com',format:'first.last',percentage:30}]}];
  const started=new Date(clock-600000).toISOString();
  data.runs=[{id:'old',owner:'x',company:'Example',domain:'example.com',originalDomain:'example.com',probeDomain:'example.com',alternates:[],startedAt:started,finishedAt:null,template:{subject:'s',message:'m'},attachResume:false,overrides:{},people:[{id:'jane',name:'Jane Smith'},{id:'alex',name:'Alex Chen'}],probeIndex:0,stage:'probe',mode:'verified',status:'stopped',verifiedFormat:null,wave:null,log:[],error:'A send is already in progress.'}];
  data.history=[{id:'h1',contactId:'jane',name:'Jane Smith',to:'jane@example.com',subject:'s',message:'m',status:'bounced',date:new Date(clock-500000).toISOString()},{id:'h2',contactId:'jane',name:'Jane Smith',to:'jane.smith@example.com',subject:'s',message:'m',status:'sent',date:new Date(clock-100000).toISOString()}];
  const h=harness(data,{now:()=>clock,findRocketReachCompany:async()=>null});await h.call('status');
  const resumed=await h.call('run/resume',{runId:'old'});assert.equal(resumed.status,200,JSON.stringify(resumed.body));
  const run=resumed.body.run;assert.equal(run.verifiedFormat,'first.last');assert.deepEqual(sent,['alex.chen@example.com']);
  assert.equal(run.people[0].outcome,'reached');
});
test('Stop sending halts a run immediately, sends nothing more, and Resume continues it',async t=>{
  let clock=Date.now();const sent=[];
  t.mock.method(globalThis,'fetch',async(url,opts)=>{const u=String(url);if(u.endsWith('/messages/send')){sent.push(Buffer.from(JSON.parse(opts.body).raw,'base64url').toString().match(/^To: (.+)$/m)[1]);return Response.json({id:'g'+sent.length});}if(u.endsWith('/profile'))return Response.json({historyId:'1'});if(u.includes('/history?'))return Response.json({history:[]});return new Response('Blocked',{status:403});});
  const data=batchSeed();data.tokens.scopes='openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata';
  data.contacts=[{id:'jane',name:'Jane Smith',company:'Example',selected:null,candidates:[{email:'jane@example.com',format:'first',percentage:60}]},{id:'alex',name:'Alex Chen',company:'Example',selected:null,candidates:[{email:'alex@example.com',format:'first',percentage:60}]}];
  const h=harness(data,{now:()=>clock,findRocketReachCompany:async()=>null});await h.call('status');
  const prepared=await h.call('batch/prepare',{recipients:[{id:'jane',to:'jane@example.com'},{id:'alex',to:'alex@example.com'}],subject:'s',message:'m'});
  let run=(await h.call('run/start',{batchId:prepared.body.batch.id,confirmed:true})).body.run;assert.deepEqual(sent,['jane@example.com']);
  const stopped=await h.call('run/stop',{runId:run.id});assert.equal(stopped.status,200,JSON.stringify(stopped.body));run=stopped.body.run;
  assert.equal(run.status,'stopped');assert.equal(run.stoppedBy,'user');assert.match(run.error,/Stopped by you/);
  assert.ok(run.log.some(l=>/jane@example\.com had already been sent and cannot be recalled/.test(l.detail)));
  assert.equal((await h.call('run/stop',{runId:run.id})).status,400,'stopping twice is an error, not a second stop');
  // The timer leaves a stopped run alone, even well past the watch window.
  clock+=120000;run=(await h.call('run/tick',{})).body.run;assert.equal(run.status,'stopped');assert.deepEqual(sent,['jane@example.com']);
  assert.equal((await h.call('status')).body.activeRun.stoppedBy,'user');
  // Resume re-attaches to the probe already out; the window has long passed, so it is judged delivered and Alex is emailed.
  run=(await h.call('run/resume',{runId:run.id})).body.run;assert.equal(run.status,'running');assert.equal(run.stoppedBy,null);
  run=(await h.call('run/tick',{})).body.run;assert.equal(run.verifiedFormat,'first');assert.deepEqual(sent,['jane@example.com','alex@example.com']);
});
test('RocketReach may name a domain on the search-result blocklist (Google → google.com) but never a personal email provider',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{const u=String(url);
    if(u.includes('duckduckgo.com/html'))return new Response('<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jim-joseph">Jim Joseph - Recruiter at Google | LinkedIn</a></div>');
    return new Response('Blocked',{status:403});});
  const rocketUrl='https://rocketreach.co/google-email-format_b1';
  const patterns=async domain=>({domain,checkedAt:new Date().toISOString(),reportedPatterns:[{format:'first',percentage:50,source:rocketUrl}],sources:[],warnings:[]});
  const google=harness(undefined,{findRocketReachCompany:async()=>({domain:'google.com',source:rocketUrl,title:'Google Email Format | google.com Emails',mentions:1,urls:[rocketUrl]}),discoverCompanyDomain:async()=>assert.fail('RocketReach settled the domain'),findPatterns:patterns,resolveMx:async()=>[{exchange:'smtp.google.com'}]});
  await google.call('status');const found=await google.call('discover',{company:'Google'});
  assert.equal(found.body.domain,'google.com');assert.equal(found.body.domainResolution.status,'rocketreach');assert.equal(found.body.results[0].candidates[0].email,'jim@google.com');
  const freemail=harness(undefined,{findRocketReachCompany:async()=>({domain:'gmail.com',source:rocketUrl,title:'x',mentions:1,urls:[rocketUrl]}),discoverCompanyDomain:async()=>({domain:'',status:'unresolved',sources:[],message:'none'}),findPatterns:patterns,resolveMx:async()=>[{exchange:'mx'}]});
  await freemail.call('status');const rejected=await freemail.call('discover',{company:'Google'});
  assert.equal(rejected.body.domain,'');assert.ok(rejected.body.diagnostics.events.some(e=>/gmail\.com is a personal email provider/.test(e.detail)));
});
test('a reviewer can drop a person from a draft batch, but not the last one, and the send excludes them',async t=>{
  const sent=[];
  t.mock.method(globalThis,'fetch',async(url,opts)=>{const u=String(url);if(u.endsWith('/messages/send')){sent.push(Buffer.from(JSON.parse(opts.body).raw,'base64url').toString().match(/^To: (.+)$/m)[1]);return Response.json({id:'g'+sent.length});}if(u.endsWith('/profile'))return Response.json({historyId:'1'});return new Response('Blocked',{status:403});});
  const h=harness(batchSeed());await h.call('status');
  const prepared=await h.call('batch/prepare',batchBody);const batch=prepared.body.batch;assert.equal(batch.rows.length,2);
  assert.equal((await h.call('batch/remove',{batchId:batch.id,contactId:'nobody'})).status,400);
  const removed=await h.call('batch/remove',{batchId:batch.id,contactId:'jane'});assert.equal(removed.status,200,JSON.stringify(removed.body));
  assert.deepEqual(removed.body.batch.rows.map(r=>r.id),['alex']);assert.deepEqual(removed.body.batch.removed.map(r=>r.name),['Jane Smith']);
  const last=await h.call('batch/remove',{batchId:batch.id,contactId:'alex'});assert.equal(last.status,400);assert.match(last.body.error,/only recruiter left/);
  const done=await h.call('batch/send',{batchId:batch.id,confirmed:true});assert.equal(done.body.batch.status,'complete');assert.deepEqual(sent,['alex@example.com']);
  // The extension may only touch its own batches.
  assert.equal((await h.call('extension/remove',{batchId:batch.id,contactId:'alex'},{'x-extension-token':'nope'})).status,403);
});
