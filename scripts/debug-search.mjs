import { discoverCompanyDomain } from '../server/company-domain.mjs';
import { discoverRecruiters } from '../server/discovery.mjs';
import { loadEnv } from 'vite';
const env=loadEnv('development',process.cwd(),'');
const company=process.argv[2]||'Google';
const events=[];const trace=e=>{const row={...e,at:new Date().toISOString()};events.push(row);console.log(JSON.stringify(row));};
const domain=await discoverCompanyDomain(company,{onEvent:trace,env});
console.log(JSON.stringify({stage:'Domain result',...domain}));
try{const result=await discoverRecruiters(company,domain.domain,fetch,trace,{env});console.log(JSON.stringify({stage:'Final result',domain:domain.domain,recruiters:result.results.length,warnings:result.warnings}));}catch(e){console.log(JSON.stringify({stage:'Final error',message:e.message}));process.exitCode=1;}
