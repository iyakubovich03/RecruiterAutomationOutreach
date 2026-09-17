import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSearchConfig, normalizeConfig, publicConfig, searchConfig } from '../server/config.mjs';
import { relevance, focusScore } from '../server/core.mjs';
import { rankProfile, discoverRecruiters } from '../server/discovery.mjs';

test('the committed search.config.json loads and keeps the new-grad defaults', () => {
  assert.equal(searchConfig.search.roleKeyword, 'recruiter');
  assert.deepEqual(searchConfig.focusTiers.map(t => t.label), ['Early careers', 'Technical recruiting']);
  assert.equal(relevance('University Recruiter'), 'Early careers');
  assert.equal(relevance('Technical Recruiter'), 'Technical recruiting');
  assert.equal(relevance('Senior Recruiter'), 'Review recruiting focus');
  assert.deepEqual(['Early careers', 'Technical recruiting', 'Other'].map(f => focusScore(f)), [3, 2, 1]);
  assert.match(searchConfig.template.subject, /\{company\}/);
});

test('a missing config file falls back to generic defaults instead of failing', () => {
  const config = loadSearchConfig(join(mkdtempSync(join(tmpdir(), 'cfg-')), 'missing.json'));
  assert.equal(config.search.roleKeyword, 'recruiter');
  assert.deepEqual(config.focusTiers, []);
  assert.equal(relevance('University Recruiter', config), config.fallbackFocus);
});

test('a custom config changes the search query, filters, ranking, and template', async () => {
  const config = normalizeConfig({
    search: { roleKeyword: 'sales recruiter', audience: 'Sales recruiters.', exampleCompanies: ['Acme'] },
    recruiterTerms: ['recruit\\w*', 'talent partner'],
    focusTiers: [{ label: 'Sales hiring', any: ['sales', 'go.?to.?market'], also: ['recruit', 'talent'] }],
    fallbackFocus: 'Other recruiting',
    template: { subject: 'Sales roles at {company}', message: 'Hi {first_name}' },
  });
  assert.equal(relevance('Sales Recruiter', config), 'Sales hiring');
  assert.equal(relevance('University Recruiter', config), 'Other recruiting');
  assert.equal(relevance('Sales Manager', config), 'Other recruiting');
  const ranked = rankProfile({ source: 'https://www.linkedin.com/in/jane', headline: 'Jane Smith - Talent Partner at Example', snippet: 'Sales talent partner' }, 'Example', config);
  assert.equal(ranked.focus, 'Sales hiring'); assert.equal(ranked.score, 2);
  assert.equal(rankProfile({ source: 'https://www.linkedin.com/in/jane', headline: 'Jane Smith - Early Careers at Example', snippet: '' }, 'Example', config), null, 'terms outside recruiterTerms no longer count as recruiters');
  const queries = [];
  await discoverRecruiters('Example', '', async (url, opts) => { queries.push(JSON.parse(opts.body).q); return Response.json({ organic: [] }); }, () => {}, { env: { SERPER_API_KEY: 's' }, config }).catch(() => {});
  assert.deepEqual(queries, ['site:linkedin.com/in/ "Example" sales recruiter']);
  assert.deepEqual(publicConfig(config), { workspace: config.workspace, search: config.search, focusLabels: ['Sales hiring', 'Other recruiting'] });
  assert.equal(JSON.stringify(publicConfig(config)).includes('Pattern'), false);
});

test('invalid config files fail with a clear message', () => {
  assert.throws(() => normalizeConfig({ focusTiers: [{ label: 'Bad', any: ['('] }] }), /focusTiers\[0\]\.any contains an invalid regular expression/);
  assert.throws(() => normalizeConfig({ search: { roleKeyword: 'a"b' } }), /roleKeyword/);
  assert.throws(() => normalizeConfig({ recruiterTerms: [] }), /recruiterTerms/);
  assert.throws(() => normalizeConfig({ template: { subject: 'two\nlines' } }), /single line/);
  const dir = mkdtempSync(join(tmpdir(), 'cfg-')); writeFileSync(join(dir, 'search.config.json'), '{ not json');
  assert.throws(() => loadSearchConfig(join(dir, 'search.config.json')), /could not be parsed as JSON/);
});
