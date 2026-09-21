import { fullName } from './profile.mjs';
import { candidates, domainOf, relevance, focusScore } from './core.mjs';
import { searchConfig } from './config.mjs';
import { parseSearchHtml, searchWeb } from './search.mjs';
const compact = text => String(text || '').replace(/\s+/g,' ').trim();
const error = (message,status=502) => Object.assign(new Error(message),{status});
export function profileUrl(value) {
  try {
    let url = new URL(value,'https://html.duckduckgo.com');
    if (['duckduckgo.com','html.duckduckgo.com'].includes(url.hostname) && url.searchParams.has('uddg')) url=new URL(url.searchParams.get('uddg'));
    if(url.protocol!=='https:'||!(url.hostname==='linkedin.com'||/^(www|[a-z]{2})\.linkedin\.com$/.test(url.hostname))||url.port||url.username||url.password||!/^\/in\/[a-zA-Z0-9_%\-]+\/?$/.test(url.pathname))return '';
    return 'https://www.linkedin.com'+url.pathname.replace(/\/$/,'');
  } catch {return '';}
}
function profileRows(rows) {
  const unique=new Map();
  for(const row of rows){const source=profileUrl(row.url);if(source&&!unique.has(source))unique.set(source,{source,headline:row.title,snippet:row.snippet});}
  return [...unique.values()];
}
export function parseSearchResults(html,provider) { return profileRows(parseSearchHtml(html,provider)); }
export function companyAssociation(row, company, config = searchConfig) {
  // Spacing-insensitive: a detected "Scaleai" still matches profiles that say "Scale AI".
  const escaped = compact(company).replace(/\s+/g,'').split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s*');
  const end = '(?=$|[^\\p{L}\\p{N}])';
  const headline = compact(row.headline).replace(/\s*\|\s*LinkedIn.*$/i,'');
  const snippet = compact(row.snippet);
  const all = headline + ' ' + snippet;
  const historical = new RegExp(`\\b(?:former(?:ly)?|previous(?:ly)?|past|ex[- ]|used to|worked at)\\b.{0,65}\\b${escaped}${end}`, 'iu');
  if (historical.test(all)) return null;
  const role = `\\b(?:${config.recruiterTerms.join('|')})\\b`;
  const atCompany = new RegExp(`${role}[^.!?;|]{0,100}(?:\\bat\\s+|@\\s*)${escaped}${end}`, 'iu');
  // Search snippets of LinkedIn profiles read "Location · Title · Company".
  const roleDotCompany = new RegExp(`${role}[^·|]{0,60}·\\s*${escaped}${end}`, 'iu');
  const companyRole = new RegExp(`\\b${escaped}\\s+(?:technical\\s+|university\\s+|campus\\s+)?recruit\\w*\\b`, 'iu');
  const headlineCompany = new RegExp(`(?:^|\\s[-–—|]\\s)${escaped}${end}\\s*$`, 'iu');
  const labeledCompany = new RegExp(`\\b(?:experience|current company|company|employer)\\s*:\\s*${escaped}${end}`, 'iu');
  // `observed` is the company as the profile spells it ("Scale AI" for a typed "Scaleai").
  const mention = new RegExp(`\\b${escaped}${end}`, 'iu');
  const found = (basis, text) => ({ basis, text, observed: compact((text.match(mention) || [])[0] || company) });
  if (headlineCompany.test(headline) || atCompany.test(headline) || companyRole.test(headline)) return found('LinkedIn search title', headline);
  if (atCompany.test(snippet) || roleDotCompany.test(snippet) || companyRole.test(snippet) || labeledCompany.test(snippet)) return found('LinkedIn search snippet', snippet);
  return null;
}
export function rankProfile(row,company,config=searchConfig) {
  const name=fullName(row.headline), all=compact(row.headline+' '+row.snippet);
  // Initial-only surnames cannot safely generate full-name email candidates.
  if(!name || name.split(/\s+/).some((part,i,parts)=>(i===0||i===parts.length-1)&&/^[a-z]\.?$/i.test(part)))return null;
  if(!config.recruiterPattern.test(all))return null;
  const association=companyAssociation(row,company,config);
  if(!association)return null;
  const title=row.headline.replace(/\s*\|\s*LinkedIn.*$/i,'').split(/\s+[-–—]\s+/).slice(1).join(' - ') || row.snippet;
  const focus=relevance(all,config);
  const score=focusScore(focus,config);
  return {...row,name,title:title.slice(0,250),company,observedCompany:association.observed,focus,score,sourceText:[row.headline,row.snippet].join('\n'),basis:'LinkedIn search result',association,profileStatus:'Name and company association extracted from search results',employerConfirmed:false};
}
async function readPublic(url,fetcher,timeout=10000) {
  const response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(timeout),headers:{'User-Agent':'RecruiterFinder/1.0 (local personal research)','Accept':'text/html, application/rss+xml, application/xml;q=0.9'}});
  if(!response.ok)throw error(`Public source unavailable (${response.status}).`);
  const reader=response.body?.getReader();if(!reader)throw error('Public source returned no content.');
  let text='',bytes=0;const decoder=new TextDecoder();
  while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>1500000){await reader.cancel();throw error('Public source response was too large.');}text+=decoder.decode(part.value,{stream:true});}
  return text+decoder.decode();
}
export async function discoverRecruiters(company, domain='', fetcher=fetch, onEvent=()=>{}, {env={},config=searchConfig}={}) {
  company=compact(company);
  if(company.length<2||company.length>100||!/[\p{L}\p{N}]/u.test(company))throw error('Enter a company name between 2 and 100 characters.',400);
  domain=domain?domainOf(domain):'';
  const safeCompany=company.replace(/["\r\n]/g,' ');
  const attempt=async query=>{
    let matched=[];
    const search=await searchWeb(query,{env,fetcher,read:url=>readPublic(url,fetcher),onEvent,stage:'Recruiter search',accept:results=>{
      const parsed=profileRows(results);
      matched=parsed.map(row=>rankProfile(row,company,config)).filter(Boolean);
      onEvent({stage:'Profile filter',status:matched.length?'ok':'empty',detail:`${parsed.length} unique LinkedIn profile links; ${matched.length} matched company, name, and recruiting filters; ${parsed.length-matched.length} excluded`});
      for(const row of parsed.filter(r=>!rankProfile(r,company,config)).slice(0,10))onEvent({stage:'Profile filter',status:'rejected',detail:`${row.headline} — missing a full name, recruiting role, or explicit company association; historical associations are excluded`,source:row.source});
      return matched.length>0;
    }});
    return {search,rows:search.rows.length?matched:[]};
  };
  let {search,rows}=await attempt(`site:linkedin.com/in/ "${safeCompany}" ${config.search.roleKeyword}`);
  if(!search.available)throw error('Automatic public search is currently blocked or unavailable. Try again later. No profiles were fabricated or imported.');
  if(!rows.length){
    // Exact-phrase searches miss spelling variants ("Scaleai" vs "Scale AI"); one unquoted retry is cheap.
    onEvent({stage:'Recruiter search',status:'partial',detail:'No profiles matched the exact company name; retrying without quotes.'});
    const second=await attempt(`site:linkedin.com/in/ ${safeCompany} ${config.search.roleKeyword}`);
    if(second.rows.length)({search,rows}=second);else search.warnings.push(...second.search.warnings.filter(w=>!search.warnings.includes(w)));
  }
  rows=rows.sort((a,b)=>b.score-a.score).slice(0,8);
  onEvent({stage:'Recruiter discovery',status:rows.length?'ok':'empty',detail:`${rows.length} recruiters extracted from LinkedIn search results (maximum 8).${rows.length?'':' No results met the full-name, recruiting-role, and explicit company-association filters.'}`});
  for(const row of rows)onEvent({stage:'Company association',status:'ok',detail:`${row.name}: ${row.association.text}. Search evidence; current employment is not independently confirmed.`,source:row.source});
  const spellings=new Map();
  for(const row of rows){const key=row.observedCompany.toLowerCase().replace(/\s+/g,'');const entry=spellings.get(key)||{name:row.observedCompany,count:0};entry.count++;spellings.set(key,entry);}
  const canonicalCompany=[...spellings.values()].sort((a,b)=>b.count-a.count)[0]?.name||company;
  return {company,canonicalCompany,domain,provider:search.provider||'Public search',searchedAt:new Date().toISOString(),warnings:search.warnings,results:rows.map(row=>({...row,candidates:domain?candidates(row.name,domain,row.sourceText):[]}))};
}
