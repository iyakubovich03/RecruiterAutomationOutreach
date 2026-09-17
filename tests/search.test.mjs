import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb, parseSearchHtml, apiProviders } from '../server/search.mjs';
test('keyed providers are only enabled when their credentials exist',()=>{
 assert.deepEqual(apiProviders({}),[]);
 assert.deepEqual(apiProviders({GOOGLE_CSE_KEY:'k'}).map(p=>p.name),[]);
 assert.deepEqual(apiProviders({GOOGLE_CSE_KEY:'k',GOOGLE_CSE_ID:'c',SERPER_API_KEY:'s',SERPAPI_KEY:'a'}).map(p=>p.name),['google-api','serper','serpapi']);
});
test('SerpApi results are parsed and its in-body error is treated as a failure',async()=>{
 const calls=[];
 const ok=await searchWeb('q',{env:{SERPAPI_KEY:'a'},fetcher:async url=>{calls.push(String(url));return Response.json({organic_results:[{link:'https://rocketreach.co/x-email-format_1',title:'X Email Format',snippet:'formats'}]});},read:async()=>{throw new Error('must not scrape');}});
 assert.equal(ok.provider,'SerpApi Google API');assert.equal(ok.rows[0].url,'https://rocketreach.co/x-email-format_1');assert.match(calls[0],/api_key=a/);
 const events=[];const failed=await searchWeb('q',{env:{SERPAPI_KEY:'a'},fetcher:async()=>Response.json({error:'Invalid API key'}),read:async()=>'<html></html>',onEvent:e=>events.push(e)});
 assert.equal(failed.provider,'');assert.ok(events.some(e=>e.status==='error'&&/Invalid API key/.test(e.detail)));
 assert.ok(events.every(e=>!String(e.source||'').includes('api_key')));
});
test('Serper results are parsed and an API failure falls back to public search pages',async()=>{
 const calls=[];
 const ok=await searchWeb('site:linkedin.com/in/ "Example" recruiter',{env:{SERPER_API_KEY:'s'},fetcher:async(url,opts)=>{calls.push([url,opts.headers['X-API-KEY'],JSON.parse(opts.body).q]);return Response.json({organic:[{link:'https://www.linkedin.com/in/jane',title:'Jane Smith - Recruiter at Example',snippet:'Recruiting at Example'}]});},read:async()=>{throw new Error('must not scrape');}});
 assert.equal(ok.provider,'Serper Google API');assert.deepEqual(ok.rows,[{url:'https://www.linkedin.com/in/jane',title:'Jane Smith - Recruiter at Example',snippet:'Recruiting at Example'}]);
 assert.deepEqual(calls,[['https://google.serper.dev/search','s','site:linkedin.com/in/ "Example" recruiter']]);
 const events=[];
 const fallback=await searchWeb('q',{env:{SERPER_API_KEY:'s'},fetcher:async()=>Response.json({message:'Unauthorized'},{status:401}),read:async url=>url.includes('duckduckgo')?'<div class="result"><a class="result__a" href="https://example.com/a">A</a></div>':'',onEvent:e=>events.push(e)});
 assert.equal(fallback.provider,'DuckDuckGo public search');assert.equal(fallback.rows[0].url,'https://example.com/a');assert.match(fallback.warnings[0],/Serper/);
 assert.ok(events.some(e=>e.status==='error'&&/401/.test(e.detail)));
});
test('public search pages detect bot checks, unreadable feeds and JavaScript-only responses',async()=>{
 const events=[];
 const result=await searchWeb('q',{scrape:['duckduckgo','bing','google'],read:async url=>url.includes('duckduckgo')?'<div class="anomaly-modal"></div>':url.includes('bing')?'<html>not rss</html>':'<a href="/httpservice/retry/enablejs">Enable JS</a>',onEvent:e=>events.push(e)});
 assert.equal(result.available,0);assert.equal(result.rows.length,0);assert.equal(result.warnings.length,3);
 assert.equal(events.filter(e=>e.status==='error').length,3);assert.ok(events.some(e=>/JavaScript-required/.test(e.detail)));
});
test('accept predicate keeps searching when results do not match, and available counts empty successes',async()=>{
 const urls=[];
 const result=await searchWeb('q',{read:async url=>{urls.push(url);return url.includes('duckduckgo')?'<div class="result"><a class="result__a" href="https://other.org/x">X</a></div>':'<rss><channel><item><link>https://wanted.com/y</link><title>Y</title><description>d</description></item></channel></rss>';},accept:rows=>rows.some(r=>r.url.startsWith('https://wanted.com'))});
 assert.equal(urls.length,2);assert.equal(result.provider,'Bing public search');assert.equal(result.available,2);assert.equal(result.rows[0].snippet,'d');
});
test('parses Google HTML redirect links and DuckDuckGo wrapped links',()=>{
 assert.deepEqual(parseSearchHtml('<a href="/url?q=https%3A%2F%2Frocketreach.co%2Fx-email-format_1&amp;sa=U"><h3>X</h3></a>','google')[0],{url:'https://rocketreach.co/x-email-format_1',title:'X',snippet:''});
 assert.equal(parseSearchHtml('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp">P</a></div>','duckduckgo')[0].url,'https://example.com/p');
});
