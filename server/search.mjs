import { load } from 'cheerio';
import { publicPage } from './public-page.mjs';

const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
export const blockedMarkers = /anomaly\.js|anomaly-modal|challenge-form|captcha|verify you are human|just a moment|access denied/i;

export function unwrapUrl(value, base = 'https://html.duckduckgo.com') {
  try {
    let url = new URL(value, base);
    if (['duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname) && url.searchParams.has('uddg')) url = new URL(url.searchParams.get('uddg'));
    if (['google.com', 'www.google.com'].includes(url.hostname) && url.pathname === '/url') url = new URL(url.searchParams.get('q') || url.searchParams.get('url'));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function parseSearchHtml(html, provider) {
  const $ = load(html, { xml: provider === 'bing' }), rows = [];
  if (provider === 'bing') $('item').each((_, el) => { const node = $(el); rows.push({ url: unwrapUrl(node.find('link').text()), title: compact(node.find('title').text()), snippet: compact(node.find('description').text()) }); });
  else if (provider === 'google') $('a[href]').each((_, el) => { const a = $(el); rows.push({ url: unwrapUrl(a.attr('href'), 'https://www.google.com'), title: compact(a.find('h3').text() || a.text()), snippet: '' }); });
  else $('.result__a').each((_, el) => { const link = $(el); rows.push({ url: unwrapUrl(link.attr('href')), title: compact(link.text()), snippet: compact(link.closest('.result').find('.result__snippet').text()) }); });
  const unique = new Map();
  for (const row of rows) if (row.url && !unique.has(row.url)) unique.set(row.url, row);
  return [...unique.values()];
}

const scrapers = {
  duckduckgo: { label: 'DuckDuckGo public search', url: query => 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), check: () => {} },
  bing: { label: 'Bing public search', url: query => 'https://www.bing.com/search?format=rss&q=' + encodeURIComponent(query), check: html => { if (!/<rss[\s>]/i.test(html)) throw new Error('Search source did not return a readable results feed.'); } },
  google: { label: 'Google public search', url: query => 'https://www.google.com/search?q=' + encodeURIComponent(query), check: html => { if (/\/httpservice\/retry\/enablejs/.test(html)) throw new Error('Google returned a JavaScript-required page instead of search results.'); } },
};

// Keyed APIs honor site: operators and are not bot-walled; public HTML search
// pages have stopped returning LinkedIn profiles, so they are fallbacks only.
export function apiProviders(env = {}) {
  const providers = [];
  if (env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_ID) providers.push({
    name: 'google-api', label: 'Google Custom Search API',
    source: query => 'https://www.googleapis.com/customsearch/v1?q=' + encodeURIComponent(query),
    async search(query, fetcher) {
      const params = new URLSearchParams({ key: env.GOOGLE_CSE_KEY, cx: env.GOOGLE_CSE_ID, q: query, num: '10' });
      const response = await fetcher('https://www.googleapis.com/customsearch/v1?' + params, { signal: AbortSignal.timeout(15000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Google Custom Search API error (${response.status}): ${data.error?.message || 'no details'}`);
      return (data.items || []).map(item => ({ url: unwrapUrl(item.link), title: compact(item.title), snippet: compact(item.snippet) }));
    },
  });
  if (env.SERPER_API_KEY) providers.push({
    name: 'serper', label: 'Serper Google API',
    source: query => 'https://google.serper.dev/search?q=' + encodeURIComponent(query),
    async search(query, fetcher) {
      const response = await fetcher('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query, num: 10 }), signal: AbortSignal.timeout(15000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Serper API error (${response.status}): ${data.message || 'no details'}`);
      return (data.organic || []).map(item => ({ url: unwrapUrl(item.link), title: compact(item.title), snippet: compact(item.snippet) }));
    },
  });
  if (env.SERPAPI_KEY) providers.push({
    name: 'serpapi', label: 'SerpApi Google API',
    source: query => 'https://serpapi.com/search?engine=google&q=' + encodeURIComponent(query),
    async search(query, fetcher) {
      const params = new URLSearchParams({ engine: 'google', q: query, num: '10', output: 'json', api_key: env.SERPAPI_KEY });
      const response = await fetcher('https://serpapi.com/search?' + params, { signal: AbortSignal.timeout(15000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(`SerpApi error (${response.status}): ${data.error || 'no details'}`);
      return (data.organic_results || []).map(item => ({ url: unwrapUrl(item.link), title: compact(item.title), snippet: compact(item.snippet) }));
    },
  });
  return providers;
}

const transientSearchError = /aborted|timed? ?out|ECONNRESET|EAI_AGAIN|socket hang up|fetch failed|\(5\d\d\)/i;
apiProviders.names = new Set(['google-api', 'serper', 'serpapi']);
export async function searchWeb(query, { env = {}, fetcher = fetch, read = publicPage, onEvent = () => {}, stage = 'Search', scrape = ['duckduckgo', 'bing'], accept = rows => rows.length > 0 } = {}) {
  const providers = [...apiProviders(env), ...scrape.map(name => ({ name, label: scrapers[name].label, source: scrapers[name].url, async search(q) { const html = await read(scrapers[name].url(q)); if (blockedMarkers.test(html)) throw new Error('Search source requires an interactive check.'); scrapers[name].check(html); return parseSearchHtml(html, name); } }))];
  const warnings = [];
  let available = 0;
  for (const provider of providers) {
    const source = provider.source(query);
    onEvent({ stage, status: 'running', detail: `${provider.name}: ${query}`, source });
    try {
      // A search API occasionally times out on a single request; one retry keeps that from sinking the whole search.
      const rows = (await provider.search(query, fetcher).catch(async error => {
        if (!transientSearchError.test(error.message) || !apiProviders.names.has(provider.name)) throw error;
        onEvent({ stage, status: 'partial', detail: `${provider.name}: ${error.message}. Retrying once.`, source });
        return provider.search(query, fetcher);
      })).filter(row => row.url);
      available++;
      const done = accept(rows);
      onEvent({ stage, status: rows.length ? 'ok' : 'empty', detail: `${provider.name}: ${rows.length} results${rows.length && !done ? '; none matched, trying the next source' : ''}`, source });
      if (done) return { rows, provider: provider.label, warnings, available };
    } catch (error) {
      warnings.push(`${provider.label} was unavailable or blocked.`);
      onEvent({ stage, status: 'error', detail: error.message, source });
    }
  }
  return { rows: [], provider: '', warnings, available };
}
