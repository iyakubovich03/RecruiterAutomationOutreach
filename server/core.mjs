import { randomBytes } from 'node:crypto';
import { extractEmails, parseProfileText } from './profile.mjs';
import { searchConfig } from './config.mjs';
export const emailPattern = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
export function domainOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  let domain;
  try { domain = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, ''); } catch { throw new Error('Enter a company domain such as stripe.com.'); }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('Enter a valid public company domain.');
  return domain;
}
const clean = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
// Tokens: first, last, f/l (one initial), f2/l2 (first two letters), joined by . _ - or nothing.
export function candidateForFormat(name, domain, format) {
  if (!/^(?:first|last|f2|l2|f|l)(?:[._-]?(?:first|last|f2|l2|f|l))?$/.test(format)) return null;
  const parts = name.trim().split(/\s+/).map(clean).filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0], last = parts.at(-1);
  const values = { first, last, f: first[0], l: last[0], f2: first.slice(0, 2), l2: last.slice(0, 2) };
  return format.replace(/first|last|f2|l2|f|l/g, token => values[token]) + '@' + domainOf(domain);
}
export function candidates(name, domain, evidence = '') {
  domain = domainOf(domain);
  const parts = name.trim().split(/\s+/).map(clean).filter(Boolean);
  if (parts.length < 2) throw new Error('Enter a first and last name to generate candidates.');
  const first = parts[0], last = parts.at(-1);
  const found = extractEmails(evidence).filter(e => e.split('@')[1] === domain);
  const formats = [[`${first}.${last}`, 'first.last'], [`${first[0]}${last}`, 'flast'], [`${first}${last}`, 'firstlast'], [first, 'first'], [`${first}_${last}`, 'first_last'], [`${first}${last[0]}`, 'firstl']];
  return [...new Map([...formats.map(([local, format]) => ({ email: `${local}@${domain}`, format, evidence: 'Name-based guess; no mailbox evidence', status: 'unverified' })), ...found.map(email => ({ email: email.toLowerCase(), format: 'Imported address', evidence: 'Found in supplied text; confirm ownership', status: 'unverified' }))].map(c => [c.email, c])).values()].sort((a,b) => Number(b.format === 'Imported address') - Number(a.format === 'Imported address'));
}
export const parseProfile = parseProfileText;
// Focus tiers come from search.config.json, most relevant first. A tier matches when
// any of its `any` terms appear and (if given) at least one `also` term appears too.
export function relevance(title, config = searchConfig) {
  const text = String(title || '');
  const tier = config.focusTiers.find(t => t.anyPattern.test(text) && (!t.alsoPattern || t.alsoPattern.test(text)));
  return tier ? tier.label : config.fallbackFocus;
}
// Higher is more relevant: first tier scores highest, unmatched scores 1.
export function focusScore(focus, config = searchConfig) {
  const index = config.focusTiers.findIndex(t => t.label === focus);
  return index === -1 ? 1 : config.focusTiers.length - index + 1;
}
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const escapeHtml = value => value.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Plain text alone renders in a narrow hard-wrapped column in Gmail; an HTML twin keeps normal paragraphs.
const linkify = text => text.split(/(https?:\/\/[^\s<>"]+|\bwww\.[^\s<>"]+|\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/).map((piece, i) => {
  if (i % 2 === 0) return escapeHtml(piece);
  const trailing = piece.match(/[.,;:!?)\]]+$/)?.[0] || '';
  const target = piece.slice(0, piece.length - trailing.length);
  const href = target.includes('@') && !/^https?:/.test(target) ? 'mailto:' + target : /^www\./.test(target) ? 'https://' + target : target;
  return `<a href="${escapeHtml(href)}" style="color:#1a73e8">${escapeHtml(target)}</a>${escapeHtml(trailing)}`;
}).join('');
export function htmlBody(message) {
  const paragraphs = message.replace(/\r\n/g, '\n').trim().split(/\n{2,}/).map(p => '<p style="margin:0 0 1em">' + linkify(p).replace(/\n/g, '<br>') + '</p>').join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124">${paragraphs}</div>`;
}
export function mimeMessage({ to, from, subject, message, attachment = null, messageId = '' }) {
  if (!emailPattern.test(to) || !emailPattern.test(from)) throw new Error('A valid sender and recipient email are required.');
  if (!subject?.trim() || /[\r\n]/.test(subject) || subject.length > 200) throw new Error('Use a subject of 1–200 characters without line breaks.');
  if (!message?.trim() || message.length > 20000) throw new Error('Use a message of 1–20,000 characters.');
  if (/\{[a-z_]+\}/i.test(subject + message)) throw new Error('Replace all message placeholders before sending.');
  const wrap = base64 => base64.match(/.{1,76}/g).join('\r\n');
  // A known Message-ID lets a later bounce notice (In-Reply-To) be matched back to this email.
  const headers = ['From: ' + from, 'To: ' + to, 'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=', ...(messageId ? ['Message-ID: <' + String(messageId).replace(/[<>\r\n\s]/g, '') + '>'] : []), 'MIME-Version: 1.0'];
  const alt = 'alt_' + randomBytes(12).toString('hex');
  const body = [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(Buffer.from(message).toString('base64')), `--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(Buffer.from(htmlBody(message)).toString('base64')), `--${alt}--`];
  let content;
  if (!attachment) content = [...headers, ...body, ''].join('\r\n');
  else {
    if (!attachment.content?.length || !attachment.filename) throw new Error('The attachment is missing.');
    if (attachment.content.length > MAX_ATTACHMENT_BYTES) throw new Error('The attachment must be 5 MB or smaller.');
    const filename = String(attachment.filename).replace(/["\\\r\n]/g, '').slice(0, 120);
    const type = String(attachment.type || 'application/octet-stream').replace(/[^a-z0-9./+-]/gi, '');
    const boundary = 'part_' + randomBytes(12).toString('hex');
    content = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...body, `--${boundary}`, `Content-Type: ${type}; name="${filename}"`, `Content-Disposition: attachment; filename="${filename}"`, 'Content-Transfer-Encoding: base64', '', wrap(attachment.content.toString('base64')), `--${boundary}--`, ''].join('\r\n');
  }
  return Buffer.from(content).toString('base64url');
}
