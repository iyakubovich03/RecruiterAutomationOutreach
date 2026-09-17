import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProfileHtml, parseProfileText, fullName } from '../server/profile.mjs';
import { candidates } from '../server/core.mjs';
test('extracts structured main profile, not a related person; captures work email',()=>{
 const html=`<title>Jane Smith | LinkedIn</title><script type="application/ld+json">{"@graph":[{"@type":"Person","name":"Other Person"},{"@type":"ProfilePage","mainEntity":{"@id":"#profile"}},{"@id":"#profile","@type":"Person","name":"Jane Smith","jobTitle":"University Recruiter","worksFor":{"@type":"Organization","name":"Example"},"email":"jane.smith@example.com"}]}</script>`;
 const result=parseProfileHtml(html,'https://www.linkedin.com/in/jane-smith');
 assert.equal(result.name,'Jane Smith');assert.equal(result.company,'Example');assert.equal(result.title,'University Recruiter');assert.equal(result.domain,'example.com');assert.equal(result.extraction.method,'Structured profile data');
 assert.equal(candidates(result.name,result.domain,result.sourceText)[0].format,'Imported address');
});
test('handles heading markup, entities, pronouns, reversed metadata attributes, and mailto links',()=>{
 const result=parseProfileHtml(`<meta content="Jane O&#39;Neil - Technical Recruiter at Example | LinkedIn" property="og:title"><main><h1><span>Jane O&#39;Neil</span> (she/her)</h1><div class="top-card-layout__headline">Technical Recruiter at Example</div><a href="mailto:jane.oneil@example.com?subject=Hi">Email me</a></main>`);
 assert.equal(result.name,"Jane O'Neil");assert.equal(result.company,'Example');assert.equal(result.domain,'example.com');assert.deepEqual(result.extraction.emails,['jane.oneil@example.com']);
});
test('falls back after malformed JSON and accepts accented and hyphenated names',()=>{
 const result=parseProfileHtml(`<script type="application/ld+json">{broken}</script><meta property="og:title" content="María García-López – Campus Recruiter at Example | LinkedIn">`);
 assert.equal(result.name,'María García-López');assert.equal(result.company,'Example');
 assert.equal(candidates(result.name,'example.com')[0].email,'maria.garcialopez@example.com');
});
test('rejects login pages and avoids fabricating a name from the URL',()=>{
 assert.throws(()=>parseProfileHtml('<title>LinkedIn: Sign In or Sign Up</title><h1>Join now</h1>'),/sign-in/);
 const result=parseProfileHtml('<title>LinkedIn</title><main>Welcome</main>','https://www.linkedin.com/in/jane-smith-123');assert.equal(result.name,'');assert.ok(result.extraction.warnings.length);
});
test('pasted text skips navigation and recruiting titles; recognizes explicit email obfuscation',()=>{
 const result=parseProfileText('Contact info\nUniversity Recruiter\nJane Smith (she/her)\nUniversity Recruiter at Example\njane.smith [at] example [dot] com');
 assert.equal(result.name,'Jane Smith');assert.equal(result.domain,'example.com');assert.equal(result.company,'Example');
 assert.equal(fullName('People also viewed'),'');
});
test('does not select a related structured person when a different visible name exists',()=>{
 const result=parseProfileHtml('<h1>Jane Smith</h1><script type="application/ld+json">{"@type":"Person","name":"Other Person","email":"other@example.net"}</script>');
 assert.equal(result.name,'Jane Smith');assert.deepEqual(result.extraction.emails,[]);
});
test('ambiguous email domains are not selected automatically',()=>{
 const result=parseProfileHtml('<main><h1>Jane Smith</h1><p>jane@example.com and hiring@another.org</p></main>');assert.equal(result.domain,'');assert.equal(result.extraction.emails.length,2);
});
