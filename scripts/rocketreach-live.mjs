import { mkdirSync, writeFileSync } from 'node:fs';
import { findRocketReach, parseRocketReach } from '../server/rocketreach.mjs';
import { publicPage } from '../server/public-page.mjs';
import { domainOf } from '../server/core.mjs';
import { load } from 'cheerio';
import { loadEnv } from 'vite';

const env = loadEnv('development', process.cwd(), '');
const domain = domainOf(process.argv[2] || 'apple.com');
const directUrl = process.argv[3]?.startsWith('https://') ? process.argv[3] : undefined;
const company = process.argv.find(arg=>arg.startsWith('--company='))?.slice(10) || '';
const directory = `.local-data/research/${domain}`;
mkdirSync(directory, { recursive: true });
const events = [], requests = [];
const read = async url => {
  const request = { url, startedAt: new Date().toISOString() };
  requests.push(request);
  try {
    const html = await publicPage(url);
    request.file = `${directory}/response-${requests.length}.html`;
    request.characters = html.length;
    writeFileSync(request.file, html);
    const $ = load(html);
    request.title = $('title').text();
    $('script,style,noscript').remove();
    request.visibleText = $('body').text().replace(/\s+/g, ' ').trim().slice(0,500);
    request.challenge = /\/cdn-cgi\/challenge-platform\//i.test(html) && !request.visibleText;
    if (request.challenge) throw new Error('HTTP 200 returned a JavaScript challenge shell, not readable page content.');
    return html;
  } catch (error) { request.error = error.message; throw error; }
};
const onEvent = event => { events.push({ ...event, at: new Date().toISOString() }); console.log(JSON.stringify(event)); };
let result;
try {
  result = directUrl ? parseRocketReach(await read(directUrl), domain, directUrl) : await findRocketReach(domain, { read, onEvent, company, env });
} catch (error) { result = { patterns: [], error: error.message }; }
const report = { domain, checkedAt: new Date().toISOString(), directUrl, requests, events, result };
const file = `${directory}/${directUrl ? 'rocketreach-direct' : 'rocketreach-search'}.json`;
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: file, result }, null, 2));
if (!result.patterns.length) process.exitCode = 1;
