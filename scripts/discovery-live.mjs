import { discoverRecruiters, profileUrl } from '../server/discovery.mjs';
import { parseProfileHtml } from '../server/profile.mjs';
import { load } from 'cheerio';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadEnv } from 'vite';
const env = loadEnv('development', process.cwd(), '');
const company = process.argv[2] || 'Apple';
const events = [];
const directory = '.local-data/research/linkedin';
mkdirSync(directory, { recursive: true });
const report = { company, checkedAt: new Date().toISOString(), events };
try {
 const urls=process.argv.slice(3).filter(arg=>arg.startsWith('https://'));
 if(urls.length){
 report.pages=[];
 for(const value of urls){
   const url=new URL(value);
   if(url.hostname!=='www.linkedin.com'||url.port||url.username||url.password||(!profileUrl(value)&&url.pathname!=='/search/results/people/'))throw new Error('Only LinkedIn profiles or People search URLs are supported.');
   const page={url:value};report.pages.push(page);
   try{
     const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'User-Agent':'RecruiterFinder/1.0 (local personal research)','Accept':'text/html'}});
     page.status=response.status;page.location=response.headers.get('location');
     const reader=response.body.getReader(),chunks=[];let size=0;
     while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1500000){await reader.cancel();throw new Error('Page exceeds size limit.');}chunks.push(Buffer.from(part.value));}
     const html=Buffer.concat(chunks).toString('utf8');page.bytes=size;
     page.bodyFile=`${directory}/page-${Date.now()}-${report.pages.length}.html`;writeFileSync(page.bodyFile,html);
     const $=load(html);page.title=$('title').text();$('script,style,noscript').remove();page.textPreview=$('body').text().replace(/\s+/g,' ').trim().slice(0,800);
     if(response.ok&&profileUrl(value)){const parsed=parseProfileHtml(html,value);page.profile={name:parsed.name,title:parsed.title,company:parsed.company,extraction:parsed.extraction};}
     if(response.ok&&!profileUrl(value))page.profileLinks=[...new Set($('a[href]').map((_,el)=>profileUrl($(el).attr('href'))).get().filter(Boolean))];
   }catch(error){page.error=error.message;}
   console.log(JSON.stringify(page,null,2));
 }
 }else{
 const result=await discoverRecruiters(company,'',fetch,event=>{events.push(event);console.log(JSON.stringify(event));},{env});
 report.result = result;
 console.log(JSON.stringify({provider:result.provider,count:result.results.length,warnings:result.warnings,profiles:result.results.map(r=>({name:r.name,source:r.source,title:r.title,profileStatus:r.profileStatus,basis:r.basis}))},null,2));
 if (!result.results.length) process.exitCode = 1;
 }
} catch(e) { report.error=e.message; console.error(e.message);process.exitCode=1; }
const file = `${directory}/${company.toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${report.pages?'pages':'discovery'}.json`;
writeFileSync(file, JSON.stringify(report,null,2));
console.log(`Saved diagnostics: ${file}`);
