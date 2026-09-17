import { load } from 'cheerio';
const compact = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const badName = /\b(linkedin|sign in|sign up|join now|security verification|recruiter|recruiting|talent acquisition|contact info|experience|education|connections|followers|people also viewed|profiles|page not found)\b/i;
export function fullName(value) {
  const name = compact(value).replace(/\s*\|\s*LinkedIn.*$/i,'').split(/\s+[-–—]\s+/)[0].replace(/\s*\([^)]*\)\s*/g,' ').replace(/,\s*(?:MBA|PhD|PHR|SPHR|SHRM.*|MA|MS|MSc|BA|BS|PMP).*$/i,'').replace(/\s*[·•]\s*(?:1st|2nd|3rd).*$/i,'').trim();
  const words = name.split(/\s+/);
  return name.length <= 100 && words.length >= 2 && words.length <= 7 && !badName.test(name) && /^[\p{L}\p{M} .’'\-]+$/u.test(name) ? name : '';
}
function headlineDetails(value) {
  const headline = compact(value);
  const at = headline.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[|·•]\s*|$)/i);
  return { title: at ? at[1] : headline, company: at ? at[2] : '' };
}
export function extractEmails(text) {
  // Limited, explicit obfuscations only; no inferred mailbox ownership.
  text = text.replace(/\s*\[at\]\s*/gi,'@').replace(/\s*\[dot\]\s*/gi,'.');
  return [...new Set((text.match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)||[]).map(x=>x.toLowerCase()))].slice(0,30);
}
function result({name='',title='',company='',text='',method='',warnings=[]}) {
  if (!name) warnings.push('A full name could not be identified. Enter it manually before generating candidates.');
  const emails = extractEmails(text);
  const domains = [...new Set(emails.map(x=>x.split('@')[1]).filter(x=>!['gmail.com','outlook.com','hotmail.com','yahoo.com','icloud.com','linkedin.com'].includes(x)))];
  return { name, title, company, domain:domains.length===1?domains[0]:'', sourceText:text.slice(0,20000), extraction:{ method, emails, warnings:[...warnings,'Confirm the current employer and company email domain. Published addresses still need an ownership check.'] } };
}
export function parseProfileText(text) {
  const lines = text.split(/\n/).map(compact).filter(Boolean);
  const name = lines.map(fullName).find(Boolean)||'';
  const recruitingLines = lines.filter(x=>/recruit|talent acquisition|early careers|campus|university relations/i.test(x));
  const headline = recruitingLines.find(x=>/\s(?:at|@)\s/i.test(x)) || recruitingLines[0] || '';
  return result({name,...headlineDetails(headline),text,method:'Pasted profile text'});
}
export function parseProfileHtml(html, profileUrl='') {
  const $ = load(html);
  const pageTitle=compact($('title').first().text());
  if (/^(?:LinkedIn\s*[-|:]\s*)?(?:sign in|sign up|login|join|security verification|authwall|page not found)/i.test(pageTitle)) throw new Error('LinkedIn returned a sign-in or unavailable page. Paste the visible profile text instead.');
  const nodes=[];
  function visit(value,depth=0) { if(depth>20||nodes.length>2000)return; if(Array.isArray(value)){for(const x of value)visit(x,depth+1);}else if(value&&typeof value==='object'){nodes.push(value);for(const v of Object.values(value))visit(v,depth+1);} }
  $('script[type="application/ld+json"]').each((_,el)=>{try{visit(JSON.parse($(el).text()));}catch{/* Other metadata can still be used. */}});
  const isPerson = node => [node?.['@type']].flat().some(t=>typeof t==='string'&&/(?:^|\/)Person$/.test(t));
  const people=nodes.filter(isPerson).filter(p=>fullName(p.name || [p.givenName,p.familyName].filter(Boolean).join(' ')));
  const visible = fullName($('main h1, h1.top-card-layout__title, h1').first().text());
  const normalizeUrl = value => {try{const u=new URL(value);return u.hostname.replace(/^www\./,'')+u.pathname.replace(/\/$/,'');}catch{return '';}};
  const target=normalizeUrl(profileUrl);
  const refs=nodes.filter(n=>['ProfilePage','WebPage'].includes(n['@type'])).map(n=>n.mainEntity).flat().filter(Boolean);
  const refIds=new Set(refs.map(r=>typeof r==='string'?r:r['@id']).filter(Boolean));
  let person=people.find(p=>refs.includes(p)||refIds.has(p['@id']));
  if(!person&&target)person=people.find(p=>[p.url,p['@id'],...(Array.isArray(p.sameAs)?p.sameAs:[])].some(u=>typeof u==='string'&&normalizeUrl(u)===target));
  if(!person&&visible)person=people.find(p=>fullName(p.name).toLowerCase()===visible.toLowerCase());
  if(!person&&people.length===1&&!visible)person=people[0];
  const og=compact($('meta[property="og:title"]').attr('content'));
  const metaName=fullName([$('meta[property="profile:first_name"]').attr('content'),$('meta[property="profile:last_name"]').attr('content')].filter(Boolean).join(' '));
  const personName=person ? fullName(person.name || [person.givenName,person.familyName].filter(Boolean).join(' ')) : '';
  const name=personName||visible||metaName||fullName(og)||fullName(pageTitle);
  const method=personName?'Structured profile data':visible?'Profile heading':metaName?'Profile name metadata':name?'Page title metadata':'No reliable name found';
  const warnings=[];
  if(personName&&visible&&personName.toLowerCase()!==visible.toLowerCase())warnings.push('The profile heading and structured name disagree. Review the name carefully.');
  const description=compact($('meta[name="description"],meta[property="og:description"]').first().attr('content'));
  const subtitle=compact($('.top-card-layout__headline, [data-test-id="headline"]').first().text());
  const titleParts=(og||pageTitle).replace(/\s*\|\s*LinkedIn.*$/i,'').split(/\s+[-–—]\s+/);
  const titleHeadline=titleParts.slice(1).join(' - ');
  const details=headlineDetails(compact(person?.jobTitle)||subtitle||titleHeadline);
  let employer = person?.worksFor;
  if(Array.isArray(employer)) { if(employer.length===1)employer=employer[0];else {employer=null;warnings.push('Multiple employers are listed. Enter the current company manually.');} }
  if(employer?.['@id']&&!employer.name)employer=nodes.find(n=>n['@id']===employer['@id']&&n.name)||employer;
  const company=compact(typeof employer==='string'?employer:employer?.name)||details.company;
  const mailtos=$('a[href^="mailto:"]').map((_,el)=>$(el).attr('href').slice(7).split('?')[0]).get().join('\n');
  const structuredEmail=typeof person?.email==='string'?person.email.replace(/^mailto:/i,''):'';
  $('script,style,noscript,nav,footer').remove();
  const main=$('main').length?$('main'):$('body');
  main.find('br').replaceWith('\n'); main.find('p,div,section,h1,h2,h3,li').append('\n');
  const visibleText=main.text().split('\n').map(compact).filter(Boolean).join('\n');
  const text=[name,details.title,company,description,structuredEmail,mailtos,visibleText].filter(Boolean).join('\n').slice(0,20000);
  return result({name,title:details.title,company,text,method,warnings});
}
