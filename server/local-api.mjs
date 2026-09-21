import { createPatternCache } from './pattern-cache.mjs';
import { buildBatch, outreachBlocked, personalize } from './batch.mjs';
import { discoverCompanyDomain, excludedHost, freemailHost } from './company-domain.mjs';
import { findPatterns, rankCandidates } from './patterns.mjs';
import { discoverRecruiters } from './discovery.mjs';
import { findRocketReachCompany } from './rocketreach.mjs';
import { apiProviders, searchWeb } from './search.mjs';
import { searchConfig, publicConfig } from './config.mjs';
import { parseProfileHtml } from './profile.mjs';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { resolveMx } from 'node:dns/promises';
import { join } from 'node:path';
import { candidates, candidateForFormat, domainOf, parseProfile, relevance, mimeMessage, emailPattern, MAX_ATTACHMENT_BYTES } from './core.mjs';
import { automaticRecipients, nextCandidate } from '../app/outreach.mjs';
const RESUME_TYPES = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

const ORIGIN = 'http://localhost:3000';
export const CALLBACK = ORIGIN + '/api/auth/callback';
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
// Headers only (never bodies): enough to read "Delivery Status Notification" notices after a send.
const METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
const BOUNCE_SUBJECT = /delivery status notification|undeliverable|delivery (?:has )?failed|returned mail|mail delivery failed|could not be delivered/i;
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
  const mx = services.resolveMx || resolveMx;
  const rocketCompany = services.findRocketReachCompany || findRocketReachCompany;
  const mailServers = domain => Promise.race([mx(domain), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('DNS timeout')), 4000); timer.unref(); })]);
  const hasMail = records => records.some(r => r.exchange && r.exchange !== '.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const file = join(directory, 'workspace.json');
  let db = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { contacts: [], history: [], tokens: null, template: { ...searchConfig.template } };
  const save = () => { const temp = file + '.tmp'; writeFileSync(temp, JSON.stringify(db), { mode: 0o600 }); renameSync(temp, file); chmodSync(file,0o600); };
  db.patterns ||= {};
  db.batches ||= [];
  db.resume ||= null;
  // Domains proven by an actual delivered email (a run whose probe did not bounce), keyed by company.
  db.verifiedDomains ||= {};
  const companyKeyOf = name => String(name || '').toLowerCase().replace(/\s+/g, '');
  // Older entries recorded only the domain; the format that got through lives on the run that proved it.
  for (const entry of Object.values(db.verifiedDomains)) if (!entry.format) { const run = (db.runs || []).find(r => r.id === entry.run); if (run?.verifiedFormat) entry.format = run.verifiedFormat; }
  const registrableOf = host => { const labels = String(host || '').toLowerCase().replace(/^www\./, '').split('.'); const keep = labels.length >= 3 && /^(?:co|com|org|net|ac|gov|edu)$/.test(labels.at(-2)) && labels.at(-1).length === 2 ? 3 : 2; return labels.slice(-keep).join('.'); };
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
  // The Chrome extension authenticates with this token instead of the browser session; it only reaches /api/extension/*.
  if (!db.extensionToken) { db.extensionToken = random(); save(); }
  const extensionDir = join(process.cwd(), 'extension');
  const extensionSession = { csrf: '', created: Date.now() };
  let extensionDebug = null, lastDebug = null, lastDiscovery = null;
  const publicBatch = batch => { const copy = { ...batch }; delete copy.owner; return copy; };
  async function runDiscovery(company, { domain = '', fresh = false, onDebug = () => {}, domainHint = '', pageUrl = '' } = {}) {
    const key=company.toLowerCase()+'|'+domain, cached=discoveryCache.get(key);
    if(discovering)throw fail('A company search is already running. Please wait.',409);
    const debug={company,running:true,startedAt:new Date().toISOString(),events:[]};onDebug(debug);lastDebug=debug;
    const trace=event=>{if(debug.events.length<120)debug.events.push({...event,detail:String(event.detail||'').slice(0,1000),at:new Date().toISOString()});};
    if(cached && Date.now()-cached.time<600000 && !fresh){debug.events.push(...(cached.result.diagnostics?.events||[]));trace({stage:'Cache',status:'ok',detail:'Using a result cached for up to 10 minutes. Use Run fresh search to bypass it.'});debug.running=false;lastDiscovery={...cached.result,diagnostics:debug};return lastDiscovery;}
    discovering=true;
    try {
      trace({stage:'Search',status:'running',detail:`Starting company search: ${company}`});
      const env=getEnv();
      if(!apiProviders(env).length)trace({stage:'Search',status:'partial',detail:'No search API key is configured. Public search pages currently block automated LinkedIn queries; add SERPER_API_KEY or SERPAPI_KEY to .env.local.'});
      let result;
      try{result=await discoverRecruiters(company,'',fetch,trace,{env});}
      catch(e){trace({stage:'Recruiter discovery',status:'error',detail:e.message});result={company,domain:'',provider:'Public search',searchedAt:new Date().toISOString(),warnings:[e.message],results:[]};}
      if(!apiProviders(env).length&&!result.results.length)result.warnings.push('No search API key is configured. Public search pages currently block automated LinkedIn queries; see README “Search API”.');
      // Research the company under the name the profiles use ("Scale AI"), not the typed or URL-slug spelling.
      const displayCompany=result.canonicalCompany||company;
      if(displayCompany!==company){trace({stage:'Company name',status:'ok',detail:`LinkedIn profiles call it “${displayCompany}”; using that name for domain and format research.`});result.company=displayCompany;}
      // Domain precedence: the job application page → RocketReach's stated domain → an "official website" search.
      // Each candidate must have mail servers; the search alone confuses same-name companies (Scale AI vs scaleai.ca).
      const hintedDomain=async()=>{
        const full=domainOf(domainHint);
        if(excludedHost.test(full))throw new Error('it is a job board, applicant-tracking, or social site');
        const labels=full.split('.'), minimum=labels.length>=3&&/^(?:co|com|org|net|ac|gov|edu)$/.test(labels.at(-2))&&labels.at(-1).length===2?3:2;
        for(let i=0;i<=labels.length-minimum;i++){
          const hint=labels.slice(i).join('.');const records=await mailServers(hint).catch(()=>[]);
          if(!hasMail(records))continue;
          trace({stage:'Domain search',status:'ok',detail:`Using ${hint} from the job application page; no domain search needed. Mail servers: ${records.map(r=>r.exchange).join(', ')}`,source:pageUrl||undefined});
          return {domain:hint,status:'application page',sources:pageUrl?[pageUrl]:[],checkedAt:new Date().toISOString(),message:`Email domain taken from the job application page (${hint}); mail servers found.`};
        }
        throw new Error('it has no mail servers');
      };
      let rocket=null;
      const rocketDomain=async(settled='')=>{
        rocket=await rocketCompany(displayCompany,{env,onEvent:trace,employers:result.results.map(r=>r.association?.text||'').filter(Boolean)});
        if(!rocket?.domain)throw new Error('no RocketReach company page was found');
        // The search-result blocklist (google.com, linkedin.com, …) must not veto RocketReach's answer for the company itself: Google's page really says google.com.
        if(freemailHost.test(rocket.domain))throw new Error(`${rocket.domain} is a personal email provider, not a company domain`);
        const records=await mailServers(rocket.domain).catch(()=>[]);
        if(!hasMail(records))throw new Error(`${rocket.domain} has no mail servers`);
        if(settled){trace({stage:'RocketReach company',status:'ok',detail:rocket.domain===settled?`RocketReach agrees on ${settled}.`:`RocketReach lists ${rocket.domain}, but ${settled} is already confirmed by delivery; the RocketReach page is used for its formats only.`,source:rocket.source});return null;}
        trace({stage:'Domain decision',status:'ok',detail:`RocketReach lists ${rocket.domain} for ${displayCompany}; mail servers: ${records.map(r=>r.exchange).join(', ')}`,source:rocket.source});
        return {domain:rocket.domain,status:'rocketreach',sources:[rocket.source],checkedAt:new Date().toISOString(),message:`RocketReach lists ${rocket.domain} as the email domain for ${displayCompany}; mail servers found.`};
      };
      let domainResolution;
      if(!result.results.length){domainResolution={domain:'',status:'skipped',sources:[],message:'Domain and email-format research skipped because no matching profiles were found.'};trace({stage:'Domain discovery',status:'skipped',detail:domainResolution.message});}
      else try{
        if(domain)domainResolution={domain,status:'provided',sources:[],message:'Previously supplied domain.'};
        else{
          const verified=db.verifiedDomains[companyKeyOf(displayCompany)];
          if(verified){const records=await mailServers(verified.domain).catch(()=>[]);if(hasMail(records)){domainResolution={domain:verified.domain,status:'verified by delivery',sources:[],checkedAt:new Date().toISOString(),message:`${verified.domain} was confirmed by an email that did not bounce on ${String(verified.verifiedAt).slice(0,10)}${verified.format?` (format “${verified.format}”)`:''}.`};trace({stage:'Domain decision',status:'ok',detail:domainResolution.message});}}
          if(!domainResolution&&domainHint)try{domainResolution=await hintedDomain();}catch(e){trace({stage:'Domain search',status:'partial',detail:`Application-page domain “${domainHint}” not used: ${e.message}.`});}
          if(!domainResolution)try{domainResolution=await rocketDomain();}catch(e){trace({stage:'Domain search',status:'partial',detail:`RocketReach could not settle the domain: ${e.message}. Searching for the official website instead.`});}
          if(!domainResolution)domainResolution=await resolveCompany(displayCompany,{onEvent:trace,env});
        }
      }
      catch(e){domainResolution={domain:'',status:'unresolved',sources:[],message:'Domain discovery failed. See search diagnostics.'};trace({stage:'Domain discovery',status:'error',detail:e.message});}
      domain=domainResolution.domain;result.domain=domain;
      // A delivery-verified domain skips RocketReach for the domain, but its formats are still wanted (RocketReach may file the company under another domain).
      if(domain&&domainResolution.status==='verified by delivery'&&!rocket)try{await rocketDomain(domain);}catch(e){trace({stage:'RocketReach company',status:'partial',detail:`RocketReach formats: ${e.message}.`});}
      // Fallback domains for runs: if every address at the chosen domain bounces, a run probes these next.
      // The top organic result for the bare company name is a strong "official site" signal (scale.com, gartner.com).
      let websiteDomain='';
      if(result.results.length&&apiProviders(env).length){
        try{
          const site=await searchWeb(displayCompany,{env,fetcher:fetch,read:async u=>{const r=await fetch(u);if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.text();},scrape:[],onEvent:trace,stage:'Official site',accept:rows=>rows.some(r=>{try{return !excludedHost.test(new URL(r.url).hostname);}catch{return false;}})});
          const first=site.rows.map(r=>{try{return new URL(r.url).hostname;}catch{return '';}}).find(h=>h&&!excludedHost.test(h));
          if(first){websiteDomain=registrableOf(first);trace({stage:'Official site',status:'ok',detail:`Top result for “${displayCompany}”: ${websiteDomain}`});}
        }catch(e){trace({stage:'Official site',status:'error',detail:e.message});}
      }
      // Nothing else settled the domain (no RocketReach page, company pages too large or bot-checked): the official site is the answer.
      if(!domain&&websiteDomain&&result.results.length){
        const records=await mailServers(websiteDomain).catch(()=>[]);
        if(hasMail(records)){domainResolution={domain:websiteDomain,status:'official site',sources:[],checkedAt:new Date().toISOString(),message:`${websiteDomain} is the top search result for “${displayCompany}” and has mail servers (${records.map(r=>r.exchange).join(', ')}).`};domain=websiteDomain;result.domain=domain;result.warnings=result.warnings.filter(w=>!/official company domain could not be established/i.test(w));}
        else trace({stage:'Official site',status:'partial',detail:`${websiteDomain} has no mail servers, so it cannot be the email domain.`});
      }
      const alternates=[];
      for(const alt of [websiteDomain,rocket?.domain,domainHint?registrableOf(domainHint):''].filter(Boolean)){
        if(!domain||alt===domain||alternates.includes(alt)||excludedHost.test(alt))continue;
        const records=await mailServers(alt).catch(()=>[]);if(hasMail(records))alternates.push(alt);
      }
      result.alternateDomains=alternates;if(domainResolution)domainResolution.alternates=alternates;
      if(alternates.length)trace({stage:'Domain decision',status:'ok',detail:`Fallback domain${alternates.length===1?'':'s'} if every address at ${domain} bounces: ${alternates.join(', ')}`});
      trace({stage:'Domain decision',status:domain?'ok':'unresolved',detail:domain?`${domain}: ${domainResolution.message}`:domainResolution.message});
      result.domainResolution=domainResolution;
      if(!domain)result.warnings.push(domainResolution.message);
      if(domain&&result.results.length){
        trace({stage:'Email patterns',status:'running',detail:`Researching formats at ${domain}`});
        let report=db.patterns[domain];
        const verified=domainResolution.status==='verified by delivery'?db.verifiedDomains[companyKeyOf(displayCompany)]:null;
        try{
          if(verified&&rocket?.domain&&rocket.domain!==domain){
            // RocketReach files this company under a domain that bounces (Scale AI → scale.ai); its formats still apply at the domain that delivered.
            const source=await getPatterns(displayCompany,rocket.domain,trace,{rocketReachUrls:rocket.pages||rocket.urls,force:fresh});
            if(source.report?.reportedPatterns?.length){
              report={...source.report,domain,carriedFrom:rocket.domain,warnings:[...(source.report.warnings||[])]};db.patterns[domain]=report;
              trace({stage:'Email patterns',status:'ok',detail:`RocketReach lists ${displayCompany}'s formats under ${rocket.domain}; applying them at ${domain}, which is where email actually delivered.`,source:source.report.reportedPatterns[0]?.source});
            } else report=(await getPatterns(displayCompany,domain,trace,{force:fresh})).report;
          } else {
            const cachedResearch=await getPatterns(displayCompany,domain,trace,{rocketReachUrls:rocket?.domain===domain?(rocket.pages||rocket.urls):[],force:fresh});
            report=cachedResearch.report;
          }
        }catch(e){result.warnings.push('Company pattern research was unavailable. Existing evidence or unverified guesses are shown.');trace({stage:'Email patterns',status:'error',detail:e.message});}
        if(report&&verified?.format){report.verifiedFormat=verified.format;report.verifiedAt=verified.verifiedAt;}
        else if(report?.verifiedFormat){delete report.verifiedFormat;delete report.verifiedAt;}
        result.patternReport=report||null;result.warnings.push(...(report?.warnings||[]));
        result.formatEvidence=formatEvidence(domain,report);
        trace({stage:'Email patterns',status:report?.reportedPatterns?.length?'ok':'empty',detail:`${report?.reportedPatterns?.length||0} RocketReach formats from ${report?.sources?.length||0} pages checked`});
        result.results=result.results.map(row=>({...row,candidates:rankCandidates(row.name,domain,row.sourceText,report)}));
        for(const row of result.results)trace({stage:'Email candidates',status:'ok',detail:`${row.name}: ${row.candidates.map(c=>`${c.email} [${c.format}]`).join(', ')}. All unverified.`,source:row.source});
        for(const c of db.contacts.filter(c=>c.domain===domain))c.candidates=rankCandidates(c.name,domain,c.sourceText||'',report);
        save();
      } else trace({stage:'Email patterns',status:'skipped',detail:domain?'No recruiters found to analyze':'No company domain established'});
      trace({stage:'Search',status:result.results.length&&domain?'ok':'partial',detail:`Finished: domain ${domain||'unresolved'}, ${result.results.length} recruiters`});
      debug.running=false;result.diagnostics=debug;
      discoveryCache.set(key,{time:Date.now(),result});if(discoveryCache.size>20)discoveryCache.delete(discoveryCache.keys().next().value);
      lastDiscovery=result;return result;
    } finally{discovering=false;debug.running=false;}
  }
  // What actually happened to each RocketReach format at this domain: emails that stuck versus bounces, from the outreach history.
  function formatEvidence(domain, report) {
    const stats = {}, formats = (report?.reportedPatterns || []).map(p => p.format);
    if (!domain || !formats.length) return stats;
    for (const h of db.history) {
      if (h.test || !['sent','bounced'].includes(h.status) || !String(h.to || '').toLowerCase().endsWith('@' + domain)) continue;
      const contact = db.contacts.find(c => c.id === h.contactId); if (!contact) continue;
      const format = formats.find(f => candidateForFormat(contact.name, domain, f) === h.to.toLowerCase()); if (!format) continue;
      const entry = stats[format] ||= { sent: 0, bounced: 0 };
      entry[h.status]++;
    }
    return stats;
  }
  function saveContacts(search, domain, sources) {
    if(!Array.isArray(sources)||!sources.length||sources.length>8)throw fail('Select 1–8 profiles to save.');
    const selected=search.results.filter(row=>sources.includes(row.source));
    if(selected.length!==new Set(sources).size)throw fail('Only profiles from your search can be saved.');
    const contacts=[],contactIds=[];let refreshed=0;
    for(const row of selected){
      const fresh={name:row.name,title:row.title,company:search.company,domain,alternateDomains:search.alternateDomains||[],sourceText:row.sourceText,focus:row.focus,candidates:rankCandidates(row.name,domain,row.sourceText,db.patterns[domain]),discovery:{association:row.association,basis:row.basis,profileStatus:row.profileStatus,observedCompany:row.observedCompany||null,searchedAt:search.searchedAt,employerConfirmed:false}};
      const existing=db.contacts.find(c=>c.source===row.source||(c.name.toLowerCase()===row.name.toLowerCase()&&c.domain===domain));
      if(existing){
        // A newer search supersedes what was saved before (a corrected company spelling or domain must not linger).
        if(existing.domain!==domain||existing.company!==search.company)existing.selected=null;
        Object.assign(existing,fresh);refreshed++;contactIds.push(existing.id);continue;
      }
      const contact={id:randomUUID(),source:row.source,created:new Date().toISOString(),selected:null,...fresh};
      contacts.push(contact);contactIds.push(contact.id);
    }
    db.contacts.unshift(...contacts);save();return {saved:contacts.length,refreshed,skipped:selected.length-contacts.length,contactIds};
  }
  function prepareBatch(owner,{recipients,subject,message,multipleCandidates=false,attachResume=false,overrides=null}) {
    if(!db.tokens)throw fail('Connect Gmail before reviewing the sending batch.',401);
    if(attachResume)loadResume();
    let rows;try{rows=buildBatch(recipients,db.contacts,db.history,db.tokens.email,subject,message,multipleCandidates);}catch(e){throw fail(e.message);}
    // Text a reviewer edited by hand travels with the person to any later address.
    if(overrides)for(const row of rows){const edit=overrides[row.id];if(edit){row.subject=edit.subject;row.message=edit.message;row.edited=true;}}
    const batch={id:randomUUID(),owner,from:db.tokens.email,created:new Date().toISOString(),status:'draft',multipleCandidates,attachResume,attachment:attachResume?db.resume.filename:null,template:{subject:String(subject||''),message:String(message||'')},rows};
    db.batches=db.batches.filter(b=>b.status!=='draft'||Date.now()-Date.parse(b.created)<600000);
    db.batches.unshift(batch);save();return publicBatch(batch);
  }
  // ---- Verified runs ----
  // One authorization covers a bounded plan: send to ONE recruiter at the top format and watch for a bounce;
  // on a bounce try that person's next format; once a format sticks, email everyone else at it and retry
  // stragglers at their next address. The server timer drives it, so closing the page never strands a run.
  const RUN_OWNER = id => `run:${id}`;
  const RUN_WATCH = services.watchSeconds ?? 60, RUN_CHECK = 10, RUN_MAX_ATTEMPTS = 3;
  const now = services.now || (() => Date.now());
  db.runs ||= [];
  for (const run of db.runs) if (run.status === 'running') { run.status = 'interrupted'; run.error = 'The app restarted while this run was in progress. Resume to continue.'; }
  const runLog = (run, status, detail) => { run.log.push({ at: new Date(now()).toISOString(), status, detail: String(detail).slice(0, 300) }); if (run.log.length > 80) run.log.shift(); };
  const tried = email => db.history.some(h => h.to === email && ['sent','pending','uncertain','bounced'].includes(h.status));
  const runAttempts = (run, id) => db.history.filter(h => h.contactId === id && !h.test && Date.parse(h.date) >= Date.parse(run.startedAt) - 1000);
  const byFormat = (contact, format) => contact.candidates.find(c => c.format === format && !tried(c.email)) || null;
  const formatOf = (contact, email) => contact?.candidates.find(c => c.email === email)?.format || '';
  const activeRun = () => db.runs.find(r => r.status === 'running');
  function createRunFromBatch(owner, batchId) {
    const batch = db.batches.find(b => b.id === batchId && b.owner === owner);
    if (!batch || batch.status !== 'draft') throw fail('This batch is unavailable or has already been started. Review the batch again.', 409);
    if (Date.now() - Date.parse(batch.created) > 600000) throw fail('The preview expired. Review the batch again.');
    if (!db.tokens || db.tokens.email !== batch.from) throw fail('The connected Gmail account changed. Review the batch again.', 401);
    if (activeRun()) throw fail('Another run is still in progress. Open it from the Find page and let it finish first.', 409);
    if (batch.attachResume) loadResume();
    const overrides = Object.fromEntries(batch.rows.filter(r => r.edited).map(r => [r.id, { subject: r.subject, message: r.message }]));
    const mode = bounceDetection() ? 'verified' : 'direct';
    const first = db.contacts.find(c => c.id === batch.rows[0]?.id);
    const primary = first ? contactDomain(first) : '';
    const alternates = [...new Set(batch.rows.flatMap(r => db.contacts.find(c => c.id === r.id)?.alternateDomains || []))].filter(d => d && d !== primary);
    const run = { id: randomUUID(), owner, company: first?.company || '', domain: primary, originalDomain: primary, probeDomain: primary, alternates, startedAt: new Date(now()).toISOString(), finishedAt: null, template: batch.template, attachResume: batch.attachResume, overrides, people: batch.rows.map(r => ({ id: r.id, name: r.name })), probeIndex: 0, stage: mode === 'verified' ? 'probe' : 'rest', mode, status: 'running', verifiedFormat: null, wave: null, log: [], error: null, draftBatchId: batch.id };
    batch.status = 'consumed';
    db.runs.unshift(run); if (db.runs.length > 50) db.runs.length = 50;
    runLog(run, 'ok', mode === 'verified' ? `Run started for ${run.people.length} recruiter${run.people.length === 1 ? '' : 's'}: verifying the email format on one person first.` : 'Run started without bounce detection: sending to everyone at their top address.');
    if (mode === 'verified' && run.alternates.length && domainLooksDead(primary)) runLog(run, 'partial', `Every earlier email to @${primary} bounced and none got through, so ${run.alternates[0]} is tested first with the same RocketReach formats.`);
    save(); return run;
  }
  async function sendWave(run, kind, recipients) {
    const batchIds = [];
    for (let i = 0; i < recipients.length; i += 8) {
      const chunk = recipients.slice(i, i + 8);
      const batch = prepareBatch(RUN_OWNER(run.id), { recipients: chunk, subject: run.template.subject, message: run.template.message, attachResume: run.attachResume, overrides: run.overrides });
      const sent = await sendBatch(RUN_OWNER(run.id), batch.id, true);
      batchIds.push(sent.id);
      if (sent.status !== 'complete') { run.status = 'stopped'; run.error = sent.rows.find(r => r.error)?.error || 'Gmail did not confirm every email.'; runLog(run, 'error', run.error); save(); return; }
    }
    run.wave = { kind, batchIds, contactIds: recipients.map(r => r.id), sentAt: new Date(now()).toISOString(), lastCheck: null, checks: 0 };
    runLog(run, 'ok', `${kind === 'probe' ? 'Probe sent' : kind === 'rest' ? 'Sent' : 'Retry sent'}: ${recipients.map(r => r.to).join(', ')}.${run.mode === 'verified' ? ` Watching for bounces for ${RUN_WATCH}s.` : ''}`);
    save();
  }
  // Candidates for a person at a domain other than the one they were saved with reuse the company's RocketReach formats.
  const contactDomain = contact => contact.domain || contact.candidates?.[0]?.email.split('@')[1] || '';
  const candidatesAt = (contact, domain) => !domain || contactDomain(contact) === domain ? contact.candidates : rankCandidates(contact.name, domain, '', db.patterns[contactDomain(contact)] || db.patterns[domain] || null);
  const attemptsAt = (run, id, domain) => domain ? runAttempts(run, id).filter(h => h.to.toLowerCase().endsWith('@' + domain)).length : runAttempts(run, id).length;
  // A domain where several addresses already bounced and none ever got through is probed last, not first.
  const domainLooksDead = domain => { const rows = db.history.filter(h => !h.test && h.to.toLowerCase().endsWith('@' + domain)); return rows.filter(h => h.status === 'bounced').length >= 3 && !rows.some(h => h.status === 'sent'); };
  const probeOrder = run => run.alternates.length && domainLooksDead(run.domain) ? [...run.alternates, run.domain] : [run.domain, ...run.alternates];
  async function startNextStep(run) {
    if (run.stage === 'probe') {
      while (run.probeIndex < run.people.length) {
        const person = run.people[run.probeIndex], contact = db.contacts.find(c => c.id === person.id);
        // A resumed run whose probe already got through (possibly via a later run) must not email that person again.
        const delivered = runAttempts(run, person.id).find(h => h.status === 'sent');
        if (delivered) { run.verifiedFormat = formatOf(contact, delivered.to) || run.verifiedFormat; run.stage = 'rest'; runLog(run, 'ok', `${delivered.to} already got through; using the “${run.verifiedFormat}” format for everyone else.`); save(); return startNextStep(run); }
        if (contact) for (const domain of probeOrder(run)) {
          if (attemptsAt(run, person.id, domain) >= RUN_MAX_ATTEMPTS) continue;
          const candidate = candidatesAt(contact, domain).find(c => !tried(c.email));
          if (!candidate) continue;
          if (!contact.candidates.some(c => c.email === candidate.email)) contact.candidates.push({ ...candidate, evidence: `Fallback domain ${domain}; ${candidate.evidence || 'format reused'}` });
          run.probeDomain = domain;
          runLog(run, 'running', `Testing the “${candidate.format}” format on ${person.name} (${candidate.email})${domain !== run.domain ? ` — fallback domain ${domain}` : ''}.`);
          return sendWave(run, 'probe', [{ id: person.id, to: candidate.email }]);
        }
        runLog(run, 'partial', `${person.name}: no address left to try at ${[run.domain, ...run.alternates].join(', ')}; testing on the next person.`); run.probeIndex++;
      }
      run.status = 'complete'; run.finishedAt = new Date(now()).toISOString(); runLog(run, 'empty', 'Every address for everyone bounced; nothing left to try.'); save(); return;
    }
    const recipients = [];
    for (const person of run.people) {
      const contact = db.contacts.find(c => c.id === person.id); if (!contact) continue;
      const attempts = runAttempts(run, person.id);
      if (attempts.some(h => ['sent','pending','uncertain'].includes(h.status)) || attempts.length >= RUN_MAX_ATTEMPTS) continue;
      const candidate = (run.verifiedFormat && byFormat(contact, run.verifiedFormat)) || nextCandidate(contact, db.history);
      if (candidate) recipients.push({ id: person.id, to: candidate.email });
      else if (attempts.length) runLog(run, 'partial', `${person.name}: every address bounced.`);
    }
    if (!recipients.length) { run.status = 'complete'; run.finishedAt = new Date(now()).toISOString(); runLog(run, 'ok', 'Run complete.'); save(); return; }
    return sendWave(run, run.stage === 'rest' ? 'rest' : 'retry', recipients);
  }
  async function finishWave(run) {
    const wave = run.wave, rows = wave.batchIds.flatMap(id => db.batches.find(b => b.id === id)?.rows || []);
    const watched = Math.round((now() - Date.parse(wave.sentAt)) / 1000);
    run.wave = null; run.finishedWaves = [...(run.finishedWaves || []), ...wave.batchIds];
    if (wave.kind === 'probe') {
      const row = rows[0], contact = db.contacts.find(c => c.id === row.id);
      if (row.status === 'bounced') { runLog(run, 'error', `${row.to} bounced after ${watched}s; trying the next format.`); return startNextStep(run); }
      if (row.status !== 'sent') { run.status = 'stopped'; run.error = row.error || 'Gmail did not confirm the probe email.'; save(); return; }
      run.verifiedFormat = formatOf(contact, row.to); run.stage = 'rest';
      runLog(run, 'ok', `No bounce for ${row.to} within ${RUN_WATCH}s — using the “${run.verifiedFormat}” format for everyone else.`);
      if (run.probeDomain !== run.domain) {
        // The saved domain was wrong for this company; move everyone in the run to the domain that delivered.
        const from = run.domain; run.domain = run.probeDomain;
        for (const p of run.people) { const c = db.contacts.find(x => x.id === p.id); if (c && c.domain !== run.domain) { c.candidates = rankCandidates(c.name, run.domain, c.sourceText || '', db.patterns[c.domain] || db.patterns[run.domain] || null); c.domain = run.domain; c.selected = null; } }
        runLog(run, 'ok', `Switched the email domain from ${from} to ${run.domain} for everyone in this run.`);
      }
      db.verifiedDomains[companyKeyOf(run.company)] = { domain: run.domain, format: run.verifiedFormat, verifiedAt: new Date(now()).toISOString(), run: run.id };
      save();
      return startNextStep(run);
    }
    const bounced = rows.filter(r => r.status === 'bounced');
    if (bounced.length) runLog(run, 'error', `Bounced after ${watched}s: ${bounced.map(r => r.to).join(', ')}. Trying their next addresses.`);
    else runLog(run, 'ok', `No bounces within ${RUN_WATCH}s.`);
    run.stage = 'retry';
    return startNextStep(run);
  }
  // One lock for everything that moves a run, so the start/resume handlers and the timer never race each other.
  let advancing = false;
  async function withRunLock(fn) {
    while (advancing) await new Promise(resolve => setTimeout(resolve, 50));
    advancing = true;
    try { return await fn(); } finally { advancing = false; }
  }
  async function advanceRuns() {
    if (advancing) return; advancing = true;
    const run = activeRun();
    try {
      if (!run) return;
      if (!run.wave) { await startNextStep(run); return; }
      if (run.mode !== 'verified') { run.status = 'complete'; run.finishedAt = new Date(now()).toISOString(); runLog(run, 'partial', 'Bounce detection is off, so addresses were not verified. Reconnect Gmail once to enable it.'); save(); return; }
      const elapsed = (now() - Date.parse(run.wave.sentAt)) / 1000;
      const sinceCheck = run.wave.lastCheck ? (now() - Date.parse(run.wave.lastCheck)) / 1000 : Infinity;
      if (sinceCheck >= RUN_CHECK || elapsed >= RUN_WATCH) {
        for (const id of run.wave.batchIds) await checkBounces(id, { owner: RUN_OWNER(run.id), prepareRetry: false });
        run.wave.lastCheck = new Date(now()).toISOString(); run.wave.checks++; save();
      }
      // A bounce settles an address immediately; the full watch is only for addresses that may still be fine.
      const rows = run.wave.batchIds.flatMap(id => db.batches.find(b => b.id === id)?.rows || []);
      const settled = rows.length > 0 && rows.every(r => r.status !== 'sent');
      if (elapsed >= RUN_WATCH || settled) await finishWave(run);
    } catch (error) {
      if (run && run.status === 'running') { run.status = 'stopped'; run.error = error.message; runLog(run, 'error', error.message); save(); }
    } finally { advancing = false; }
  }
  const runTimer = setInterval(() => { advanceRuns().catch(() => {}); }, 5000); runTimer.unref?.();
  function runSnapshot(run) {
    const elapsed = run.wave ? (now() - Date.parse(run.wave.sentAt)) / 1000 : 0;
    const people = run.people.map(p => {
      const contact = db.contacts.find(c => c.id === p.id);
      const attempts = runAttempts(run, p.id).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).map(h => ({ to: h.to, format: formatOf(contact, h.to), status: h.status, date: h.date, bounce: h.bounce || null }));
      const last = attempts.at(-1), waiting = !!run.wave?.contactIds.includes(p.id);
      const outcome = !last ? 'queued' : last.status === 'sent' ? (waiting && run.status === 'running' ? 'watching' : 'reached') : last.status === 'bounced' ? (contact && nextCandidate(contact, db.history) && attempts.length < RUN_MAX_ATTEMPTS && run.status === 'running' ? 'retrying' : 'exhausted') : last.status;
      return { id: p.id, name: p.name, title: contact?.title || '', attempts, outcome };
    });
    const count = outcome => people.filter(p => p.outcome === outcome).length;
    return { id: run.id, company: run.company, domain: run.domain, originalDomain: run.originalDomain, alternates: run.alternates || [], status: run.status, stage: run.stage, mode: run.mode, verifiedFormat: run.verifiedFormat, error: run.error, stoppedBy: run.stoppedBy || null, startedAt: run.startedAt, finishedAt: run.finishedAt, attachment: run.attachResume ? db.resume?.filename || null : null, watchSeconds: RUN_WATCH, wave: run.wave ? { kind: run.wave.kind, secondsLeft: Math.max(0, Math.round(RUN_WATCH - elapsed)), checks: run.wave.checks, contactIds: run.wave.contactIds } : null, people, summary: { reached: count('reached'), watching: count('watching'), retrying: count('retrying'), exhausted: count('exhausted'), queued: count('queued') }, log: run.log.slice(-25) };
  }
  // Newest first: a run that completed later supersedes an older paused one on the Find page.
  const recentRun = () => activeRun() || db.runs.find(r => ['stopped','interrupted'].includes(r.status) || (r.finishedAt && now() - Date.parse(r.finishedAt) < 3600000)) || null;
  async function resumeRun(id) {
    const run = db.runs.find(r => r.id === id); if (!run) throw fail('Run not found.', 404);
    if (!['stopped','interrupted'].includes(run.status)) throw fail('This run is not paused.');
    if (activeRun()) throw fail('Another run is still in progress.', 409);
    run.status = 'running'; run.error = null; run.stoppedBy = null; runLog(run, 'ok', 'Resumed.');
    // If the last wave actually went out, keep watching it instead of sending again.
    const latest = db.batches.find(b => b.owner === RUN_OWNER(run.id) && b.status === 'complete' && Date.parse(b.created) >= Date.parse(run.startedAt) - 1000);
    const unresolved = latest && latest.rows.some(r => r.status === 'sent') && !run.finishedWaves?.includes(latest.id);
    if (unresolved) { run.wave = { kind: run.stage === 'probe' ? 'probe' : run.stage === 'rest' ? 'rest' : 'retry', batchIds: [latest.id], contactIds: latest.rows.map(r => r.id), sentAt: latest.created, lastCheck: null, checks: 0 }; runLog(run, 'running', `Still watching ${latest.rows.map(r => r.to).join(', ')} for bounces.`); save(); return run; }
    run.wave = null; await startNextStep(run); save(); return run;
  }
  // An explicit stop: nothing more goes out. Emails already handed to Gmail cannot be recalled. Resume picks up where it left off.
  function stopRun(id) {
    const run = db.runs.find(r => r.id === id); if (!run) throw fail('Run not found.', 404);
    if (run.status !== 'running') throw fail('This run is not running.');
    const watching = run.wave ? db.batches.filter(b => run.wave.batchIds.includes(b.id)).flatMap(b => b.rows.map(r => r.to)) : [];
    run.status = 'stopped'; run.stoppedBy = 'user'; run.error = 'Stopped by you. Nothing more will be sent unless you resume.';
    runLog(run, 'partial', `Stopped by you.${watching.length ? ` ${watching.join(', ')} had already been sent and cannot be recalled; no further addresses will be tried.` : ' No further addresses will be tried.'}`);
    save(); return run;
  }
  // Reviewers may rewrite any email in a draft batch before authorizing it; each edit is validated exactly like a generated one.
  function updateBatch(owner,batchId,rows) {
    const batch=db.batches.find(b=>b.id===batchId&&b.owner===owner);
    if(!batch||batch.status!=='draft')throw fail('This batch is unavailable or has already been started. Review the batch again.',409);
    if(Date.now()-Date.parse(batch.created)>600000)throw fail('The preview expired. Review the batch again.');
    if(!Array.isArray(rows)||!rows.length||rows.length>batch.rows.length)throw fail('Choose which emails to change.');
    const changes=rows.map(edit=>{
      const row=batch.rows.find(r=>r.id===edit?.id&&r.to===edit?.to);
      if(!row)throw fail('That email is not part of this batch. Review the batch again.');
      const subject=String(edit.subject??row.subject).trim(),message=String(edit.message??row.message).replace(/\r\n/g,'\n').trim();
      try{mimeMessage({to:row.to,from:batch.from,subject,message});}catch(e){throw fail(`${row.name}: ${e.message}`);}
      return {row,subject,message};
    });
    for(const {row,subject,message} of changes){row.subject=subject;row.message=message;row.edited=subject!==personalize(batch.template.subject,{name:row.name,company:db.contacts.find(c=>c.id===row.id)?.company||''},row.to)||message!==personalize(batch.template.message,{name:row.name,company:db.contacts.find(c=>c.id===row.id)?.company||''},row.to);}
    save();return publicBatch(batch);
  }
  async function sendBatch(owner,batchId,confirmed) {
    if(confirmed!==true)throw fail('Review and confirm the batch before sending.');
    if(sending)throw fail('A send is already in progress.',409);
    const batch=db.batches.find(b=>b.id===batchId&&b.owner===owner);
    if(!batch||batch.status!=='draft')throw fail('This batch is unavailable or has already been started. Check outreach history.',409);
    if(Date.now()-Date.parse(batch.created)>600000)throw fail('The preview expired. Review the batch again.');
    if(!db.tokens||db.tokens.email!==batch.from)throw fail('The connected Gmail account changed. Review the batch again.',401);
    if(batch.rows.some(row=>outreachBlocked(db.history,row.id,row.to,batch.multipleCandidates)))throw fail('A recipient already has outreach. Review the batch again.',409);
    const attachment=batch.attachResume?loadResume():null;
    sending=true;
    try{
      const token=await accessToken();
      if(bounceDetection())try{batch.historyId=String((await gmail('profile',token)).historyId||'');}catch{ batch.historyId=''; }
      batch.status='sending';save();
      for(const row of batch.rows){
        const c=db.contacts.find(c=>c.id===row.id);
        try{c.selected=row.to;row.status='pending';save();const record=await deliver(c,row.to,row.subject,row.message,token,attachment);row.status=record.status;row.messageId=record.messageId;}
        catch(e){row.status=db.history.find(h=>h.contactId===row.id&&h.to===row.to)?.status||'failed';row.error=e.message;batch.status='stopped';save();break;}
        save();
      }
      if(batch.status==='sending')batch.status='complete';save();return publicBatch(batch);
    }finally{sending=false;}
  }
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
  const bounceDetection = () => !!db.tokens?.scopes?.split(' ').includes(METADATA_SCOPE);
  async function gmail(path, token) {
    const { response, data } = await remote('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw Object.assign(fail(`Gmail request failed (${response.status}).`, 502), { gmailStatus: response.status });
    return data;
  }
  const header = (message, name) => message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  // Scans inbox headers added since the batch was sent and marks rows whose address a mail server rejected.
  async function checkBounces(batchId, { owner = null, prepareRetry = true } = {}) {
    const batch = db.batches.find(b => b.id === batchId && (owner === null || b.owner === owner));
    if (!batch) throw fail('Batch not found.', 404);
    if (!bounceDetection()) throw fail('Bounce detection needs the Gmail "message headers" permission. Reconnect Gmail in Connections once to enable it.', 403);
    const token = await accessToken();
    let ids = [];
    try { const history = await gmail(`history?startHistoryId=${encodeURIComponent(batch.historyId || '1')}&historyTypes=messageAdded&labelId=INBOX&maxResults=100`, token); ids = [...new Set((history.history || []).flatMap(h => (h.messagesAdded || []).map(x => x.message?.id)).filter(Boolean))]; }
    catch { const list = await gmail('messages?labelIds=INBOX&maxResults=30', token); ids = (list.messages || []).map(m => m.id); }
    const since = Date.parse(batch.created) - 60000;
    const seen = new Set(batch.bounceMessages || []);
    const newlyBounced = [];
    for (const id of ids.slice(0, 50)) {
      if (seen.has(id)) continue;
      const message = await gmail(`messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=X-Failed-Recipients&metadataHeaders=In-Reply-To`, token);
      if (Number(message.internalDate || 0) < since) continue;
      const from = header(message, 'From'), subject = header(message, 'Subject');
      if (!/mailer-daemon|postmaster/i.test(from) && !BOUNCE_SUBJECT.test(subject)) continue;
      seen.add(id);
      const failed = header(message, 'X-Failed-Recipients').toLowerCase().split(/[,\s]+/).filter(Boolean);
      const replyTo = header(message, 'In-Reply-To').replace(/[<>]/g, '');
      for (const row of batch.rows) {
        if (row.status !== 'sent') continue;
        if (!failed.includes(row.to.toLowerCase()) && !(replyTo && row.messageId === replyTo)) continue;
        row.status = 'bounced'; row.bounce = { at: new Date().toISOString(), subject: subject.slice(0, 200) };
        const record = db.history.find(h => h.contactId === row.id && h.to === row.to && h.status === 'sent');
        if (record) { record.status = 'bounced'; record.bounce = row.bounce; }
        newlyBounced.push(row);
      }
    }
    batch.bounceMessages = [...seen]; batch.bounceCheckedAt = new Date().toISOString(); batch.bounceChecks = (batch.bounceChecks || 0) + 1;
    const rows = batch.rows.map(row => { const contact = db.contacts.find(c => c.id === row.id); const next = row.status === 'bounced' && contact ? nextCandidate(contact, db.history) : null; return { ...row, next: next ? { email: next.email, format: next.format, percentage: next.percentage ?? null } : null }; });
    const retries = rows.filter(row => row.next).map(row => ({ id: row.id, to: row.next.email }));
    let retryBatch = null;
    if (prepareRetry && retries.length && batch.template) { try { retryBatch = prepareBatch(owner || batch.owner, { recipients: retries, subject: batch.template.subject, message: batch.template.message, attachResume: batch.attachResume }); retryBatch.retryOf = batch.id; } catch (error) { batch.retryError = error.message; } }
    save();
    return { checkedAt: batch.bounceCheckedAt, scanned: ids.length, newlyBounced: newlyBounced.length, bounced: rows.filter(r => r.status === 'bounced').length, rows, retryBatch, retryError: batch.retryError || null };
  }
  async function deliver(c,to,subject,message,token,attachment=null,test=false) {
    const messageId=`${randomUUID()}@recruiter-outreach.local`;
    const raw=mimeMessage({to,from:db.tokens.email,subject,message,attachment,messageId});
    const record={id:randomUUID(),contactId:c.id,name:c.name,to,from:db.tokens.email,subject,message,attachment:attachment?.filename||null,test,messageId,date:new Date().toISOString(),status:'pending'};
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
      const extensionHeader = req.headers['x-extension-token'];
      const viaExtension = extensionHeader !== undefined;
      if (viaExtension && extensionHeader !== db.extensionToken) throw fail('Invalid extension token. Copy it again from Connections in the Recruiter Outreach app.',403);
      if (!viaExtension && req.headers.origin && req.headers.origin !== ORIGIN) throw fail('Request origin is not allowed.',403);
      let sid = '', session = extensionSession;
      if (!viaExtension) {
        sid = /(?:^|;\s*)recruiter_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        if (!sid || !sessions.has(sid)) {
          sid = random(); sessions.set(sid, { csrf: random(), created: Date.now() });
          res.setHeader('Set-Cookie',`recruiter_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
        }
        session = sessions.get(sid);
        if (Date.now() - session.created > 86400000) { sessions.delete(sid); throw fail('Refresh the page to renew the local session.',401); }
      }
      const url = new URL(req.url, ORIGIN), path = url.pathname;
      if (viaExtension !== path.startsWith('/api/extension/')) throw fail(viaExtension ? 'Not available to the extension.' : 'Extension token required.',403);
      let body = {};
      if (req.method === 'POST') {
        if (!viaExtension && (req.headers.origin !== ORIGIN || req.headers['x-csrf-token'] !== session.csrf)) throw fail('Refresh the page and try again.',403);
        if (!req.headers['content-type']?.startsWith('application/json')) throw fail('JSON body required.',415);
        const limit = path === '/api/resume' ? 8000000 : 100000;
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > limit) throw fail(path === '/api/resume' ? 'The resume must be 5 MB or smaller.' : 'The supplied text is too large.',413); }
        try { body = JSON.parse(raw || '{}'); } catch { throw fail('Invalid JSON.'); }
      } else if (req.method !== 'GET') throw fail('Method not allowed.',405);
      if (path === '/api/status' && req.method === 'GET') {
        const cfg = config();
        return json({ csrf: session.csrf, configured: !!(cfg.client_id && cfg.client_secret), redirect: cfg.redirect_uri, searchProviders: apiProviders(getEnv()).map(p => p.label), connected: !!db.tokens, account: db.tokens?.email || null, contacts: db.contacts, history: db.history, patterns: db.patterns, batches: db.batches.map(publicBatch), template: db.template, resume: db.resume, profile: publicConfig(), extensionToken: db.extensionToken, extensionPath: extensionDir, bounceDetection: bounceDetection(), activeRun: recentRun() ? runSnapshot(recentRun()) : null });
      }
      if (path === '/api/extension/status' && req.method === 'GET') {
        return json({ ok:true, connected:!!db.tokens, account:db.tokens?.email||null, resume:db.resume?{filename:db.resume.filename,size:db.resume.size}:null, template:!!(db.template.subject?.trim()&&db.template.message?.trim()), searchProviders:apiProviders(getEnv()).map(p=>p.label), busy:discovering||sending, bounceDetection:bounceDetection() });
      }
      if (path === '/api/extension/bounces' && req.method === 'POST') {
        return json(await checkBounces(String(body.batchId||''),{owner:'extension'}));
      }
      // Verified runs (extension). The authorize click is the single confirmation for the whole bounded plan.
      if (path === '/api/extension/run/start' && req.method === 'POST') {
        if(body.confirmed!==true)throw fail('Review and confirm before starting the run.');
        const run=await withRunLock(async()=>{const r=createRunFromBatch('extension',String(body.batchId||''));await startNextStep(r);return r;});return json({run:runSnapshot(run)});
      }
      if (path === '/api/extension/run' && req.method === 'GET') {
        const run=db.runs.find(r=>r.id===url.searchParams.get('id'));if(!run)throw fail('Run not found.',404);return json({run:runSnapshot(run)});
      }
      if (path === '/api/extension/run/active' && req.method === 'GET') { const run=recentRun();return json({run:run?runSnapshot(run):null}); }
      if (path === '/api/extension/run/resume' && req.method === 'POST') { return json({run:runSnapshot(await withRunLock(()=>resumeRun(String(body.runId||''))))}); }
      if (path === '/api/extension/run/stop' && req.method === 'POST') { return json({run:runSnapshot(await withRunLock(()=>stopRun(String(body.runId||''))))}); }
      if (path === '/api/run/start' && req.method === 'POST') {
        if(body.confirmed!==true)throw fail('Review and confirm before starting the run.');
        const run=await withRunLock(async()=>{const r=createRunFromBatch(sid,String(body.batchId||''));await startNextStep(r);return r;});return json({run:runSnapshot(run)});
      }
      if (path === '/api/run' && req.method === 'GET') {
        const run=db.runs.find(r=>r.id===url.searchParams.get('id'));if(!run)throw fail('Run not found.',404);return json({run:runSnapshot(run)});
      }
      if (path === '/api/run/active' && req.method === 'GET') { const run=recentRun();return json({run:run?runSnapshot(run):null}); }
      if (path === '/api/run/resume' && req.method === 'POST') { return json({run:runSnapshot(await withRunLock(()=>resumeRun(String(body.runId||''))))}); }
      if (path === '/api/run/stop' && req.method === 'POST') { return json({run:runSnapshot(await withRunLock(()=>stopRun(String(body.runId||''))))}); }
      if (path === '/api/run/tick' && req.method === 'POST') { await advanceRuns();const run=recentRun();return json({run:run?runSnapshot(run):null}); }
      if (path === '/api/batch/bounces' && req.method === 'POST') {
        return json(await checkBounces(String(body.batchId||''),{owner:sid}));
      }
      // Outreach history: re-scan every sent batch (from the app or the extension) that reached these people.
      if (path === '/api/history/bounces' && req.method === 'POST') {
        const ids=new Set(Array.isArray(body.contactIds)?body.contactIds.map(String):[]);
        const recent=Date.now()-30*86400000;
        const batches=db.batches.filter(b=>['complete','stopped'].includes(b.status)&&Date.parse(b.created)>recent&&b.rows.some(r=>ids.size?ids.has(r.id):true));
        let newlyBounced=0;
        for(const b of batches){const result=await checkBounces(b.id,{prepareRetry:false});newlyBounced+=result.newlyBounced;}
        return json({batches:batches.length,newlyBounced,checkedAt:new Date().toISOString()});
      }
      if (path === '/api/extension/progress' && req.method === 'GET') {
        return json(extensionDebug ? { company:extensionDebug.company, running:extensionDebug.running, events:extensionDebug.events.slice(-6) } : { company:'', running:false, events:[] });
      }
      if (path === '/api/extension/preview' && req.method === 'POST') {
        const company=String(body.company||'').trim().slice(0,100);
        if(company.length<2)throw fail('Enter a company name.');
        if(!db.tokens)throw fail('Connect Gmail in the Recruiter Outreach app first.',401);
        if(!db.template.subject?.trim()||!db.template.message?.trim())throw fail('Set a default email in the Recruiter Outreach app first.');
        loadResume();
        const result=await runDiscovery(company,{fresh:body.fresh===true,onDebug:d=>{extensionDebug=d;},domainHint:String(body.siteHint||'').trim().slice(0,100),pageUrl:String(body.pageUrl||'').slice(0,500)});
        const discovery={company:result.company,domain:result.domain,domainMessage:result.domainResolution?.message||'',provider:result.provider,warnings:result.warnings,formats:result.patternReport?.reportedPatterns?.length||0,topFormat:result.patternReport?.reportedPatterns?.[0]?{format:result.patternReport.reportedPatterns[0].format,percentage:result.patternReport.reportedPatterns[0].percentage}:null,results:result.results.map(r=>({name:r.name,title:r.title,focus:r.focus,source:r.source,candidates:r.candidates.map(c=>({email:c.email,format:c.format,percentage:c.percentage??null}))}))};
        if(!result.results.length)return json({discovery,recipients:[],batch:null,reason:'No recruiters were found for this company. Check the Requests tab in the app.'});
        if(!result.domain)return json({discovery,recipients:[],batch:null,reason:result.domainResolution?.message||'The company email domain could not be established.'});
        const {contactIds}=saveContacts(result,result.domain,result.results.map(r=>r.source));
        const recipients=automaticRecipients(db.contacts,contactIds,db.history);
        const ready=recipients.filter(r=>!r.skipped).slice(0,8);
        const rows=recipients.map(r=>({name:r.contact.name,company:r.contact.company,email:r.email,skipped:r.skipped}));
        if(!ready.length)return json({discovery,recipients:rows,batch:null,reason:'Everyone found here was already contacted.'});
        const batch=prepareBatch('extension',{recipients:ready.map(r=>({id:r.contact.id,to:r.email})),subject:db.template.subject,message:db.template.message,attachResume:true});
        return json({discovery,recipients:rows,batch,reason:''});
      }
      if (path === '/api/extension/update' && req.method === 'POST') {
        return json({batch:updateBatch('extension',String(body.batchId||''),body.rows)});
      }
      if (path === '/api/extension/send' && req.method === 'POST') {
        return json({batch:await sendBatch('extension',String(body.batchId||''),body.confirmed===true)});
      }
      // The Requests and Find tabs show the most recent search from any source, including the Chrome extension.
      if (path === '/api/discover/status' && req.method === 'GET') {
        return json(lastDebug || session.searchDebug || {company:'',running:false,events:[]});
      }
      if (path === '/api/discover/last' && req.method === 'GET') {
        return json(lastDiscovery || session.discovery || null);
      }
      if (path === '/api/auth/start' && req.method === 'POST') {
        const cfg = config();
        if (!cfg.client_id || !cfg.client_secret) throw fail('Add your OAuth client ID and secret to .env.local.');
        if (cfg.redirect_uri !== CALLBACK) throw fail('Set GOOGLE_REDIRECT_URI to ' + CALLBACK);
        session.oauth = { state: random(), verifier: random(), expires: Date.now() + 600000 };
        const params = new URLSearchParams({ client_id: cfg.client_id, redirect_uri: cfg.redirect_uri, response_type: 'code', scope: `openid email ${SEND_SCOPE} ${METADATA_SCOPE}`, access_type: 'offline', prompt: 'consent', state: session.oauth.state, code_challenge: createHash('sha256').update(session.oauth.verifier).digest('base64url'), code_challenge_method: 'S256' });
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
          db.tokens = { access_token: data.access_token, refresh_token: data.refresh_token, expires: Date.now() + data.expires_in * 1000, email: identity.data.email, scopes: data.scope };
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
        const company=String(body.company || '').trim(), domain=body.domain?domainOf(body.domain):'';
        const result=await runDiscovery(company,{domain,fresh:body.fresh===true,onDebug:d=>{session.searchDebug=d;}});
        session.discovery=result;return json(result);
      }
      if (path === '/api/discover/save' && req.method === 'POST') {
        const search=session.discovery;if(!search)throw fail('Run a company search first.');
        return json(saveContacts(search,domainOf(body.domain||search.domain),body.sources));
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
        try { const records = await mx(c.domain); status = records.some(r => r.exchange && r.exchange !== '.') ? 'domain_ready' : 'no_mx'; message = status === 'domain_ready' ? 'Domain has mail servers. Individual mailboxes remain unverified.' : 'No usable MX records found. This does not verify individual addresses.'; }
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
        return json({batch:prepareBatch(sid,{recipients:body.recipients,subject:body.subject,message:body.message,multipleCandidates:body.multipleCandidates===true,attachResume:body.attachResume===true})});
      }
      if (path === '/api/batch/update' && req.method === 'POST') {
        return json({batch:updateBatch(sid,String(body.batchId||''),body.rows)});
      }
      if (path === '/api/batch/send' && req.method === 'POST') {
        return json({batch:await sendBatch(sid,String(body.batchId||''),body.confirmed===true)});
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
