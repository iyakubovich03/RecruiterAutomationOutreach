import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'cheerio';
import { parseRocketReach } from '../server/rocketreach.mjs';

// Usage: node scripts/inspect-rocketreach.mjs [url] [email-domain] [--no-body]
// Raw response body goes to stdout; diagnostics go to stderr.
// Does not execute page scripts, solve challenges, use login cookies, or send email.
const args = process.argv.slice(2);
const input = args.find(arg => arg.startsWith('https://')) || 'https://rocketreach.co/google-email-format_b5c61c73f7be72fa';
const domain = args.find(arg => !arg.startsWith('https://') && !arg.startsWith('--')) || 'google.com';
const directory = resolve('.local-data/research/rocketreach-inspect', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFileSync(`${directory}/${name}`, value, { mode: 0o600 });
const validate = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^(www\.)?rocketreach\.co$/.test(url.hostname) || url.port || url.username || url.password) {
    throw new Error('Only HTTPS URLs on rocketreach.co or www.rocketreach.co are supported.');
  }
  return url;
};
const requests = [];
try {
  let url = validate(input), response, body;
  for (let hop = 0; hop < 6; hop++) {
    const started = Date.now();
    response = await fetch(url, {
      redirect: 'manual', signal: AbortSignal.timeout(25000),
      headers: { 'User-Agent': 'RecruiterFinder/1.0 (public contact research)', Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' },
    });
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); throw new Error('Response exceeded the 2 MB diagnostic limit.'); }
      chunks.push(Buffer.from(part.value));
    }
    body = Buffer.concat(chunks);
    const entry = { url: url.href, status: response.status, statusText: response.statusText, elapsedMs: Date.now() - started, bytes: body.length, headers: Object.fromEntries(response.headers), bodyFile: `response-${hop}.html` };
    requests.push(entry);
    save(entry.bodyFile, body);
    save('headers.json', JSON.stringify(requests, null, 2));
    if ([301,302,303,307,308].includes(response.status) && response.headers.has('location')) {
      if (hop === 5) throw new Error('Too many redirects.');
      url = validate(new URL(response.headers.get('location'), url).href);
      continue;
    }
    break;
  }
  save('body.html', body);
  if (!args.includes('--no-body')) process.stdout.write(body);
  const html = body.toString('utf8'), $ = load(html);
  const title = $('title').text();
  const scripts = $('script[src]').map((_, el) => $(el).attr('src')).get();
  const tableRows = $('tr').length;
  $('script,style,noscript').remove();
  const visibleText = $('body').text().replace(/\s+/g, ' ').trim();
  const challengeMarkers = ['challenge-platform', '__CF$cv$params', 'cf-chl-', 'Just a moment', 'Verify you are human'].filter(marker => html.toLowerCase().includes(marker.toLowerCase()));
  let parsed;
  try { parsed = parseRocketReach(html, domain, url.href); } catch (error) { parsed = { patterns: [], error: error.message }; }
  save('formats.json', JSON.stringify(parsed, null, 2));
  save('visible-text.txt', visibleText);
  const analysis = {
    requestedUrl: input, finalUrl: url.href, domain, status: response.status,
    bytes: body.length, title, tableRows, visibleTextCharacters: visibleText.length,
    visibleTextPreview: visibleText.slice(0,3000), scripts, challengeMarkers,
    domainMentioned: html.toLowerCase().includes('@' + domain.toLowerCase()),
    formatExtraction: parsed,
    diagnosis: challengeMarkers.length && !visibleText
      ? 'Challenge scripts with no visible body text. HTTP success did not return the company format content.'
      : parsed.patterns.length ? 'The current parser extracted formats from the returned HTML.'
      : 'No formats extracted. Inspect body.html and visible text to distinguish access failure, missing content, and parser limitations.',
    outputDirectory: directory,
  };
  save('analysis.json', JSON.stringify(analysis, null, 2));
  console.error('\n' + JSON.stringify(analysis, null, 2));
} catch (error) {
  const details = { error: error.message, cause: error.cause?.message, requests, outputDirectory: directory };
  save('error.json', JSON.stringify(details, null, 2));
  console.error(JSON.stringify(details, null, 2));
  process.exitCode = 1;
}
