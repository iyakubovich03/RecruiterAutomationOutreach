#!/usr/bin/env node
// Discovery audit: runs the real company search for many companies through the
// running app and reports, per company, whether recruiters, the email domain and
// RocketReach formats came back — and which stage failed when they did not.
//
// Nothing is sent and no contacts are saved; only /api/discover is exercised.
//
//   npm run audit                                   # built-in list of ~24 companies
//   npm run audit -- Stripe "Scale AI" Figma        # your own list
//   npm run audit -- --file companies.txt           # one company per line
//   npm run audit -- --fresh --delay 45             # bypass the 10-minute cache; seconds between companies
//
// Cost: each new company is 3–4 search-API credits and usually one RocketReach page read.
// The delay keeps RocketReach under its rate limit; formats already saved cost no page read.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); if (i === -1) return fallback; const v = args[i + 1]; args.splice(i, 2); return v ?? true; };
const fresh = flag('--fresh', false) !== false;
const delay = Number(flag('--delay', 30)) * 1000;
const file = flag('--file', '');
const base = flag('--url', 'http://localhost:3000');

const defaults = [
  // Big tech and well-known names (RocketReach lookups compete with content about the company itself).
  'Google', 'Microsoft', 'Amazon', 'Meta', 'Apple', 'Netflix',
  // Companies whose email domain differs from the obvious website.
  'Notion', 'Datadog', 'Scale AI', 'Databricks',
  // Startups and mid-size tech.
  'Figma', 'Stripe', 'Anthropic', 'Ramp', 'Vercel', 'Linear', 'Retool', 'Rippling',
  // Non-tech and conglomerates (ambiguous names, many RocketReach entities).
  'Goldman Sachs', 'Deloitte', 'Mitsubishi', 'Gartner', 'Lockheed Martin', 'Capital One',
];
const companies = file ? readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')) : args.length ? args : defaults;

const status = await fetch(base + '/api/status').catch(() => null);
if (!status?.ok) { console.error(`The app is not answering at ${base}. Start it with: npm run dev`); process.exit(1); }
const cookie = (status.headers.get('set-cookie') || '').split(';')[0];
const { csrf, searchProviders } = await status.json();
if (!searchProviders?.length) { console.error('No search API key is configured (SERPER_API_KEY or SERPAPI_KEY in .env.local); the audit would only hit blocked public search pages.'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stageError = (events, stage) => events.find(e => e.stage === stage && e.status === 'error')?.detail || '';
const rejectedCount = events => events.filter(e => e.stage === 'Profile filter' && e.status === 'rejected').length;

function classify(result) {
  const events = result.diagnostics?.events || [];
  const formats = result.patternReport?.reportedPatterns?.length || 0;
  const recruiters = result.results.length;
  if (!recruiters) {
    const search = stageError(events, 'Recruiter search');
    if (search) return { outcome: 'NO_RECRUITERS', stage: 'Recruiter search', why: search };
    return { outcome: 'NO_RECRUITERS', stage: 'Profile filter', why: `${rejectedCount(events)} results rejected by the name/role/company filter (see Requests tab)` };
  }
  if (!result.domain) return { outcome: 'NO_DOMAIN', stage: 'Domain', why: result.domainResolution?.message || stageError(events, 'Domain discovery') || 'unresolved' };
  if (!formats) {
    const page = stageError(events, 'RocketReach page');
    const rr = events.find(e => e.stage === 'RocketReach company' && e.status === 'ok' && /lists/.test(e.detail));
    return { outcome: 'NO_FORMATS', stage: 'Email patterns', why: page ? `RocketReach page: ${page}` : rr ? 'RocketReach page found but no formats parsed' : 'no RocketReach page found; name-based guesses only' };
  }
  return { outcome: 'OK', stage: '', why: '' };
}

const rows = [];
const started = Date.now();
console.log(`Auditing ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} through ${base} (${fresh ? 'fresh searches' : 'cached results reused when under 10 minutes old'}, ${delay / 1000}s between companies).\n`);
for (const [i, company] of companies.entries()) {
  const t = Date.now();
  process.stdout.write(`${String(i + 1).padStart(2)}/${companies.length} ${company.padEnd(18)} `);
  let row;
  try {
    const r = await fetch(base + '/api/discover', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ company, fresh }) });
    const result = await r.json();
    if (!r.ok || result.error) throw new Error(result.error || `HTTP ${r.status}`);
    const verdict = classify(result);
    const top = result.patternReport?.reportedPatterns?.[0];
    row = {
      company, canonical: result.company, outcome: verdict.outcome, stage: verdict.stage, why: verdict.why,
      recruiters: result.results.length, domain: result.domain || '', domainSource: result.domainResolution?.status || '',
      alternates: result.alternateDomains || [], formats: result.patternReport?.reportedPatterns?.length || 0,
      topFormat: top ? `${top.format} ${top.percentage ?? '?'}%` : '', example: result.results[0]?.candidates?.[0]?.email || '',
      names: result.results.map(p => p.name), warnings: result.warnings || [], seconds: Math.round((Date.now() - t) / 1000),
    };
  } catch (error) {
    row = { company, outcome: 'ERROR', stage: 'request', why: error.message, recruiters: 0, domain: '', formats: 0, seconds: Math.round((Date.now() - t) / 1000) };
  }
  rows.push(row);
  const mark = { OK: '✓', NO_FORMATS: '~', NO_DOMAIN: '✗', NO_RECRUITERS: '✗', ERROR: '!' }[row.outcome];
  console.log(`${mark} ${row.outcome.padEnd(13)} ${String(row.recruiters).padStart(2)} recruiters  ${(row.domain || '—').padEnd(22)} ${row.formats ? `${row.formats} formats, top ${row.topFormat}` : row.why.slice(0, 70)}  (${row.seconds}s)`);
  if (i < companies.length - 1) await sleep(delay);
}

const count = o => rows.filter(r => r.outcome === o).length;
console.log(`\n${count('OK')} OK · ${count('NO_FORMATS')} recruiters+domain but no RocketReach formats · ${count('NO_DOMAIN')} no domain · ${count('NO_RECRUITERS')} no recruiters · ${count('ERROR')} errors · ${Math.round((Date.now() - started) / 60000)} min`);
const problems = rows.filter(r => r.outcome !== 'OK');
if (problems.length) { console.log('\nNeeds a look:'); for (const r of problems) console.log(`- ${r.company}: ${r.stage} — ${r.why}`); }

const dir = join(process.cwd(), '.local-data', 'audits'); mkdirSync(dir, { recursive: true });
const out = join(dir, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json');
writeFileSync(out, JSON.stringify({ startedAt: new Date(started).toISOString(), fresh, rows }, null, 2));
console.log(`\nFull report (private, git-ignored): ${out}`);
if (existsSync(join(process.cwd(), '.env.local'))) console.log('Search credits: check your provider dashboard; each new company used about 3–4.');
