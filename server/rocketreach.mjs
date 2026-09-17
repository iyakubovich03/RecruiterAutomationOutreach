import { load } from 'cheerio';
import { candidateForFormat, domainOf } from './core.mjs';
import { publicPage } from './public-page.mjs';
import { searchWeb } from './search.mjs';

const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
const blocked = /anomaly-modal|challenge-form|captcha|verify you are human|just a moment|access denied/i;
export function rocketreachUrl(value) {
  try {
    let url = new URL(value, 'https://html.duckduckgo.com');
    if (['duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname) && url.searchParams.has('uddg')) url = new URL(url.searchParams.get('uddg'));
    if (['google.com','www.google.com'].includes(url.hostname) && url.pathname === '/url') url = new URL(url.searchParams.get('q') || url.searchParams.get('url'));
    return url.protocol === 'https:' && /^(www\.)?rocketreach\.co$/.test(url.hostname) && !url.username && !url.password && !url.port && /email[-_]format/i.test(url.pathname) ? url.href : '';
  } catch { return ''; }
}

// RocketReach notation → candidate tokens: [first_initial_two] → f2, [last_initial] → l, "first name" → first.
const tokens = text => text.toLowerCase()
  .replace(/first[\s_]*(?:name)?[\s_]*initial[\s_]*two/g, 'f2').replace(/last[\s_]*(?:name)?[\s_]*initial[\s_]*two/g, 'l2')
  .replace(/first[\s_]*(?:name)?[\s_]*initial/g, 'f').replace(/last[\s_]*(?:name)?[\s_]*initial/g, 'l')
  .replace(/first\s+name/g, 'first').replace(/last\s+name/g, 'last');

// Accept explicit format notation next to an address at the requested domain.
// Example addresses are illustrations, never evidence of a real employee.
export function parseRocketReach(html, domain, source) {
  domain = domainOf(domain);
  if (!rocketreachUrl(source)) throw new Error('Not a RocketReach email-format page.');
  const $ = load(html);
  $('script,style,nav,footer,noscript').remove();
  const text = compact($('body').text() || $.root().text());
  if (blocked.test(text)) throw new Error('RocketReach returned an access or bot-check page.');
  const patterns = new Map(), unsupported = [];
  $('tr,p,li').each((_, el) => {
    const cells=$(el).find('td,th');
    const context = compact(cells.length?cells.map((_,cell)=>$(cell).text()).get().join(' '):$(el).text());
    if (context.length > 2000) return;
    const escaped = domain.replaceAll('.', '\\.');
    if (!new RegExp('@' + escaped + '(?![a-z0-9.-])', 'i').test(context)) return;
    const normalized = tokens(context);
    const match = normalized.match(/\b(?:first|last|f2|l2|f|l)(?:[\s'"{}\[\]()._-]*(?:first|last|f2|l2|f|l))?\b/);
    if (!match) { if (/format/i.test(context)) unsupported.push(context); return; }
    const notation = cells.length ? tokens(compact(cells.first().text())) : match[0];
    const format = notation.replace(/[\s'"{}\[\]()]/g, '');
    if (!candidateForFormat('Jane Smith', domain, format)) { unsupported.push(context); return; }
    const percent = context.match(/(\d+(?:\.\d+)?)\s*%/);
    const percentage = percent && Number(percent[1]) <= 100 ? Number(percent[1]) : null;
    if (!patterns.has(format)) patterns.set(format, { format, percentage, source, context, method: 'RocketReach reported format' });
  });
  return { patterns: [...patterns.values()], unsupported };
}

export async function findRocketReach(domain, { read = publicPage, onEvent = () => {}, company = '', env = {}, fetcher = fetch } = {}) {
  domain = domainOf(domain);
  const name = compact(company).replace(/["\r\n]/g, ' ').slice(0,100);
  const queries = [...new Set([...(name ? [`rocketreach ${name} email format`] : []), `site:rocketreach.co "${domain}" "email format"`])];
  const links = new Set(), sources = [], patterns = [], warnings = [];
  for (const query of queries) {
    const search = await searchWeb(query, { env, fetcher, read, onEvent, stage: 'RocketReach search', scrape: ['duckduckgo', 'bing', 'google'], accept: rows => rows.some(row => rocketreachUrl(row.url)) });
    for (const row of search.rows) { const url = rocketreachUrl(row.url); if (url) links.add(url); }
    warnings.push(...search.warnings);
    if (links.size) break;
  }
  onEvent({ stage: 'RocketReach search', status: links.size ? 'ok' : 'empty', detail: `${links.size} RocketReach email-format page links found` });
  for (const source of [...links].slice(0, 3)) {
    onEvent({ stage: 'RocketReach page', status: 'running', detail: `Reading formats for ${domain}`, source });
    try {
      const report = parseRocketReach(await read(source), domain, source);
      patterns.push(...report.patterns);
      const detail = report.patterns.length ? report.patterns.map(p => `${p.format}${p.percentage === null ? '' : ` (${p.percentage}% reported)`}`).join(', ') : 'No readable explicit formats matched this domain; page may require sign-in or JavaScript, or use unsupported notation.';
      sources.push({ source, status: report.patterns.length ? 'read' : 'no matching formats', examples: 0, detail });
      onEvent({ stage: 'RocketReach page', status: report.patterns.length ? 'ok' : 'empty', detail, source });
      for (const context of report.unsupported) onEvent({ stage: 'RocketReach format', status: 'rejected', detail: `Unsupported format: ${context}`, source });
    } catch (error) {
      sources.push({ source, status: 'unavailable', examples: 0, detail: error.message });
      onEvent({ stage: 'RocketReach page', status: 'error', detail: error.message, source });
    }
  }
  if (!patterns.length) warnings.push('No RocketReach formats extracted. See search and page diagnostics; remaining candidates use public examples or fallback guesses.');
  onEvent({ stage: 'RocketReach formats', status: patterns.length ? 'ok' : 'empty', detail: `${patterns.length} reported formats extracted from ${sources.length} pages` });
  // Pages are read in search-rank order; the first (main company) page wins.
  const unique = new Map();
  for (const p of patterns) if (!unique.has(p.format)) unique.set(p.format, p);
  return { patterns: [...unique.values()], sources, warnings };
}
