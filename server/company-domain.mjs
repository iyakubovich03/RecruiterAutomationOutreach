import { load } from 'cheerio';
import { resolveMx } from 'node:dns/promises';
import { domainOf } from './core.mjs';
import { extractEmails } from './profile.mjs';
import { publicPage } from './public-page.mjs';
import { parseSearchHtml, searchWeb } from './search.mjs';

const normalize = value => String(value || '').toLowerCase().replace(/\b(incorporated|inc|corporation|corp|limited|ltd|llc)\b/g,'').replace(/[^\p{L}\p{N}]/gu,'');
const excluded = /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|wikipedia\.org|crunchbase\.com|zoominfo\.com|rocketreach\.co|indeed\.com|glassdoor\.com|youtube\.com|x\.com|twitter\.com|duckduckgo\.com|bing\.com|gmail\.com|outlook\.com|yahoo\.com)$/i;
function companyRows(rows) {
 const seen=new Set();
 return rows.flatMap(row=>{try{const u=new URL(row.url);if(u.protocol!=='https:'||u.username||u.password||u.port||excluded.test(u.hostname)||seen.has(u.hostname))return [];seen.add(u.hostname);return [{url:u.href,title:row.title}];}catch{return [];}});
}
export function companySearchResults(html,provider) { return companyRows(parseSearchHtml(html,provider)); }
export function websiteEvidence(html,source,company) {
 const $=load(html),siteDomain=domainOf(source),wanted=normalize(company),orgs=[];
 function visit(value,depth=0){if(depth>15)return;if(Array.isArray(value)){value.forEach(v=>visit(v,depth+1));return;}if(!value||typeof value!=='object')return;
   if([value['@type']].flat().some(t=>typeof t==='string'&&/(?:^|\/)(Organization|Corporation)$/.test(t))&&[value.name,value.legalName,value.alternateName].flat().some(n=>normalize(n)===wanted))orgs.push(value);
   Object.values(value).forEach(v=>visit(v,depth+1));
 }
 $('script[type="application/ld+json"]').each((_,el)=>{try{visit(JSON.parse($(el).text()));}catch{}});
 const title=$('title').text(),siteName=$('meta[property="og:site_name"]').attr('content')||'';
 const titleMatch=title.toLowerCase().includes(company.toLowerCase()),brandHost=normalize(siteDomain.split('.')[0])===wanted;
 const matchedOrg=orgs.find(org=>{try{return !org.url||domainOf(org.url)===siteDomain;}catch{return false;}});
 const score=matchedOrg?4:normalize(siteName)===wanted&&titleMatch?3:brandHost&&titleMatch?2:0;
 if(!score)return null;
 const orgEmails=extractEmails([matchedOrg?.email,...[matchedOrg?.contactPoint].flat().map(c=>c?.email)].filter(Boolean).join(' '));
 const ownEmails=extractEmails($('a[href^="mailto:"]').map((_,el)=>$(el).attr('href')).get().join(' ')).filter(e=>e.split('@')[1]===siteDomain);
 const explicit=[...new Set([...orgEmails,...ownEmails].map(e=>e.split('@')[1]).filter(d=>!excluded.test(d)))];
 return {websiteDomain:siteDomain,emailDomains:explicit,score,source,title,method:explicit.length?'Published company contact address':'Company website; email domain inferred'};
}
export async function discoverCompanyDomain(company,{read=publicPage,mx=resolveMx,onEvent=()=>{},env={},fetcher=fetch}={}) {
 company=String(company||'').trim();if(company.length<2||company.length>100)throw new Error('Enter a company name between 2 and 100 characters.');
 const query=`"${company.replaceAll('"','')}" official website contact`;
 const search=await searchWeb(query,{env,fetcher,read,onEvent,stage:'Domain search',accept:rows=>companyRows(rows).length>0});
 const links=companyRows(search.rows);
 onEvent({stage:'Domain search',status:links.length?'ok':'empty',detail:`${links.length} candidate website links`});
 const evidence=[];
 for(const row of links.slice(0,4)){onEvent({stage:'Company website',status:'running',detail:'Reading company identity evidence',source:row.url});try{const item=websiteEvidence(await read(row.url),row.url,company);if(item)evidence.push(item);onEvent({stage:'Company website',status:item?'ok':'rejected',detail:item?`Matched ${item.websiteDomain}; evidence score ${item.score}; published email domains: ${item.emailDomains.join(', ')||'none'}`:'Page did not match the company identity rules',source:row.url});}catch(e){onEvent({stage:'Company website',status:'error',detail:e.message,source:row.url});}}
 evidence.sort((a,b)=>b.score-a.score);
 if(!evidence.length)return {domain:'',status:'unresolved',sources:[],message:'An official company domain could not be established from the accessible public pages. Try a more specific company name.'};
 const strongest=evidence.filter(e=>e.score===evidence[0].score);
 let domains=[...new Set(strongest.flatMap(e=>e.emailDomains.length?e.emailDomains:[e.websiteDomain]))];
 const lookupMx=d=>Promise.race([mx(d),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('DNS timeout')),4000);timer.unref();})]);
 const mxRecords=new Map();let routed=[];
 if(domains.length>1){
   // Regional sites (amazon.in, amazon.ae) usually route mail through the primary domain's servers.
   for(const d of domains){try{mxRecords.set(d,await lookupMx(d));}catch{mxRecords.set(d,null);}}
   const parentOf=d=>{const records=mxRecords.get(d);if(!records?.length)return '';return domains.find(p=>p!==d&&records.every(r=>r.exchange&&(r.exchange===p||r.exchange.endsWith('.'+p))))||'';};
   routed=domains.filter(parentOf);
   if(routed.length){const remaining=domains.filter(d=>!parentOf(d));onEvent({stage:'Domain decision',status:remaining.length===1?'ok':'ambiguous',detail:`${routed.join(', ')} route mail through ${[...new Set(routed.map(parentOf))].join(', ')}; remaining: ${remaining.join(', ')}`});domains=remaining;}
 }
 if(domains.length!==1){onEvent({stage:'Domain decision',status:'ambiguous',detail:`Equally supported domains: ${domains.join(', ')}`});return {domain:'',status:'ambiguous',sources:strongest.map(e=>e.source),message:'Public sources point to multiple company email domains. No addresses were guessed across unrelated domains.'};}
 const domain=domains[0];let records;
 onEvent({stage:'Mail servers',status:'running',detail:`Checking MX records for ${domain}`});
 try{records=mxRecords.get(domain)||await lookupMx(domain);onEvent({stage:'Mail servers',status:records.some(r=>r.exchange&&r.exchange!=='.')?'ok':'empty',detail:`${domain}: ${records.map(r=>r.exchange).join(', ')||'no MX records'}`});}catch(e){onEvent({stage:'Mail servers',status:'error',detail:`${domain}: ${e.message}`});return {domain:'',status:'unresolved',sources:strongest.map(e=>e.source),message:'A company website was found, but its email domain could not be checked. Try again later.'};}
 if(!records.some(r=>r.exchange&&r.exchange!=='.'))return {domain:'',status:'unresolved',sources:strongest.map(e=>e.source),message:'The identified company domain has no usable mail-server records. Email discovery could not be completed.'};
 const published=strongest.some(e=>e.emailDomains.includes(domain));
 const mirrors=routed.length?` Regional sites (${routed.join(', ')}) route mail through this domain.`:'';
 return {domain,status:published?'published':'inferred',sources:strongest.map(e=>e.source),checkedAt:new Date().toISOString(),message:(published?'Email domain found in published company contact information; mail servers found.':'Company website identified and mail servers found. Employee email domain is inferred, not confirmed.')+mirrors};
}
