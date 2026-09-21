import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const sandbox = {}; vm.runInNewContext(readFileSync(new URL('../extension/detect.js', import.meta.url), 'utf8'), { globalThis: sandbox });
const helpers = sandbox.RecruiterOutreachDetect;
// Results come from another VM realm; normalise so deepEqual compares structure, not prototypes.
const detect = page => { const hit = helpers.detect(page); return hit ? JSON.parse(JSON.stringify(hit)) : hit; };
const { cleanCompany, fromSlug, fromHost } = helpers;

test('recognizes confirmation pages on the major applicant tracking systems and names the company', () => {
  assert.deepEqual(detect({ hostname: 'jobs.lever.co', pathname: '/stripe/1234-abcd/thanks', text: '' }), { adapter: 'lever', company: 'Stripe', confident: true });
  assert.deepEqual(detect({ hostname: 'boards.greenhouse.io', pathname: '/datadog/jobs/555', siteName: 'Datadog Careers', text: 'Thank you for applying! We have received your application.' }), { adapter: 'greenhouse', company: 'Datadog', confident: true });
  assert.deepEqual(detect({ hostname: 'jobs.ashbyhq.com', pathname: '/ramp/abc/application', text: 'Application submitted' }), { adapter: 'ashby', company: 'Ramp', confident: true });
  assert.deepEqual(detect({ hostname: 'amazon.wd5.myworkdayjobs.com', pathname: '/en-US/amazon_jobs/job/x', text: 'Congratulations! Your application has been submitted.' }), { adapter: 'workday', company: 'Amazon', confident: true });
  assert.equal(detect({ hostname: 'wd5.myworkdayjobs.com', pathname: '/en-US/NVIDIAExternalCareerSite/job/x', text: 'Application submitted' }).company, 'Nvidia');
  assert.deepEqual(detect({ hostname: 'www.linkedin.com', pathname: '/jobs/view/1', jobCompany: 'Microsoft', text: 'Your application was sent to Microsoft.' }), { adapter: 'linkedin', company: 'Microsoft', confident: true });
  assert.equal(detect({ hostname: 'www.linkedin.com', pathname: '/jobs/view/1', jobCompany: 'Microsoft', text: 'Application submitted' }).company, 'Microsoft');
});
test('generic career sites need a confirmation phrase and a plausible company name', () => {
  assert.deepEqual(detect({ hostname: 'careers.acme.com', pathname: '/thanks', siteName: 'Acme Inc. Careers', text: 'Thanks for applying to Acme!' }), { adapter: 'generic', company: 'Acme', confident: false });
  assert.equal(detect({ hostname: 'careers.acme.com', pathname: '/thanks', title: '', siteName: '', text: 'Your application has been received.' }).company, 'Acme');
  assert.equal(detect({ hostname: 'boards.greenhouse.io', pathname: '/datadog/jobs/555', siteName: 'Datadog', text: 'Apply for this job. Submit application.' }), null);
  assert.equal(detect({ hostname: 'www.example.com', pathname: '/', text: 'Read our latest blog post about job applications.' }), null);
});
test('human-readable names from titles beat URL slugs', () => {
  assert.equal(detect({ hostname: 'jobs.ashbyhq.com', pathname: '/scaleai/abc/application', title: 'Scale AI - Machine Learning Engineer', text: 'Application submitted' }).company, 'Scale AI');
  assert.equal(detect({ hostname: 'boards.greenhouse.io', pathname: '/scaleai/jobs/1', title: 'Job Application for Software Engineer at Scale AI', text: 'Thank you for applying' }).company, 'Scale AI');
  assert.equal(detect({ hostname: 'careers.acme.com', pathname: '/x', title: 'Software Engineer | Acme Robotics', text: 'Your application has been received' }).company, 'Acme Robotics');
  assert.equal(helpers.fromTitle('Thanks for applying - Datadog'), 'Datadog');
  assert.equal(helpers.fromTitle(''), '');
});
test('company names are cleaned of ATS and job-board noise', () => {
  assert.equal(cleanCompany('Amazon Jobs | Careers'), 'Amazon');
  assert.equal(cleanCompany('Coca-Cola Company Careers'), 'Coca-Cola');
  assert.equal(cleanCompany('Jobs at Datadog - Greenhouse'), 'at Datadog');
  assert.equal(fromSlug('amazon-web-services'), 'Amazon Web Services');
  assert.equal(fromSlug('12345'), '');
  assert.equal(fromHost('careers.jpmorgan.co.uk'), 'Jpmorgan');
});
