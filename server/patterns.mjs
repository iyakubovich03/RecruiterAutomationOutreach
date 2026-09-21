import { candidates, candidateForFormat, domainOf } from './core.mjs';
import { findRocketReach } from './rocketreach.mjs';
import { publicPage } from './public-page.mjs';

// RocketReach is the only format source. Generic name-based guesses are
// offered only when it reports nothing for the domain.
export function rankCandidates(name,domain,text,report) {
 const base=candidates(name,domain,text);
 // A format that already delivered at this domain (a run's probe that never bounced) outranks RocketReach's percentages.
 const verified=report?.verifiedFormat||'';
 const reported=(report?.reportedPatterns||[]).map(pattern=>{
   const email=candidateForFormat(name,domain,pattern.format);
   if(!email)return null;
   const share=pattern.percentage===null?'':` (${pattern.percentage}%)`;
   return pattern.format===verified
     ?{email,format:pattern.format,status:'unverified',reported:true,percentage:pattern.percentage,source:pattern.source,verified:report.verifiedAt||true,evidence:`Delivered without a bounce${report.verifiedAt?` on ${String(report.verifiedAt).slice(0,10)}`:''}; RocketReach reports ${pattern.format}${share}`}
     :{email,format:pattern.format,status:'unverified',reported:true,percentage:pattern.percentage,source:pattern.source,evidence:`RocketReach reports ${pattern.format}${share}; mailbox unverified`};
 }).filter(Boolean).sort((a,b)=>Number(!!b.verified)-Number(!!a.verified)||(b.percentage||0)-(a.percentage||0));
 if(!reported.length)return base;
 const unique=new Map();
 for(const c of [...base.filter(c=>c.format==='Imported address'),...reported])if(!unique.has(c.email))unique.set(c.email,c);
 return [...unique.values()];
}
export async function findPatterns(domain,read=publicPage,{onEvent=()=>{},company='',env={},fetcher=fetch,rocketReachUrls=[]}={}) {
 domain=domainOf(domain);
 const rocket=await findRocketReach(domain,{read,onEvent,company,env,fetcher,urls:rocketReachUrls});
 return {domain,checkedAt:new Date().toISOString(),reportedPatterns:rocket.patterns,sources:rocket.sources,warnings:rocket.warnings};
}
