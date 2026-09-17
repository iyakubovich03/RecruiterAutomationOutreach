import test from 'node:test';
import assert from 'node:assert/strict';
import { companySearchResults, websiteEvidence, discoverCompanyDomain } from '../server/company-domain.mjs';
const result=(url,title)=>`<div class="result"><a class="result__a" href="${url}">${title}</a></div>`;
const org=(name,email)=>`<script type="application/ld+json">${JSON.stringify({'@type':'Organization',name,email})}</script>`;
test('finds a non-obvious company domain from search and published contact evidence',async()=>{
 const resolution=await discoverCompanyDomain('Example',{read:async url=>url.includes('duckduckgo')?result('https://examplehq.com','Example official website'):org('Example Inc.','careers@examplehq.com'),mx:async()=>[{exchange:'mx.example.net'}]});
 assert.equal(resolution.domain,'examplehq.com');assert.equal(resolution.status,'published');assert.deepEqual(resolution.sources,['https://examplehq.com/']);
});
test('distinguishes a website-based domain inference from a published email domain',async()=>{
 const resolution=await discoverCompanyDomain('Example',{read:async url=>url.includes('duckduckgo')?result('https://example.com','Example'):'<title>Example | Official website</title>',mx:async()=>[{exchange:'mx.example.net'}]});
 assert.equal(resolution.domain,'example.com');assert.equal(resolution.status,'inferred');
});
test('does not synthesize company.com, accept unrelated sites, or proceed without mail servers',async()=>{
 assert.equal(websiteEvidence('<title>Another Company</title>','https://unrelated.org','Example'),null);
 assert.equal(companySearchResults(result('https://linkedin.com/company/example','Example'),'duckduckgo').length,0);
 const empty=await discoverCompanyDomain('Example',{read:async()=>'<html>No results</html>',mx:async()=>{throw new Error('must not run');}});assert.equal(empty.domain,'');
 const noMail=await discoverCompanyDomain('Example',{read:async url=>url.includes('duckduckgo')?result('https://example.com','Example'):org('Example'),mx:async()=>[]});assert.equal(noMail.domain,'');
});
test('regional sites whose mail servers sit under another candidate domain resolve to that domain',async()=>{
 const events=[];
 const resolution=await discoverCompanyDomain('Example',{onEvent:e=>events.push(e),read:async url=>url.includes('duckduckgo')?result('https://example.com','Example')+result('https://example.ae','Example')+result('https://example.in','Example'):'<title>Example | Official website</title>',mx:async domain=>[{exchange:domain==='example.com'?'example-smtp.example.com':'example-smtp.example.com'}]});
 assert.equal(resolution.domain,'example.com');assert.equal(resolution.status,'inferred');assert.match(resolution.message,/example\.ae, example\.in/);
 assert.ok(events.some(e=>e.stage==='Domain decision'&&e.status==='ok'&&/route mail through example\.com/.test(e.detail)));
});
test('returns ambiguity when similarly strong company evidence points to multiple domains',async()=>{
 const resolution=await discoverCompanyDomain('Example',{read:async url=>url.includes('duckduckgo')?result('https://example.com','Example')+result('https://example.org','Example'):org('Example'),mx:async()=>[{exchange:'mx.example.net'}]});
 assert.equal(resolution.status,'ambiguous');assert.equal(resolution.domain,'');
});
