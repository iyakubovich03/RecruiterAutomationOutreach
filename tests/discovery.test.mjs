import test from 'node:test';
import assert from 'node:assert/strict';
import { profileUrl,parseSearchResults,rankProfile,discoverRecruiters } from '../server/discovery.mjs';
const searchHtml=`<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fjane-smith%3Ftrk%3Dsearch">Jane Smith - University Recruiter at Example | LinkedIn</a><div class="result__snippet">Jane Smith recruits new graduate software engineers at Example.</div></div><div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith/">Jane Smith - Example Recruiter</a></div>`;
test('extracts search result names and snippets, unwraps URLs, and deduplicates profiles',()=>{
 const rows=parseSearchResults(searchHtml,'duckduckgo');assert.equal(rows.length,1);assert.equal(rows[0].source,'https://www.linkedin.com/in/jane-smith');
 const result=rankProfile(rows[0],'Example');assert.equal(result.name,'Jane Smith');assert.equal(result.focus,'Early careers');assert.equal(result.employerConfirmed,false);
});
test('discards unrelated companies, non-recruiters, and non-profile links',()=>{
 assert.equal(rankProfile({headline:'Jane Smith - Recruiter at Example',snippet:''},'Apple'),null);
 assert.equal(rankProfile({headline:'Jane Smith - Software Engineer at Example',snippet:''},'Example'),null);
 for(const u of ['https://linkedin.com/company/example','https://linkedin.com.evil.org/in/jane','https://evil.org/in/jane','http://127.0.0.1','https://user@linkedin.com/in/jane'])assert.equal(profileUrl(u),'');
 assert.equal(profileUrl('https://uk.linkedin.com/in/jane?trk=x'),'https://www.linkedin.com/in/jane');
});
test('extracts names and company evidence without requesting LinkedIn profiles',async()=>{
 const called=[];
 const result=await discoverRecruiters('Example','example.com',async url=>{called.push(String(url));if(String(url).includes('duckduckgo.com/html'))return new Response(searchHtml);return new Response('Blocked',{status:999});});
 assert.equal(result.results.length,1);assert.equal(called.length,1);assert.equal(result.results[0].name,'Jane Smith');assert.match(result.results[0].profileStatus,/search results/);assert.equal(result.results[0].candidates[0].email,'jane.smith@example.com');
});
test('falls back to RSS search and extracts recruiter evidence',async()=>{
 const result=await discoverRecruiters('Example','',async url=>{
   if(String(url).includes('duckduckgo'))return new Response('<form id="challenge-form">Challenge</form>');
   if(String(url).includes('bing.com'))return new Response('<rss><channel><item><title>Jane Smith - Technical Recruiter at Example | LinkedIn</title><link>https://www.linkedin.com/in/jane-smith</link><description>Recruiting for Example</description></item></channel></rss>');
   return new Response('<main><h1>Jane Smith</h1><div class="top-card-layout__headline">Technical Recruiter at Example</div></main>');
 });
 assert.equal(result.provider,'Bing public search');assert.equal(result.results.length,1);assert.equal(result.results[0].basis,'LinkedIn search result');assert.equal(result.results[0].candidates.length,0);assert.equal(result.warnings.length,1);
});
test('reports provider failure rather than returning a fabricated empty success',async()=>{
 await assert.rejects(discoverRecruiters('Example','',async()=>new Response('Blocked',{status:403})),/blocked or unavailable/);
});

test('company titles and explicit snippet employer fields retain association evidence',()=>{
 const result=rankProfile({source:'https://www.linkedin.com/in/markbenton',headline:'Mark Benton - Apple | LinkedIn',snippet:'Senior Technical Recruiter for Manufacturing Design & Operations.'},'Apple');
 assert.equal(result.name,'Mark Benton');assert.equal(result.association.basis,'LinkedIn search title');assert.match(result.association.text,/Apple/);assert.equal(result.employerConfirmed,false);
 const snippet=rankProfile({headline:'Jane Smith | LinkedIn',snippet:'Technical recruiter. Experience: Apple · Education: Example University'},'Apple');
 assert.equal(snippet.association.basis,'LinkedIn search snippet');
});
test('rejects incidental company mentions, historical roles, unrelated employers and partial names',()=>{
 for(const row of [
 {headline:'Jane Smith - Recruiter at OtherCo',snippet:'I like Apple products.'},
 {headline:'Jane Smith - Former recruiter at Apple',snippet:''},
 {headline:'Jane Smith - Recruiter at OtherCo',snippet:'Previously at Apple'},
 {headline:'Jane Smith - Ex-Apple Recruiter',snippet:''},
 {headline:'Jane Smith - Recruiter at Appleton',snippet:''},
 {headline:'Lee S. - Apple | LinkedIn',snippet:'Technical recruiter'},
 {headline:'J. Smith - Recruiter at Apple',snippet:''},
 ])assert.equal(rankProfile(row,'Apple'),null,JSON.stringify(row));
});
test('automatic discovery never requests individual profiles and traces company evidence',async()=>{
 const events=[];
 const result=await discoverRecruiters('Example','',async url=>{
 assert.match(String(url),/^https:\/\/html\.duckduckgo\.com/);
 return new Response(searchHtml);
 },event=>events.push(event));
 assert.equal(result.results.length,1);assert.ok(events.some(event=>event.stage==='Company association'));
 assert.ok(events.every(event=>event.stage!=='Profile page'));
});
test('search snippets using "@" and "·" separators count as company evidence',()=>{
 assert.ok(rankProfile({headline:'Susie Kim - University Recruiter @ Amazon | AUTA',snippet:''},'Amazon'));
 assert.equal(rankProfile({headline:'Katie Howard - Recruiter',snippet:'Chicago, Illinois, United States · Technical Recruiter · Amazon Web Services (AWS)'},'Amazon').association.basis,'LinkedIn search snippet');
 assert.equal(rankProfile({headline:'Jane Smith - Recruiter @ Amazonia',snippet:''},'Amazon'),null);
});
test('a configured search API key is used before public search pages and never leaks into diagnostics',async()=>{
 const called=[],events=[];
 const result=await discoverRecruiters('Example','example.com',async url=>{called.push(String(url));if(String(url).startsWith('https://www.googleapis.com/customsearch/v1'))return Response.json({items:[{link:'https://www.linkedin.com/in/jane-smith',title:'Jane Smith - University Recruiter at Example | LinkedIn',snippet:'Recruiter at Example'}]});throw new Error('unexpected request');},e=>events.push(e),{env:{GOOGLE_CSE_KEY:'secret-key',GOOGLE_CSE_ID:'cx1'}});
 assert.equal(called.length,1);assert.match(called[0],/key=secret-key/);assert.equal(result.provider,'Google Custom Search API');assert.equal(result.results[0].name,'Jane Smith');assert.equal(result.results[0].candidates[0].email,'jane.smith@example.com');
 assert.ok(events.every(e=>!String(e.source||'').includes('secret-key')&&!String(e.detail||'').includes('secret-key')));
});
test('company matching ignores spacing and the search retries unquoted when the exact phrase finds nobody',async()=>{
 assert.equal(rankProfile({headline:'Jane Smith - Technical Recruiter at Scale AI',snippet:''},'Scaleai').company,'Scaleai');
 assert.ok(rankProfile({headline:'Jane Smith - Recruiter @ ScaleAI',snippet:''},'Scale AI'));
 assert.equal(rankProfile({headline:'Jane Smith - Recruiter at Scale',snippet:''},'Scale AI'),null);
 const queries=[];
 const result=await discoverRecruiters('Scaleai','',async url=>{const q=decodeURIComponent(String(url));queries.push(q);if(!q.includes('duckduckgo'))return new Response('Blocked',{status:403});return new Response(q.includes('"Scaleai"')?'<div class="result"></div>':'<div class="result"><a class="result__a" href="https://www.linkedin.com/in/jane-smith">Jane Smith - University Recruiter at Scale AI | LinkedIn</a></div>');});
 assert.equal(result.results.length,1);assert.equal(result.results[0].name,'Jane Smith');
 assert.equal(result.results[0].observedCompany,'Scale AI');assert.equal(result.canonicalCompany,'Scale AI');assert.equal(result.company,'Scaleai');
 assert.equal(queries.filter(q=>q.includes('duckduckgo')).length,2);assert.match(queries.at(-1),/in\/ Scaleai recruiter/);
});
test('company names containing regular expression characters match literally',()=>{
 assert.ok(rankProfile({headline:'Jane Smith - Recruiter at Example (US)',snippet:''},'Example (US)'));
 assert.equal(rankProfile({headline:'Jane Smith - Recruiter at Example US',snippet:''},'Example (US)'),null);
});
