import { load } from 'cheerio';
import { candidateForFormat, domainOf } from './core.mjs';
import { publicPage } from './public-page.mjs';
import { apiProviders, searchWeb } from './search.mjs';

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

// RocketReach's company page states the email domain ("Scale AI Email Format | scale.com Emails"),
// which disambiguates same-name companies better than a web search for the official site.
// "Scale AI Email Format | scale.com Emails" → scale.com; search results carry the same title, so the domain is often known before any RocketReach request.
export const domainFromTitle = title => String(title || '').match(/\|\s*([a-z0-9.-]+\.[a-z]{2,})\s+emails/i)?.[1] || '';
const safeDomain = value => { try { return value ? domainOf(value) : ''; } catch { return ''; } };
// A RocketReach email-format page states the domain in four places, checked in order:
//   1. <title>            "Gartner Email Format | gartner.com Emails"
//   2. meta description   "Gartner uses 13 email formats: 1. first '.' last@gartner.com (87.3%)"
//   3. the format table   Email Format | Example (jane.doe@gartner.com) | Percentage
//   4. the prose          "The most common Gartner email format is [first].[last] (ex. jane.doe@gartner.com)"
// Example addresses are illustrations of the pattern, never real employees.
const addressDomains = text => [...String(text || '').matchAll(/@([a-z0-9.-]+\.[a-z]{2,})(?![a-z0-9])/gi)].map(m => m[1].toLowerCase()).filter(d => !/rocketreach\.co$/.test(d));
const commonest = domains => { const counts = new Map(); for (const d of domains) counts.set(d, (counts.get(d) || 0) + 1); return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''; };
export function rocketReachDomain(html, source) {
  const $ = load(html);
  const title = compact($('title').text());
  const description = compact($('meta[name="description"]').attr('content'));
  $('script,style,nav,footer,noscript').remove();
  $('body *').each((_, el) => { $(el).append(' '); });
  const text = compact($('body').text());
  if (blocked.test(text)) return null;
  const examples = $('tr').map((_, tr) => $(tr).find('td').map((_, td) => $(td).text()).get().join(' ')).get().join(' ');
  const mentions = addressDomains(text);
  const found = [['page title', domainFromTitle(title)], ['meta description', commonest(addressDomains(description))], ['format table examples', commonest(addressDomains(examples))], ['page text', commonest(mentions)]].find(([, d]) => d);
  if (!found) return null;
  try { const domain = domainOf(found[1]); return { domain, source, title, basis: found[0], mentions: mentions.filter(d => d === domain).length }; } catch { return null; }
}
// A search for "rocketreach <company> email format" returns one page per legal entity
// ("Mitsubishi Corporation", "Mitsubishi Power Americas", "Mitsubishi Motors North America").
// The page to read is the one whose company name the recruiters' own profiles use, so the
// employer text of each found recruiter outranks search order and the bare typed name.
const legalForms = /\b(?:inc|incorporated|corp|corporation|co|ltd|limited|llc|plc|gmbh|bv|pty|ag|sa)\b\.?/gi;
export const rocketReachPageName = title => compact(String(title || '').split('|')[0].replace(/\s+email\s+format\b.*$/i, ''));
const nameKey = name => String(name || '').toLowerCase().replace(legalForms, '').replace(/[^\p{L}\p{N}]/gu, '');
function mentions(name, text) {
  const key = nameKey(name);
  if (key.length < 3) return false;
  const letters = [...key].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]*');
  return new RegExp(`(?<![\\p{L}\\p{N}])${letters}(?![\\p{L}\\p{N}])`, 'iu').test(String(text || ''));
}
export function rankRocketReachPages(rows, company, employers = []) {
  const wanted = nameKey(company);
  const pages = rows.map((row, index) => ({ url: rocketreachUrl(row.url), title: row.title || '', name: rocketReachPageName(row.title), index })).filter(page => page.url);
  for (const page of pages) { page.key = nameKey(page.name); page.exact = page.key.length >= 3 && page.key === wanted; page.employers = 0; }
  for (const text of employers) {
    // Credit only the most specific page name a profile mentions: "Mitsubishi Power Americas" beats "Mitsubishi".
    const hits = pages.filter(page => mentions(page.name, text));
    const longest = Math.max(0, ...hits.map(page => page.key.length));
    for (const page of hits) if (page.key.length === longest) page.employers++;
  }
  const related = page => page.key.length >= 3 && wanted.length >= 3 && (page.key.includes(wanted) || wanted.includes(page.key));
  // A profile saying just "Mitsubishi" fits every Mitsubishi entity, so bare-name mentions count far less than a specific entity name.
  return pages.map(page => ({ ...page, score: page.employers * (page.exact ? 1 : 10) + (page.exact ? 5 : 0) + (related(page) ? 1 : 0) })).sort((a, b) => b.score - a.score || a.index - b.index);
}
const transient = /timed out|timeout|ECONNRESET|EAI_AGAIN|socket hang up|\(5\d\d\)/i;
// RocketReach pages are ~100 KB and occasionally exceed the request timeout; one retry avoids a false "no formats" result.
async function readPage(read, url, onEvent, stage) {
  try { return await read(url); }
  catch (error) {
    if (!transient.test(error.message)) throw error;
    onEvent({ stage, status: 'partial', detail: `${error.message} Retrying once.`, source: url });
    return read(url);
  }
}
async function searchRocketReach(queries, { env, fetcher, read, onEvent }) {
  const hasRocket = rows => rows.some(row => rocketreachUrl(row.url));
  const warnings = [];
  for (const [index, query] of queries.entries()) {
    // Public search pages drop site:, so a site: query is API-only whenever a plain query is there to scrape instead.
    const scrape = /^site:/.test(query) && queries.some(q => !/^site:/.test(q)) ? [] : ['duckduckgo', 'bing', 'google'];
    if (!scrape.length && !apiProviders(env).length) continue;
    const found = await searchWeb(query, { env, fetcher, read, onEvent, stage: 'RocketReach search', scrape, accept: hasRocket });
    warnings.push(...found.warnings);
    if (hasRocket(found.rows)) return { ...found, warnings };
    if (index < queries.length - 1) onEvent({ stage: 'RocketReach search', status: 'partial', detail: `No RocketReach page in the results for “${query}”; trying “${queries[index + 1]}”.` });
  }
  return { rows: [], provider: '', warnings, available: 0 };
}
export async function findRocketReachCompany(company, { read = publicPage, onEvent = () => {}, env = {}, fetcher = fetch, employers = [] } = {}) {
  const name = compact(company).replace(/["\r\n]/g, ' ').slice(0, 100);
  if (!name) return null;
  // For well-known names ("Figma") a plain query returns videos and forum threads about RocketReach itself and no
  // rocketreach.co page at all; the site: form goes straight to the company page. Search APIs honour site:,
  // the public search pages drop it, so the plain query stays as the fallback for those.
  // The name stays unquoted: quoting it makes Google return unrelated rocketreach.co org-chart pages instead.
  const search = await searchRocketReach([`site:rocketreach.co ${name} email format`, `rocketreach ${name} email format`], { env, fetcher, read, onEvent });
  const ranked = rankRocketReachPages(search.rows, name, employers);
  const urls = [...new Set(ranked.map(page => page.url))];
  if (!urls.length) return null;
  if (ranked.length > 1) {
    const [best, ...others] = ranked;
    const why = employers.length ? `named on ${best.employers} of ${employers.length} recruiter profiles` : 'no recruiter profiles to compare';
    onEvent({ stage: 'RocketReach company', status: 'ok', detail: `Chose “${best.name || best.url}” (${why}${best.exact ? '; exact company name' : ''}); others: ${others.slice(0, 4).map(page => `${page.name || page.url} (${page.employers})`).join(', ')}`, source: best.url });
  }
  const pages = ranked.map(page => ({ url: page.url, title: page.title }));
  for (const page of ranked.slice(0, 2)) {
    const stated = safeDomain(domainFromTitle(page.title));
    if (stated) {
      // The search result already names the domain, so a rate-limited or blocked RocketReach page cannot lose it.
      onEvent({ stage: 'RocketReach company', status: 'ok', detail: `RocketReach lists ${stated} for ${name}: “${page.title}” (from the search result; page not requested)`, source: page.url });
      return { domain: stated, source: page.url, title: page.title, mentions: 0, urls, pages };
    }
    try {
      const found = rocketReachDomain(await readPage(read, page.url, onEvent, 'RocketReach company'), page.url);
      onEvent({ stage: 'RocketReach company', status: found ? 'ok' : 'empty', detail: found ? `RocketReach lists ${found.domain} for ${name}: “${found.title}”` : 'The RocketReach page did not state an email domain.', source: page.url });
      if (found) return { ...found, urls, pages };
    } catch (error) { onEvent({ stage: 'RocketReach company', status: 'error', detail: error.message, source: page.url }); }
  }
  return null;
}

export async function findRocketReach(domain, { read = publicPage, onEvent = () => {}, company = '', env = {}, fetcher = fetch, urls = [] } = {}) {
  domain = domainOf(domain);
  const name = compact(company).replace(/["\r\n]/g, ' ').slice(0,100);
  const queries = [...new Set([...(name ? [`site:rocketreach.co ${name} email format`] : []), `site:rocketreach.co "${domain}" "email format"`, ...(name ? [`rocketreach ${name} email format`] : [])])];
  // `urls` entries are page links or { url, title } pairs from an earlier search; titles let other companies' pages be skipped unrequested.
  const links = new Map(), sources = [], patterns = [], warnings = [];
  for (const item of urls) { const url = rocketreachUrl(typeof item === 'string' ? item : item?.url); if (url && !links.has(url)) links.set(url, typeof item === 'string' ? '' : String(item?.title || '')); }
  if (links.size) onEvent({ stage: 'RocketReach search', status: 'ok', detail: `Reusing ${links.size} RocketReach page link${links.size === 1 ? '' : 's'} already found for ${name || domain}.` });
  else {
    const search = await searchRocketReach(queries, { env, fetcher, read, onEvent });
    // Titles read "Gartner Email Format | gartner.com Emails": pages naming the wanted domain are read first.
    const rows = search.rows.map(row => ({ url: rocketreachUrl(row.url), title: String(row.title || ''), named: String(row.title || '').toLowerCase().includes(domain) })).filter(row => row.url);
    for (const row of rows.sort((a, b) => Number(b.named) - Number(a.named))) if (!links.has(row.url)) links.set(row.url, row.title);
    warnings.push(...search.warnings);
  }
  onEvent({ stage: 'RocketReach search', status: links.size ? 'ok' : 'empty', detail: `${links.size} RocketReach email-format page links found` });
  const worthReading = [];
  for (const [source, title] of links) {
    const other = safeDomain(domainFromTitle(title));
    if (other && other !== domain) { onEvent({ stage: 'RocketReach page', status: 'empty', detail: `Skipped without a request: this page is for ${other} (“${title}”), not ${domain}.`, source }); continue; }
    worthReading.push(source);
  }
  for (const source of worthReading.slice(0, 3)) {
    onEvent({ stage: 'RocketReach page', status: 'running', detail: `Reading formats for ${domain}`, source });
    try {
      const html = await readPage(read, source, onEvent, 'RocketReach page');
      const report = parseRocketReach(html, domain, source);
      patterns.push(...report.patterns);
      const other = report.patterns.length ? null : rocketReachDomain(html, source);
      const detail = report.patterns.length ? report.patterns.map(p => `${p.format}${p.percentage === null ? '' : ` (${p.percentage}% reported)`}`).join(', ') : other && other.domain !== domain ? `Skipped: this page is for ${other.domain} (“${other.title}”), not ${domain}.` : 'No readable explicit formats matched this domain; page may require sign-in or JavaScript, or use unsupported notation.';
      sources.push({ source, status: report.patterns.length ? 'read' : 'no matching formats', examples: 0, detail });
      onEvent({ stage: 'RocketReach page', status: report.patterns.length ? 'ok' : 'empty', detail, source });
      for (const context of report.unsupported) onEvent({ stage: 'RocketReach format', status: 'rejected', detail: `Unsupported format: ${context}`, source });
      // The first page that reports formats is the company's own; reading the rest only spends RocketReach's rate limit (429 after ~a dozen reads).
      if (report.patterns.length) break;
    } catch (error) {
      sources.push({ source, status: 'unavailable', examples: 0, detail: error.message });
      onEvent({ stage: 'RocketReach page', status: 'error', detail: error.message, source });
    }
  }
  if (!patterns.length) {
    const failures = [...new Set(sources.filter(s => s.status === 'unavailable').map(s => s.detail))];
    const limited = failures.some(f => /429|bot check/i.test(f));
    warnings.push(failures.length
      ? `RocketReach pages could not be read (${failures.join('; ')}).${limited ? ' RocketReach’s bot protection is challenging requests from this computer; wait a while before running a fresh search.' : ''} Candidates are name-based guesses until formats are read.`
      : 'No RocketReach formats extracted. See search and page diagnostics; remaining candidates use public examples or fallback guesses.');
  }
  onEvent({ stage: 'RocketReach formats', status: patterns.length ? 'ok' : 'empty', detail: `${patterns.length} reported formats extracted from ${sources.length} pages` });
  // Pages are read in search-rank order; the first (main company) page wins.
  const unique = new Map();
  for (const p of patterns) if (!unique.has(p.format)) unique.set(p.format, p);
  return { patterns: [...unique.values()], sources, warnings };
}
