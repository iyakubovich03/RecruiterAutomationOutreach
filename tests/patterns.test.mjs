import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, findPatterns } from '../server/patterns.mjs';
import { publicIPv4, publicPage } from '../server/public-page.mjs';
import { parseRocketReach, findRocketReach, rocketreachUrl, rocketReachDomain, findRocketReachCompany, rankRocketReachPages } from '../server/rocketreach.mjs';
import { createPatternCache, patternExpiry } from '../server/pattern-cache.mjs';
const rocketSource='https://rocketreach.co/example-email-format_ab12';

test('rejects unsafe fetch schemes and private network ranges',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.1.1','::1','224.0.0.1'])assert.equal(publicIPv4(ip),false);
 assert.equal(publicIPv4('8.8.8.8'),true);
 for(const url of ['http://example.com','https://me:secret@example.com','https://example.com:999'])await assert.rejects(publicPage(url),/Only public HTTPS/);
});
test('candidates come only from RocketReach formats when it reports any; generic guesses otherwise',()=>{
 const report={reportedPatterns:[{format:'lastf',percentage:19.5,source:rocketSource},{format:'first.last',percentage:80.5,source:rocketSource}]};
 const ranked=rankCandidates('Alex Chen','example.com','',report);
 assert.deepEqual(ranked.map(c=>c.email),['alex.chen@example.com','chena@example.com']);
 assert.equal(ranked[0].percentage,80.5);assert.equal(ranked[0].status,'unverified');assert.equal(ranked[0].source,rocketSource);assert.match(ranked[0].evidence,/RocketReach reports first\.last \(80\.5%\)/);
 const imported=rankCandidates('Alex Chen','example.com','alex42@example.com',report);
 assert.equal(imported[0].format,'Imported address');assert.equal(imported.length,3);
 assert.equal(rankCandidates('Alex Chen','example.com','',null).length,6);
 assert.equal(rankCandidates('Alex Chen','example.com','',{reportedPatterns:[]}).length,6);
});

// Synthetic HTML fixtures: no assumption that live RocketReach pages are accessible.
test('RocketReach extracts explicit domain-matched formats and keeps reported percentages distinct from employee evidence',()=>{
 const report=parseRocketReach(`<table><tr><td>first '.' last</td><td>jane.smith@example.com</td><td>80.5%</td></tr><tr><td>last first_initial</td><td>smithj@example.com</td><td>19.5%</td></tr><tr><td>first</td><td>jane@unrelated.com</td><td>100%</td></tr></table>`,'example.com',rocketSource);
 assert.equal(report.patterns[0].format,'first.last');assert.equal(report.patterns[0].percentage,80.5);
 assert.equal(report.patterns.length,2);
});
test('RocketReach two-letter-initial notations become candidates exactly as RocketReach illustrates them',()=>{
 const report=parseRocketReach(`<table><tr><td>[first][last_initial_two]</td><td>janedo@example.com</td><td>2.0%</td></tr><tr><td>[first_initial_two][last]</td><td>jadoe@example.com</td><td>1.7%</td></tr><tr><td>[last][first_initial]</td><td>doej@example.com</td><td>19%</td></tr></table>`,'example.com',rocketSource);
 assert.deepEqual(report.patterns.map(p=>p.format),['firstl2','f2last','lastf']);assert.equal(report.unsupported.length,0);
 assert.deepEqual(rankCandidates('Jane Doe','example.com','',{reportedPatterns:report.patterns}).map(c=>c.email),['doej@example.com','janedo@example.com','jadoe@example.com']);
});
test('RocketReach rejects lookalike URLs, challenge pages and unrelated domains',()=>{
 assert.equal(rocketreachUrl('https://rocketreach.co.evil.org/example-email-format_ab12'),'');
 assert.equal(rocketreachUrl('https://rocketreach.co/person-profile'),'');
 assert.throws(()=>parseRocketReach('<p>Verify you are human</p>','example.com',rocketSource),/bot-check/);
 assert.equal(parseRocketReach('<p>first.last jane.smith@example.com.evil.org</p>','example.com',rocketSource).patterns.length,0);
});
test('RocketReach research traces fallback search, scraping failures and empty outcomes',async()=>{
 const events=[];const result=await findRocketReach('example.com',{onEvent:e=>events.push(e),read:async url=>{
 if(url.includes('duckduckgo'))throw new Error('HTTP 403');
 if(url.includes('bing.com'))return `<rss><channel><item><link>${rocketSource}</link></item></channel></rss>`;
 throw new Error('Page unavailable (403).');
 }});
 assert.equal(result.patterns.length,0);assert.equal(result.sources[0].status,'unavailable');
 assert.ok(events.some(e=>e.stage==='RocketReach search'&&e.status==='error'));
 assert.ok(events.some(e=>e.stage==='RocketReach page'&&e.detail.includes('403')));
});
test('format research uses only RocketReach and never runs public example searches',async()=>{
 const urls=[];
 const report=await findPatterns('example.com',async url=>{
 urls.push(url);
 if(url===rocketSource)return `<table><tr><td>last '.' first</td><td>smith.jane@example.com</td><td>92%</td></tr></table>`;
 if(decodeURIComponent(url).includes('rocketreach'))return `<div class="result"><a class="result__a" href="${rocketSource}">Format</a></div>`;
 throw new Error('Blocked');
 });
 assert.equal(report.reportedPatterns[0].format,'last.first');assert.equal(report.patterns,undefined);
 assert.ok(urls.every(u=>u===rocketSource||decodeURIComponent(u).includes('rocketreach')),urls.join('\n'));
 assert.equal(rankCandidates('Alex Chen','example.com','',report)[0].email,'chen.alex@example.com');
});
test('company-name search scrapes the returned suffix and rejects formats for unrelated domains',async()=>{
 const urls=[], target='https://rocketreach.co/apple-email-format_b5c4637df42e0dc3';
 const result=await findRocketReach('apple.com',{company:'Apple',read:async url=>{
 urls.push(url);
 if(url.includes('duckduckgo.com'))return `<div class="result"><a class="result__a" href="${target}">Apple Email Format</a></div>`;
 assert.equal(url,target);return '<table><tr><td>[first_initial][last]</td><td>jdoe@apple.com</td><td>90%</td></tr><tr><td>first</td><td>jane@unrelated.com</td><td>100%</td></tr></table>';
 }});
 assert.match(decodeURIComponent(urls[0]),/rocketreach Apple email format/);
 assert.equal(urls.length,2);assert.equal(result.patterns.length,1);assert.equal(result.patterns[0].source,target);
});
test('RocketReach company pages state the email domain, which disambiguates same-name companies',async()=>{
 const page='<title>Scale AI Email Format | scale.com Emails</title><table><tr><td>[first]</td><td>jane@scale.com</td><td>50%</td></tr><tr><td>[first][last]</td><td>janedoe@scale.com</td><td>30%</td></tr></table><p>support@rocketreach.co</p>';
 const url='https://rocketreach.co/scale-ai-email-format_1';
 assert.deepEqual(rocketReachDomain(page,url),{domain:'scale.com',source:url,title:'Scale AI Email Format | scale.com Emails',basis:'page title',mentions:2});
 assert.equal(rocketReachDomain('<title>Just a moment...</title><p>Verify you are human</p>',url),null);
 assert.equal(rocketReachDomain('<p>hello@example.org hello@example.org x@other.net</p>',url).domain,'example.org');
 const reads=[];
 const found=await findRocketReachCompany('Scale AI',{read:async u=>{reads.push(u);if(u.includes('duckduckgo'))return `<div class="result"><a class="result__a" href="${url}">Scale AI Email Format</a></div>`;if(u===url)return page;throw new Error('Blocked');}});
 assert.equal(found.domain,'scale.com');assert.deepEqual(found.urls,[url]);
 assert.equal(await findRocketReachCompany('Nobody Inc',{read:async()=>'<html></html>'}),null);
 const searched=[];
 const reused=await findRocketReach('scale.com',{company:'Scale AI',urls:[url],read:async u=>{searched.push(u);if(u===url)return page;throw new Error('must not search');}});
 assert.deepEqual(searched,[url]);assert.equal(reused.patterns[0].format,'first');
});
test('the top-ranked RocketReach page wins when several pages report the same domain',async()=>{
 const first='https://rocketreach.co/apple-email-format_1', second='https://rocketreach.co/apple-robotics-email-format_2';
 const result=await findRocketReach('apple.com',{company:'Apple',read:async url=>{
 if(url.includes('duckduckgo.com'))return `<div class="result"><a class="result__a" href="${first}">Apple</a><a class="result__a" href="${second}">Apple Robotics</a></div>`;
 return `<table><tr><td>[first_initial][last]</td><td>jdoe@apple.com</td><td>${url===first?'40':'70'}%</td></tr></table>`;
 }});
 assert.equal(result.patterns.length,1);assert.equal(result.patterns[0].percentage,40);assert.equal(result.patterns[0].source,first);
});
test('Google fallback unwraps actual result URLs and reports JavaScript-only responses',async()=>{
 const target='https://rocketreach.co/apple-email-format_b5c4637df42e0dc3';
 const result=await findRocketReach('apple.com',{company:'Apple',read:async url=>{
 if(url===target)return '<table><tr><td>first</td><td>jane@apple.com</td><td>8%</td></tr></table>';
 if(url.includes('www.google.com'))return `<a href="/url?q=${encodeURIComponent(target)}&amp;sa=U">Apple Email Format</a>`;
 throw new Error('Unavailable');
 }});
 assert.equal(result.patterns[0].source,target);
 const events=[];await findRocketReach('apple.com',{company:'Apple',onEvent:e=>events.push(e),read:async url=>url.includes('www.google.com')?'<a href="/httpservice/retry/enablejs">Enable JS</a>':'<html></html>'});
 assert.ok(events.some(e=>e.status==='error'&&e.detail.includes('JavaScript-required')));
});

const cachedReport = () => ({reportedPatterns:[{format:'flast',percentage:90,source:'https://rocketreach.co/apple-email-format_b5c4637df42e0dc3'}],sources:[],warnings:[]});
test('three-month calendar expiry handles month end and leap years',()=>{
 assert.equal(new Date(patternExpiry('2026-01-31T12:00:00Z')).toISOString(),'2026-04-30T12:00:00.000Z');
 assert.equal(new Date(patternExpiry('2023-11-30T12:00:00Z')).toISOString(),'2024-02-29T12:00:00.000Z');
});
test('formats persist and avoid repeat requests across restarts until three-month expiry',async()=>{
 let time=Date.parse('2026-01-31T12:00:00Z'),calls=0,disk;
 const reports={};const save=()=>{disk=JSON.parse(JSON.stringify(reports));};
 const research=async(domain,read,options)=>{calls++;assert.equal(domain,'apple.com');assert.equal(options.company,'Apple');return cachedReport();};
 let get=createPatternCache(reports,save,research,()=>time);
 const first=await get('Apple','APPLE.COM');assert.equal(first.cached,false);assert.equal(calls,1);assert.equal(first.report.expiresAt,'2026-04-30T12:00:00.000Z');
 get=createPatternCache(disk,()=>{},research,()=>time);
 time=Date.parse('2026-04-30T11:59:59Z');assert.equal((await get('Apple Inc.','apple.com')).cached,true);assert.equal(calls,1);
 time=Date.parse('2026-04-30T12:00:00Z');assert.equal((await get('Apple','apple.com')).cached,false);assert.equal(calls,2);
});
test('failed refresh retains original evidence and retries after one hour',async()=>{
 const original={...cachedReport(),checkedAt:'2026-01-01T00:00:00.000Z'};
 let time=Date.parse('2026-05-01T00:00:00Z'),calls=0;const reports={'apple.com':original};
 const get=createPatternCache(reports,()=>{},async()=>{calls++;throw new Error('HTTP 403');},()=>time);
 const result=await get('Apple','apple.com');assert.equal(result.stale,true);assert.equal(result.report.checkedAt,original.checkedAt);assert.deepEqual(result.report.reportedPatterns,original.reportedPatterns);assert.match(result.report.refreshError,/403/);
 await get('Apple','apple.com');assert.equal(calls,1);
 time+=3600000;await get('Apple','apple.com');assert.equal(calls,2);
});
test('empty research is not cached as a three-month success; same-name companies have separate domains',async()=>{
 let calls=0,time=Date.parse('2026-01-01T00:00:00Z');const reports={};
 const get=createPatternCache(reports,()=>{},async()=>{calls++;return {reportedPatterns:[],sources:[],warnings:[]};},()=>time);
 const result=await get('Example','one.example');assert.equal(result.report.expiresAt,undefined);
 await get('Example','one.example');assert.equal(calls,1);
 await get('Example','two.example');assert.equal(calls,2);
 time+=3600000;await get('Example','one.example');assert.equal(calls,3);
});
test('concurrent company lookups share one research request',async()=>{
 let finish,calls=0;
 const get=createPatternCache({},()=>{},async()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
 const one=get('Apple','apple.com'),two=get('Apple','apple.com');finish(cachedReport());
 const result=await Promise.all([one,two]);assert.equal(calls,1);assert.deepEqual(result[0],result[1]);
});

test('the RocketReach page named on the recruiters’ profiles outranks the first search hit',async()=>{
 const corp='https://rocketreach.co/mitsubishi-corporation-email-format_1', power='https://rocketreach.co/mitsubishi-power-americas-email-format_2', motors='https://rocketreach.co/mitsubishi-motors-north-america-inc-email-format_3';
 const rows=[{url:corp,title:'Mitsubishi Corporation Email Format | mitsubishicorp.com Emails'},{url:'https://leadiq.com/c/mitsubishi/email-format',title:'Mitsubishi Email Format'},{url:power,title:'Mitsubishi Power Americas Email Format | mhps.com Emails'},{url:motors,title:'Mitsubishi Motors North America, Inc. Email Format'}];
 const employers=['Senior Talent Acquisition Partner at Mitsubishi Power Americas','Recruiting @ Mitsubishi Power Americas · Experience: Mitsubishi Power Americas','Senior Talent Acquisition Business Partner at Mitsubishi Power Americas','Senior Manager Talent Acquisition at Mitsubishi Power Americas','Recruiting Specialist @ Mitsubishi ...','Recruiting Manager at Mitsubishi Electric Power Products, Inc.'];
 const ranked=rankRocketReachPages(rows,'Mitsubishi',employers);
 assert.deepEqual(ranked.map(p=>[p.url,p.employers]),[[power,4],[corp,2],[motors,0]]);
 // Bare-name profiles fit every entity, so the exact-name page wins only when nothing more specific is named.
 assert.equal(rankRocketReachPages(rows,'Mitsubishi',['Recruiter at Mitsubishi','Recruiter @ Mitsubishi'])[0].url,corp);
 assert.equal(rankRocketReachPages(rows,'Mitsubishi',[])[0].url,corp);
 const reads=[],events=[];
 const found=await findRocketReachCompany('Mitsubishi',{employers,onEvent:e=>events.push(e),read:async u=>{reads.push(u);if(u.includes('duckduckgo'))return rows.map(r=>`<div class="result"><a class="result__a" href="${r.url}">${r.title}</a></div>`).join('');if(u===power)return '<title>Mitsubishi Power Americas Email Format | mhps.com Emails</title><p>jane@mhps.com</p>';throw new Error('wrong page');}});
 assert.equal(found.domain,'mhps.com');assert.deepEqual(found.urls,[power,corp,motors]);assert.deepEqual(found.pages[0],{url:power,title:rows[2].title});
 // The search result title already states the domain, so a blocked or rate-limited RocketReach page cannot lose it.
 assert.equal(reads.filter(u=>u.includes('rocketreach.co')).length,0);
 assert.ok(events.some(e=>e.stage==='RocketReach company'&&/Chose “Mitsubishi Power Americas” \(named on 4 of 6 recruiter profiles\)/.test(e.detail)));
 assert.ok(events.some(e=>e.stage==='RocketReach company'&&/mhps\.com for Mitsubishi.*page not requested/.test(e.detail)));
});
test('format pages naming the wanted domain are read first, and a timed-out page is retried once',async()=>{
 const josef='https://rocketreach.co/josef-gartner-gmbh-email-format_1', gartner='https://rocketreach.co/gartner-email-format_2';
 const reads=[],events=[];let attempts=0;
 const result=await findRocketReach('gartner.com',{company:'Gartner',onEvent:e=>events.push(e),read:async url=>{
 if(url.includes('duckduckgo.com'))return `<div class="result"><a class="result__a" href="${josef}">Josef Gartner GmbH Email Format | josef-gartner.de Emails</a></div><div class="result"><a class="result__a" href="${gartner}">Gartner Email Format | gartner.com Emails</a></div>`;
 reads.push(url);
 if(url===gartner&&++attempts===1)throw new Error('Page request timed out.');
 return url===gartner?'<table><tr><td>[first].[last]</td><td>jane.doe@gartner.com</td><td>87%</td></tr></table>':'<title>Josef Gartner GmbH Email Format | josef-gartner.de Emails</title><p>x@josef-gartner.de</p>';
 }});
 assert.deepEqual(reads,[gartner,gartner]);assert.equal(result.patterns[0].format,'first.last');
 assert.ok(events.some(e=>e.stage==='RocketReach page'&&e.status==='partial'&&/Retrying once/.test(e.detail)));
 assert.ok(events.some(e=>e.stage==='RocketReach page'&&/Skipped without a request: this page is for josef-gartner\.de/.test(e.detail)));
 reads.length=0;
 const reused=await findRocketReach('gartner.com',{company:'Gartner',urls:[{url:josef,title:'Josef Gartner GmbH Email Format | josef-gartner.de Emails'},{url:gartner,title:'Gartner Email Format | gartner.com Emails'}],read:async url=>{reads.push(url);return '<table><tr><td>[first].[last]</td><td>jane.doe@gartner.com</td></tr></table>';}});
 assert.deepEqual(reads,[gartner]);assert.equal(reused.sources.length,1);
 const limited=await findRocketReach('gartner.com',{company:'Gartner',urls:[gartner],read:async()=>{throw new Error('Page unavailable (429).');}});
 assert.equal(limited.sources[0].status,'unavailable');assert.match(limited.warnings[0],/Page unavailable \(429\).*bot protection is challenging/);
});
test('a fresh search retries format research during the one-hour hold but keeps unexpired saved formats',async()=>{
 let calls=0,time=Date.parse('2026-01-01T00:00:00Z');const reports={};
 const get=createPatternCache(reports,()=>{},async()=>{calls++;return calls<3?{reportedPatterns:[],sources:[],warnings:[]}:cachedReport();},()=>time);
 await get('Example','one.example');await get('Example','one.example');assert.equal(calls,1);
 await get('Example','one.example',()=>{},{force:true});assert.equal(calls,2);
 await get('Example','one.example',()=>{},{force:true});assert.equal(calls,3);assert.equal(reports['one.example'].reportedPatterns.length,1);
 await get('Example','one.example',()=>{},{force:true});assert.equal(calls,3);
});

// Mirrors the real page structure saved from rocketreach.co/gartner-email-format on 2026-09-17.
const gartnerPage=(withTitle=true,withMeta=true,withTable=true)=>`<html><head>${withTitle?'<title>Gartner Email Format | gartner.com Emails</title>':'<title>Gartner Email Format</title>'}${withMeta?`<meta name="description" content="Gartner uses 13 email formats: 1. first '.' last@gartner.com (87.3%). Enter a name to find &amp; verify an email >>>">`:''}</head><body><nav>Log In Sign Up</nav><h1>Gartner Email Format</h1><p>Get Verified Emails for 22,044 Gartner Employees</p>${withTable?'<p>The most common Gartner email format is [first].[last] (ex. jane.doe@gartner.com), which is being used by 87.3% of Gartner work email addresses.</p><table><tr><th>Email Format</th><th>Example</th><th>Percentage</th></tr><tr><td>[first].[last]</td><td>jane.doe@gartner.com</td><td>87.3%</td></tr><tr><td>[first][last]</td><td>janedoe@gartner.com</td><td>3.9%</td></tr><tr><td>[last][first_initial]</td><td>doej@gartner.com</td><td>2.6%</td></tr></table>':''}<footer>support@rocketreach.co</footer></body></html>`;
test('the domain is read from the title, then the meta description, then the format table, never from RocketReach’s own addresses',()=>{
 const url='https://rocketreach.co/gartner-email-format_b5c611ccf42e0c4f';
 assert.deepEqual(rocketReachDomain(gartnerPage(),url),{domain:'gartner.com',source:url,title:'Gartner Email Format | gartner.com Emails',basis:'page title',mentions:4});
 assert.equal(rocketReachDomain(gartnerPage(false),url).basis,'meta description');
 assert.equal(rocketReachDomain(gartnerPage(false,false),url).basis,'format table examples');
 assert.equal(rocketReachDomain(gartnerPage(false,false,false),url),null);
 const report=parseRocketReach(gartnerPage(),'gartner.com',url);
 assert.deepEqual(report.patterns.map(p=>[p.format,p.percentage]),[['first.last',87.3],['firstlast',3.9],['lastf',2.6]]);
 assert.equal(parseRocketReach(gartnerPage(),'josef-gartner.de',url).patterns.length,0);
});
test('the RocketReach company search asks the API for site:rocketreach.co first, since a plain query can return only videos about RocketReach',async()=>{
 const queries=[];const page='https://rocketreach.co/figma-email-format_b5f1aa14f6b3a5a6';
 const fetcher=async url=>{const q=decodeURIComponent(new URL(String(url)).searchParams.get('q')||'');queries.push(q);
  return Response.json({organic_results:q.startsWith('site:rocketreach.co')?[{link:page,title:'Figma Email Format'}]:[{link:'https://www.youtube.com/watch?v=1',title:'How To Use RocketReach'}]});};
 const found=await findRocketReachCompany('Figma',{env:{SERPAPI_KEY:'k'},fetcher,read:async u=>{if(u===page)return '<title>Figma Email Format | figma.com Emails</title><p>jane@figma.com</p>';throw new Error('must not scrape '+u);}});
 assert.equal(found.domain,'figma.com');assert.deepEqual(queries,['site:rocketreach.co Figma email format']);
 // Without a search API the site: form is skipped (public search pages drop site:) and the plain query is scraped as before.
 const reads=[];const scraped=await findRocketReachCompany('Figma',{read:async u=>{reads.push(u);if(u.includes('duckduckgo'))return `<div class="result"><a class="result__a" href="${page}">Figma Email Format</a></div>`;if(u===page)return '<title>Figma Email Format | figma.com Emails</title>';throw new Error('x');}});
 assert.equal(scraped.domain,'figma.com');assert.match(decodeURIComponent(reads[0]),/rocketreach Figma email format/);
});
