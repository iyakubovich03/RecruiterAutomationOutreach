import { candidates, candidateForFormat, domainOf } from './core.mjs';
import { findRocketReach } from './rocketreach.mjs';
import { publicPage } from './public-page.mjs';

// RocketReach is the only format source. Generic name-based guesses are
// offered only when it reports nothing for the domain.
export function rankCandidates(name,domain,text,report) {
 const base=candidates(name,domain,text);
 const reported=(report?.reportedPatterns||[]).map(pattern=>{
   const email=candidateForFormat(name,domain,pattern.format);
   return email?{email,format:pattern.format,status:'unverified',reported:true,percentage:pattern.percentage,source:pattern.source,evidence:`RocketReach reports ${pattern.format}${pattern.percentage===null?'':` (${pattern.percentage}%)`}; mailbox unverified`}:null;
 }).filter(Boolean).sort((a,b)=>(b.percentage||0)-(a.percentage||0));
 if(!reported.length)return base;
 const unique=new Map();
 for(const c of [...base.filter(c=>c.format==='Imported address'),...reported])if(!unique.has(c.email))unique.set(c.email,c);
 return [...unique.values()];
}
export async function findPatterns(domain,read=publicPage,{onEvent=()=>{},company='',env={},fetcher=fetch}={}) {
 domain=domainOf(domain);
 const rocket=await findRocketReach(domain,{read,onEvent,company,env,fetcher});
 return {domain,checkedAt:new Date().toISOString(),reportedPatterns:rocket.patterns,sources:rocket.sources,warnings:rocket.warnings};
}
