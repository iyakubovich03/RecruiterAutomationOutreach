import { createPatternCache } from './pattern-cache.mjs';
import { buildBatch, outreachBlocked, personalize } from './batch.mjs';
import { discoverCompanyDomain } from './company-domain.mjs';
import { findPatterns, rankCandidates } from './patterns.mjs';
import { discoverRecruiters } from './discovery.mjs';
import { apiProviders } from './search.mjs';
import { searchConfig, publicConfig } from './config.mjs';
import { parseProfileHtml } from './profile.mjs';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { resolveMx } from 'node:dns/promises';
import { join } from 'node:path';
import { candidates, domainOf, parseProfile, relevance, mimeMessage, emailPattern, MAX_ATTACHMENT_BYTES } from './core.mjs';
const RESUME_TYPES = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

const ORIGIN = 'http://localhost:3000';
export const CALLBACK = ORIGIN + '/api/auth/callback';
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const random = () => randomBytes(32).toString('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
async function remote(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(25000) }); } catch { throw fail('The service could not be reached. Please try again.', 502); }
  const data = await response.json().catch(() => ({}));
  return { response, data };
}
export function createLocalApi(getEnv, directory = join(process.cwd(), '.local-data'), services = {}) {
  const researchPatterns = services.findPatterns || findPatterns;
  const resolveCompany = services.discoverCompanyDomain || discoverCompanyDomain;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const file = join(directory, 'workspace.json');
  let db = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { contacts: [], history: [], tokens: null, template: { ...searchConfig.template } };
  const save = () => { const temp = file + '.tmp'; writeFileSync(temp, JSON.stringify(db), { mode: 0o600 }); renameSync(temp, file); chmodSync(file,0o600); };
  db.patterns ||= {};
  db.batches ||= [];
  db.resume ||= null;
  const resumeFile = join(directory, 'resume.bin');
  const loadResume = () => {
    if (!db.resume || !existsSync(resumeFile)) throw fail('The saved resume file is missing. Upload it again under Default email.', 409);
    return { filename: db.resume.filename, type: db.resume.type, content: readFileSync(resumeFile) };
  };
  let recovered=false;
  for(const batch of db.batches.filter(b=>b.status==='sending')) {
    batch.status='interrupted';recovered=true;
    for(const row of batch.rows.filter(r=>r.status==='pending'))row.status='uncertain';
  }
  if(recovered)save();
  const getPatterns = createPatternCache(db.patterns, save, (domain, read, options) => researchPatterns(domain, read, { ...options, env: getEnv() }));
  const sessions = new Map();
  let sending = false;
  let discovering = false;
  const discoveryCache = new Map();
  function config() {
    const env = getEnv();
    return { client_id: env.GOOGLE_CLIENT_ID?.trim(), client_secret: env.GOOGLE_CLIENT_SECRET?.trim(), redirect_uri: env.GOOGLE_REDIRECT_URI?.trim() || CALLBACK };
  }
  async function accessToken() {
    if (!db.tokens) throw fail('Connect Gmail first.', 401);
    if (db.tokens.expires > Date.now() + 60000) return db.tokens.access_token;
    if (!db.tokens.refresh_token) throw fail('Reconnect Gmail to renew access.', 401);
    const { response, data } = await remote('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ ...config(), grant_type: 'refresh_token', refresh_token: db.tokens.refresh_token }) });
    if (!response.ok || !data.access_token) throw fail('Gmail authorization expired or was revoked. Reconnect Gmail.', 401);
    db.tokens = { ...db.tokens, access_token: data.access_token, expires: Date.now() + data.expires_in * 1000 }; save();
    return db.tokens.access_token;
  }
  async function deliver(c,to,subject,message,token,attachment=null,test=false) {
    const raw=mimeMessage({to,from:db.tokens.email,subject,message,attachment});
    const record={id:randomUUID(),contactId:c.id,name:c.name,to,from:db.tokens.email,subject,message,attachment:attachment?.filename||null,test,date:new Date().toISOString(),status:'pending'};
    db.history.unshift(record);save();
    try{
      const {response,data}=await remote('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({raw})});
      if(!response.ok){record.status=response.status>=500?'uncertain':'failed';save();throw fail(`Gmail did not confirm submission (${response.status}). Check Gmail Sent and account limits.`,502);}
      if(!data.id)throw fail('Gmail returned no submission ID.',502);
      record.status='sent';record.gmailId=data.id;save();return record;
    }catch(error){if(record.status==='pending'){record.status='uncertain';save();}throw error;}
  }
  return async function localApi(req, res, next) {
    if (!req.url?.startsWith('/api/')) return next();
    const json = (value, code = 200) => { res.statusCode = code; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value)); };
    const redirect = path => { res.statusCode = 302; res.setHeader('Location', path); res.end(); };
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    try {
      if (req.headers.host !== 'localhost:3000') throw fail('Open this app at http://localhost:3000.',403);
      if (req.headers.origin && req.headers.origin !== ORIGIN) throw fail('Request origin is not allowed.',403);
      let sid = /(?:^|;\s*)recruiter_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      if (!sid || !sessions.has(sid)) {
        sid = random(); sessions.set(sid, { csrf: random(), created: Date.now() });
        res.setHeader('Set-Cookie',`recruiter_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
      }
      const session = sessions.get(sid);
      if (Date.now() - session.created > 86400000) { sessions.delete(sid); throw fail('Refresh the page to renew the local session.',401); }
      const url = new URL(req.url, ORIGIN), path = url.pathname;
      let body = {};
      if (req.method === 'POST') {
        if (req.headers.origin !== ORIGIN || req.headers['x-csrf-token'] !== session.csrf) throw fail('Refresh the page and try again.',403);
        if (!req.headers['content-type']?.startsWith('application/json')) throw fail('JSON body required.',415);
        const limit = path === '/api/resume' ? 8000000 : 100000;
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > limit) throw fail(path === '/api/resume' ? 'The resume must be 5 MB or smaller.' : 'The supplied text is too large.',413); }
        try { body = JSON.parse(raw || '{}'); } catch { throw fail('Invalid JSON.'); }
      } else if (req.method !== 'GET') throw fail('Method not allowed.',405);
      if (path === '/api/status' && req.method === 'GET') {
        const cfg = config();
        return json({ csrf: session.csrf, configured: !!(cfg.client_id && cfg.client_secret), redirect: cfg.redirect_uri, searchProviders: apiProviders(getEnv()).map(p => p.label), connected: !!db.tokens, account: db.tokens?.email || null, contacts: db.contacts, history: db.history, patterns: db.patterns, batches: db.batches.map(({owner,...batch})=>batch), template: db.template, resume: db.resume, profile: publicConfig() });
      }
      if (path === '/api/discover/status' && req.method === 'GET') {
        return json(session.searchDebug || {company:'',running:false,events:[]});
      }
      if (path === '/api/discover/last' && req.method === 'GET') {
        return json(session.discovery || null);
      }
      if (path === '/api/auth/start' && req.method === 'POST') {
        const cfg = config();
        if (!cfg.client_id || !cfg.client_secret) throw fail('Add your OAuth client ID and secret to .env.local.');
        if (cfg.redirect_uri !== CALLBACK) throw fail('Set GOOGLE_REDIRECT_URI to ' + CALLBACK);
        session.oauth = { state: random(), verifier: random(), expires: Date.now() + 600000 };
        const params = new URLSearchParams({ client_id: cfg.client_id, redirect_uri: cfg.redirect_uri, response_type: 'code', scope: `openid email ${SEND_SCOPE}`, access_type: 'offline', prompt: 'consent', state: session.oauth.state, code_challenge: createHash('sha256').update(session.oauth.verifier).digest('base64url'), code_challenge_method: 'S256' });
        return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params });
      }
      if (path === '/api/auth/callback' && req.method === 'GET') {
        if(sending)return redirect('/?auth=busy');
        const pending = session.oauth; delete session.oauth;
        if (!pending || pending.expires < Date.now() || pending.state !== url.searchParams.get('state')) return redirect('/?auth=invalid_state');
        if (url.searchParams.has('error')) return redirect('/?auth=cancelled');
        const code = url.searchParams.get('code'); if (!code) return redirect('/?auth=failed');
        try {
          const { response, data } = await remote('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ ...config(), code, grant_type: 'authorization_code', code_verifier: pending.verifier }) });
          if (!response.ok || !data.access_token || !data.scope?.split(' ').includes(SEND_SCOPE)) return redirect('/?auth=missing_permission');
          const identity = await remote('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${data.access_token}` } });
          if (!identity.response.ok || !identity.data.email_verified || !emailPattern.test(identity.data.email)) return redirect('/?auth=failed');
          db.tokens = { access_token: data.access_token, refresh_token: data.refresh_token, expires: Date.now() + data.expires_in * 1000, email: identity.data.email };
          save(); return redirect('/?auth=connected');
        } catch { return redirect('/?auth=failed'); }
      }
      if (path === '/api/auth/disconnect' && req.method === 'POST') {
        if (sending) throw fail('Wait for the current send to finish.',409);
        const token = db.tokens?.refresh_token || db.tokens?.access_token;
        if (token) {
          const { response } = await remote('https://oauth2.googleapis.com/revoke', { method:'POST', body:new URLSearchParams({ token }) });
          if (!response.ok && response.status !== 400) throw fail('Google could not revoke access. Try again.',502);
        }
        db.tokens = null; save(); return json({ ok: true });
      }
      if (path === '/api/patterns' && req.method === 'POST') {
        const domain=domainOf(body.domain);
        const company=String(body.company||db.contacts.find(c=>c.domain===domain)?.company||domain).trim().slice(0,100);
        const result=await getPatterns(company,domain);
        for(const c of db.contacts.filter(c=>c.domain===domain))c.candidates=rankCandidates(c.name,domain,c.sourceText||'',result.report);
        save();return json(result);
      }
      if (path === '/api/discover' && req.method === 'POST') {
        const company=String(body.company || '').trim();let domain=body.domain?domainOf(body.domain):'';
        const key=company.toLowerCase()+'|'+domain, cached=discoveryCache.get(key);
        if(discovering)throw fail('A company search is already running. Please wait.',409);
        const debug={company,running:true,startedAt:new Date().toISOString(),events:[]};session.searchDebug=debug;
        const trace=event=>{if(debug.events.length<120)debug.events.push({...event,detail:String(event.detail||'').slice(0,1000),at:new Date().toISOString()});};
        if(cached && Date.now()-cached.time<600000 && body.fresh!==true){session.discovery=cached.result;debug.events.push(...(cached.result.diagnostics?.events||[]));trace({stage:'Cache',status:'ok',detail:'Using a result cached for up to 10 minutes. Use Run fresh search to bypass it.'});debug.running=false;return json({...cached.result,diagnostics:debug});}
        discovering=true;
        try {
          trace({stage:'Search',status:'running',detail:`Starting company search: ${company}`});
          const env=getEnv();
          if(!apiProviders(env).length)trace({stage:'Search',status:'partial',detail:'No search API key is configured. Public search pages currently block automated LinkedIn queries; add SERPER_API_KEY or SERPAPI_KEY to .env.local.'});
          let result;
          try{result=await discoverRecruiters(company,'',fetch,trace,{env});}
          catch(e){trace({stage:'Recruiter discovery',status:'error',detail:e.message});result={company,domain:'',provider:'Public search',searchedAt:new Date().toISOString(),warnings:[e.message],results:[]};}
          if(!apiProviders(env).length&&!result.results.length)result.warnings.push('No search API key is configured. Public search pages currently block automated LinkedIn queries; see README “Search API”.');
          let domainResolution;
          if(!result.results.length){domainResolution={domain:'',status:'skipped',sources:[],message:'Domain and email-format research skipped because no matching profiles were found.'};trace({stage:'Domain discovery',status:'skipped',detail:domainResolution.message});}
          else try{domainResolution=domain?{domain,status:'provided',sources:[],message:'Previously supplied domain.'}:await resolveCompany(company,{onEvent:trace,env});}
          catch(e){domainResolution={domain:'',status:'unresolved',sources:[],message:'Domain discovery failed. See search diagnostics.'};trace({stage:'Domain discovery',status:'error',detail:e.message});}
          domain=domainResolution.domain;result.domain=domain;
          trace({stage:'Domain decision',status:domain?'ok':'unresolved',detail:domain?`${domain}: ${domainResolution.message}`:domainResolution.message});
          result.domainResolution=domainResolution;
          if(!domain)result.warnings.push(domainResolution.message);
          if(domain&&result.results.length){
            trace({stage:'Email patterns',status:'running',detail:`Researching formats at ${domain}`});
            let report=db.patterns[domain];
            try{
              const cachedResearch=await getPatterns(company,domain,trace);
              report=cachedResearch.report;
            }catch(e){result.warnings.push('Company pattern research was unavailable. Existing evidence or unverified guesses are shown.');trace({stage:'Email patterns',status:'error',detail:e.message});}
            result.patternReport=report||null;result.warnings.push(...(report?.warnings||[]));
            trace({stage:'Email patterns',status:report?.reportedPatterns?.length?'ok':'empty',detail:`${report?.reportedPatterns?.length||0} RocketReach formats from ${report?.sources?.length||0} pages checked`});
            result.results=result.results.map(row=>({...row,candidates:rankCandidates(row.name,domain,row.sourceText,report)}));
            for(const row of result.results)trace({stage:'Email candidates',status:'ok',detail:`${row.name}: ${row.candidates.map(c=>`${c.email} [${c.format}]`).join(', ')}. All unverified.`,source:row.source});
            for(const c of db.contacts.filter(c=>c.domain===domain))c.candidates=rankCandidates(c.name,domain,c.sourceText||'',report);
            save();
          } else trace({stage:'Email patterns',status:'skipped',detail:domain?'No recruiters found to analyze':'No company domain established'});
          trace({stage:'Search',status:result.results.length&&domain?'ok':'partial',detail:`Finished: domain ${domain||'unresolved'}, ${result.results.length} recruiters`});
          debug.running=false;result.diagnostics=debug;
          session.discovery=result;discoveryCache.set(key,{time:Date.now(),result});if(discoveryCache.size>20)discoveryCache.delete(discoveryCache.keys().next().value);return json(result); }
        finally{discovering=false;debug.running=false;}
      }
      if (path === '/api/discover/save' && req.method === 'POST') {
        const search=session.discovery;if(!search)throw fail('Run a company search first.');
        const domain=domainOf(body.domain||search.domain),sources=body.sources;
        if(!Array.isArray(sources)||!sources.length||sources.length>8)throw fail('Select 1–8 profiles to save.');
        const selected=search.results.filter(row=>sources.includes(row.source));
        if(selected.length!==new Set(sources).size)throw fail('Only profiles from your search can be saved.');
        const contacts=[],contactIds=[];
        for(const row of selected){
          const existing=db.contacts.find(c=>c.source===row.source||(c.name.toLowerCase()===row.name.toLowerCase()&&c.domain===domain));
          if(existing){contactIds.push(existing.id);continue;}
          const contact={id:randomUUID(),name:row.name,title:row.title,company:search.company,domain,source:row.source,sourceText:row.sourceText,focus:row.focus,created:new Date().toISOString(),candidates:rankCandidates(row.name,domain,row.sourceText,db.patterns[domain]),selected:null,discovery:{association:row.association,basis:row.basis,profileStatus:row.profileStatus,observedCompany:row.observedCompany||null,searchedAt:search.searchedAt,employerConfirmed:false}};
          contacts.push(contact);contactIds.push(contact.id);
        }
        db.contacts.unshift(...contacts);save();return json({saved:contacts.length,skipped:selected.length-contacts.length,contactIds});
      }
      if (path === '/api/profile' && req.method === 'POST') {
        let text = String(body.text || '').slice(0,20000);
        if (body.url && !text) {
          let target; try { target = new URL(body.url); } catch { throw fail('Enter a valid LinkedIn profile URL.'); }
          if (target.protocol !== 'https:' || !['linkedin.com','www.linkedin.com'].includes(target.hostname) || !/^\/in\/[a-zA-Z0-9_%\-]+\/?$/.test(target.pathname) || target.port || target.username || target.password) throw fail('Use an https://www.linkedin.com/in/… profile URL.');
          target.search = ''; target.hash = '';
          let response; try { response = await fetch(target, { redirect:'manual', signal:AbortSignal.timeout(15000), headers:{ 'User-Agent':'RecruiterFinder/1.0 (local personal research)' } }); } catch { throw fail('The profile is unavailable. Paste its visible profile text instead.',422); }
          if (!response.ok) throw fail('LinkedIn blocked access or requires sign-in. Paste the profile text instead.',422);
          const reader = response.body.getReader(); let html = ''; const decoder = new TextDecoder();
          while (true) { const part = await reader.read(); if (part.done) break; html += decoder.decode(part.value,{stream:true}); if (html.length > 1000000) { await reader.cancel(); throw fail('Profile page is too large. Paste profile text instead.',422); } }
          try { return json(parseProfileHtml(html, target.href)); } catch (error) { throw fail(error.message,422); }
        }
        if (!text.trim()) throw fail('Paste profile text or provide a public profile URL.');
        return json(parseProfile(text));
      }
      if (path === '/api/contacts' && req.method === 'POST') {
        const name = String(body.name || '').trim().slice(0,100), title = String(body.title || '').trim().slice(0,250), company = String(body.company || '').trim().slice(0,100);
        if (!company) throw fail('Enter a company name.');
        const domain = domainOf(body.domain);
        if (db.contacts.some(c => c.name.toLowerCase() === name.toLowerCase() && c.domain === domain)) throw fail('This recruiter is already saved.',409);
        const source = String(body.source || '').slice(0,1000);
        if (source && !/^https?:\/\//i.test(source)) throw fail('The source URL must start with https:// or http://.');
        const contact = { id:randomUUID(), name, title, company, domain, source, sourceText:String(body.sourceText || '').slice(0,20000), focus:relevance(title), created:new Date().toISOString(), candidates:rankCandidates(name,domain,String(body.sourceText || ''),db.patterns[domain]), selected:null };
        db.contacts.unshift(contact); save(); return json({ contact });
      }
      if (path === '/api/contacts/select' && req.method === 'POST') {
        const c = db.contacts.find(c => c.id === body.id); if (!c) throw fail('Recruiter not found.',404);
        if (!c.candidates.some(x => x.email === body.email)) throw fail('Choose one of this recruiter’s candidates.');
        c.selected = body.email; save(); return json({ ok:true });
      }
      if (path === '/api/check' && req.method === 'POST') {
        const c = db.contacts.find(c => c.id === body.id); if (!c) throw fail('Recruiter not found.',404);
        let status, message;
        try { const mx = await resolveMx(c.domain); status = mx.some(r => r.exchange && r.exchange !== '.') ? 'domain_ready' : 'no_mx'; message = status === 'domain_ready' ? 'Domain has mail servers. Individual mailboxes remain unverified.' : 'No usable MX records found. This does not verify individual addresses.'; }
        catch (e) { status = ['ENOTFOUND','ENODATA'].includes(e.code) ? 'no_mx' : 'unknown'; message = status === 'unknown' ? 'DNS lookup failed temporarily. Try again.' : 'No MX records found. Review the company email domain.'; }
        c.domainCheck = { status, message, checked:new Date().toISOString() }; save(); return json(c.domainCheck);
      }
      if (path === '/api/resume' && req.method === 'POST') {
        const filename = String(body.filename || '').replace(/[\\/:*?"<>|\r\n]/g, '').trim().slice(0, 120);
        const extension = filename.toLowerCase().split('.').pop();
        if (!filename || !RESUME_TYPES[extension]) throw fail('Upload a PDF, DOC, or DOCX file.');
        let content; try { content = Buffer.from(String(body.data || ''), 'base64'); } catch { throw fail('The file could not be read.'); }
        if (!content.length) throw fail('The file is empty.');
        if (content.length > MAX_ATTACHMENT_BYTES) throw fail('The resume must be 5 MB or smaller.', 413);
        if (extension === 'pdf' && !content.subarray(0, 5).toString().startsWith('%PDF')) throw fail('This file is not a valid PDF.');
        const temp = resumeFile + '.tmp'; writeFileSync(temp, content, { mode: 0o600 }); renameSync(temp, resumeFile); chmodSync(resumeFile, 0o600);
        db.resume = { filename, type: RESUME_TYPES[extension], size: content.length, savedAt: new Date().toISOString() }; save();
        return json({ resume: db.resume });
      }
      if (path === '/api/resume/remove' && req.method === 'POST') {
        if (existsSync(resumeFile)) unlinkSync(resumeFile);
        db.resume = null; save(); return json({ ok: true });
      }
      if (path === '/api/template' && req.method === 'POST') {
        db.template = { subject:String(body.subject || '').slice(0,200), message:String(body.message || '').slice(0,20000) }; save(); return json({ ok:true });
      }
      if (path === '/api/batch/prepare' && req.method === 'POST') {
        if(!db.tokens)throw fail('Connect Gmail before reviewing the sending batch.',401);
        const multipleCandidates=body.multipleCandidates===true, attachResume=body.attachResume===true;
        if(attachResume)loadResume();
        let rows;try{rows=buildBatch(body.recipients,db.contacts,db.history,db.tokens.email,body.subject,body.message,multipleCandidates);}catch(e){throw fail(e.message);}
        const batch={id:randomUUID(),owner:sid,from:db.tokens.email,created:new Date().toISOString(),status:'draft',multipleCandidates,attachResume,attachment:attachResume?db.resume.filename:null,rows};
        db.batches=db.batches.filter(b=>b.status!=='draft'||Date.now()-Date.parse(b.created)<600000);
        db.batches.unshift(batch);save();const {owner,...preview}=batch;return json({batch:preview});
      }
      if (path === '/api/batch/send' && req.method === 'POST') {
        if(body.confirmed!==true)throw fail('Review and confirm the batch before sending.');
        if(sending)throw fail('A send is already in progress.',409);
        const batch=db.batches.find(b=>b.id===body.batchId&&b.owner===sid);
        if(!batch||batch.status!=='draft')throw fail('This batch is unavailable or has already been started. Check outreach history.',409);
        if(Date.now()-Date.parse(batch.created)>600000)throw fail('The preview expired. Review the batch again.');
        if(!db.tokens||db.tokens.email!==batch.from)throw fail('The connected Gmail account changed. Review the batch again.',401);
        if(batch.rows.some(row=>outreachBlocked(db.history,row.id,row.to,batch.multipleCandidates)))throw fail('A recipient already has outreach. Review the batch again.',409);
        const attachment=batch.attachResume?loadResume():null;
        sending=true;
        try{
          const token=await accessToken();batch.status='sending';save();
          for(const row of batch.rows){
            const c=db.contacts.find(c=>c.id===row.id);
            try{c.selected=row.to;row.status='pending';save();const record=await deliver(c,row.to,row.subject,row.message,token,attachment);row.status=record.status;}
            catch(e){row.status=db.history.find(h=>h.contactId===row.id&&h.to===row.to)?.status||'failed';row.error=e.message;batch.status='stopped';save();break;}
            save();
          }
          if(batch.status==='sending')batch.status='complete';save();const {owner,...result}=batch;return json({batch:result});
        }finally{sending=false;}
      }
      if (path === '/api/test-send' && req.method === 'POST') {
        if (sending) throw fail('A send is in progress. Please wait.',409);
        if (!db.tokens) throw fail('Connect Gmail first.',401);
        const to=String(body.to||'').trim().toLowerCase();
        if (!emailPattern.test(to)) throw fail('Enter a valid recipient email address.');
        const company=String(body.company||'').trim().slice(0,100)||'Example', name=String(body.name||'').trim().slice(0,100)||'Jane Doe';
        const subject=personalize(String(body.subject||''),{name,company},to), message=personalize(String(body.message||''),{name,company},to);
        const attachment=body.attachResume===true?loadResume():null;
        sending=true;
        try { const token=await accessToken();const record=await deliver({id:null,name:`Test · ${name} at ${company}`},to,subject,message,token,attachment,true);return json({record}); }
        finally{sending=false;}
      }
      if (path === '/api/send' && req.method === 'POST') {
        if (sending) throw fail('A send is in progress. Please wait.',409);
        const c = db.contacts.find(c => c.id === body.id); if (!c || !c.selected || c.selected !== body.to) throw fail('Select and review the recipient first.');
        if (body.confirmed !== true) throw fail('Review and confirm this message before sending.');
        if (db.history.some(h => (h.contactId === c.id || h.to === c.selected) && ['sent','pending','uncertain'].includes(h.status))) throw fail('Outreach already exists for this recruiter. Check history and Gmail Sent before sending again.',409);
        if (!db.tokens) throw fail('Connect Gmail first.',401);
        sending=true;
        const attachment=body.attachResume===true?loadResume():null;
        try { const token=await accessToken();const record=await deliver(c,c.selected,body.subject,body.message,token,attachment);return json({record}); }
        finally{sending=false;}
      }
      throw fail('Endpoint not found.',404);
    } catch(error) { json({ error:error.status ? error.message : 'Something went wrong. Try again or restart the local app.' }, error.status || 500); }
  };
}
