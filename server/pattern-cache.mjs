import { domainOf } from './core.mjs';

const RETRY_MS = 60 * 60 * 1000;
const supported = report => !!report?.reportedPatterns?.length;
export function patternExpiry(checkedAt) {
  const date = new Date(checkedAt);
  if (!Number.isFinite(date.getTime())) return 0;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 3);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

// The domain is the canonical company key: aliases reuse evidence, while
// companies with the same display name and different domains stay separate.
export function createPatternCache(reports, save, research, now = Date.now) {
  const jobs = new Map();
  // `force` (a "Run fresh search") skips the one-hour hold after a failed attempt; saved formats are still reused until they expire.
  return async function getPatterns(company, value, onEvent = () => {}, { force = false, ...extra } = {}) {
    const domain = domainOf(value), previous = reports[domain], time = now();
    const expires = supported(previous) ? patternExpiry(previous.checkedAt) : 0;
    const retryAt = Date.parse(previous?.retryAfter || '');
    if (retryAt > time && force && expires <= time) onEvent({ stage: 'Email pattern cache', status: 'running', detail: `Fresh search requested; retrying format research before the hold ends (${previous.retryAfter}).` });
    if (expires > time || (retryAt > time && !force)) {
      const stale = supported(previous) && expires <= time;
      onEvent({ stage: 'Email pattern cache', status: stale ? 'partial' : 'cached', detail: expires > time
        ? `Using saved formats for ${company || domain}; collected ${previous.checkedAt}, refresh due ${new Date(expires).toISOString()}. No format sources requested.`
        : `Previous research failed or returned no formats. ${stale ? 'Keeping older evidence. ' : ''}Retry after ${previous.retryAfter}.` });
      return { report: previous, cached: true, stale };
    }
    if (jobs.has(domain)) {
      onEvent({ stage: 'Email pattern cache', status: 'running', detail: `Waiting for format research already running for ${domain}.` });
      return jobs.get(domain);
    }
    const job = (async () => {
      onEvent({ stage: 'Email pattern cache', status: 'running', detail: previous ? 'Saved formats expired; refreshing company research.' : 'No saved formats; searching for the company’s RocketReach page.' });
      let fresh, failure;
      try { fresh = await research(domain, undefined, { company, onEvent, ...extra }); }
      catch (error) { failure = error.message; onEvent({ stage: 'Email patterns', status: 'error', detail: failure }); }
      const checkedAt = new Date(now()).toISOString();
      let report;
      if (supported(fresh)) {
        report = { ...fresh, domain, company: String(company || domain).trim(), checkedAt, expiresAt: new Date(patternExpiry(checkedAt)).toISOString(), lastAttemptAt: checkedAt };
      } else {
        const refreshError = failure || 'No supported formats returned by the latest research.';
        report = { ...(supported(previous) ? previous : fresh || { reportedPatterns: [], sources: [], warnings: [] }), domain, company: String(company || domain).trim(),
          checkedAt: supported(previous) ? previous.checkedAt : checkedAt,
          lastAttemptAt: checkedAt, retryAfter: new Date(now() + RETRY_MS).toISOString(), refreshError,
          warnings: [...new Set([...(supported(previous) ? previous.warnings || [] : fresh?.warnings || []), refreshError, ...(supported(previous) ? ['Refresh failed; older format evidence is retained with its original collection date.'] : [])])],
        };
        if (supported(previous)) report.expiresAt = new Date(patternExpiry(previous.checkedAt)).toISOString();
        onEvent({ stage: 'Email pattern cache', status: 'partial', detail: `${refreshError} ${supported(previous) ? 'Older evidence retained. ' : ''}Retry after ${report.retryAfter}.` });
      }
      reports[domain] = report;
      save();
      return { report, cached: false, stale: supported(previous) && !supported(fresh) };
    })();
    jobs.set(domain, job);
    try { return await job; } finally { jobs.delete(domain); }
  };
}
