// Loads search.config.json from the project root. Everything that made the app
// specific to one kind of job search lives in that file; the code only reads it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  workspace: { label: 'Your job search', focus: 'Recruiter outreach' },
  search: { roleKeyword: 'recruiter', audience: 'Recruiters at the companies on your list.', exampleCompanies: ['Stripe', 'Microsoft', 'Datadog'] },
  recruiterTerms: ['recruit\\w*', 'talent acquisition'],
  focusTiers: [],
  fallbackFocus: 'Review recruiting focus',
  template: { subject: 'Opportunities at {company}', message: 'Hi {first_name},\n\nI’m interested in opportunities at {company}.\n\n[Add your background and what you are looking for.]\n\nAre you the right person to contact?\n\nThank you,\n[Your name]' },
});

const fail = (message) => { throw new Error(`search.config.json: ${message}`); };
const text = (value, fallback, name, max = 200) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
};
const list = (value, fallback, name) => {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x.trim())) fail(`${name} must be an array of non-empty strings.`);
  return value.map(x => x.trim());
};
// `bounded` wraps the alternation in word boundaries (used for recruiter terms such as
// "recruit\\w*"); focus tiers match anywhere so "Recruiter" still satisfies "recruit".
const compile = (patterns, name, bounded = false) => {
  const source = `(?:${patterns.join('|')})`;
  try { return new RegExp(bounded ? `\\b${source}\\b` : source, 'i'); } catch (e) { fail(`${name} contains an invalid regular expression: ${e.message}`); }
};

export function normalizeConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('must contain a JSON object.');
  const d = DEFAULT_CONFIG;
  const workspace = { label: text(raw.workspace?.label, d.workspace.label, 'workspace.label'), focus: text(raw.workspace?.focus, d.workspace.focus, 'workspace.focus') };
  const roleKeyword = text(raw.search?.roleKeyword, d.search.roleKeyword, 'search.roleKeyword', 60);
  if (/["\r\n]/.test(roleKeyword)) fail('search.roleKeyword must not contain quotes or line breaks.');
  const search = { roleKeyword, audience: text(raw.search?.audience, d.search.audience, 'search.audience'), exampleCompanies: list(raw.search?.exampleCompanies, d.search.exampleCompanies, 'search.exampleCompanies').slice(0, 5) };
  const recruiterTerms = list(raw.recruiterTerms, d.recruiterTerms, 'recruiterTerms');
  if (!recruiterTerms.length) fail('recruiterTerms needs at least one term.');
  const tiersRaw = raw.focusTiers === undefined ? d.focusTiers : raw.focusTiers;
  if (!Array.isArray(tiersRaw)) fail('focusTiers must be an array.');
  const focusTiers = tiersRaw.map((tier, i) => {
    const label = text(tier?.label, undefined, `focusTiers[${i}].label`, 80);
    if (!label) fail(`focusTiers[${i}].label is required.`);
    const any = list(tier.any, [], `focusTiers[${i}].any`);
    if (!any.length) fail(`focusTiers[${i}].any needs at least one term.`);
    const also = list(tier.also, [], `focusTiers[${i}].also`);
    return { label, any, also, anyPattern: compile(any, `focusTiers[${i}].any`), alsoPattern: also.length ? compile(also, `focusTiers[${i}].also`) : null };
  });
  const template = { subject: text(raw.template?.subject, d.template.subject, 'template.subject'), message: text(raw.template?.message, d.template.message, 'template.message', 20000) };
  if (/[\r\n]/.test(template.subject)) fail('template.subject must be a single line.');
  return { workspace, search, recruiterTerms, recruiterPattern: compile(recruiterTerms, 'recruiterTerms', true), focusTiers, fallbackFocus: text(raw.fallbackFocus, d.fallbackFocus, 'fallbackFocus', 80), template };
}

export function loadSearchConfig(path = join(process.cwd(), 'search.config.json')) {
  if (!existsSync(path)) return normalizeConfig({});
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { fail(`could not be parsed as JSON (${e.message}).`); }
  return normalizeConfig(raw);
}

// Loaded once at startup; restart `npm run dev` after editing the file.
export const searchConfig = loadSearchConfig();

// Values safe to show in the browser (no regexes, nothing secret).
export function publicConfig(config = searchConfig) {
  return { workspace: config.workspace, search: config.search, focusLabels: [...config.focusTiers.map(t => t.label), config.fallbackFocus] };
}
