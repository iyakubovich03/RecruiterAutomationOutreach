// Pure "did I just apply, and to whom?" logic. No DOM access here so it can be unit-tested;
// content.js gathers the page facts and calls detect().
(function (root) {
  const CONFIRM = /\b(?:thank(?:s| you) for (?:applying|your application|submitting)|application (?:has been |was |is )?(?:submitted|received|sent|complete|completed)|we(?:'ve| have) received your application|successfully (?:submitted|applied)|your application (?:to|for|with) [^.!\n]{2,80}? (?:has been|was) (?:submitted|received|sent))\b/i;
  const NOISE = /\b(?:careers?|jobs?|job board|job search|hiring|apply|applying|applications?|submitted|received|confirmation|thank(?:s| you)|openings?|opportunities|talent|recruiting|workday|greenhouse|lever|ashby|linkedin|smartrecruiters|inc|llc|ltd|corp|corporation|company|co)\b\.?/gi;
  const capitalize = word => word ? word[0].toUpperCase() + word.slice(1) : '';

  function cleanCompany(value) {
    const name = String(value || '').replace(/\s[|•·–—-]\s.*$/, '').replace(NOISE, ' ').replace(/[^\p{L}\p{N}&.'\- ]+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/[.,]+$/, '');
    if (/^(?:for|at|to|the|and|your|our|a|an|of|in|on|with|we|you|has|been|is|was)$/i.test(name)) return '';
    return name.length >= 2 && name.length <= 60 ? name : '';
  }
  function fromSlug(slug) {
    const words = String(slug || '').toLowerCase().split(/[-_]+/).filter(Boolean);
    return words.length && words.length <= 5 && !/^\d+$/.test(words.join('')) ? cleanCompany(words.map(capitalize).join(' ')) : '';
  }
  function fromHost(hostname) {
    const labels = String(hostname || '').toLowerCase().split('.').filter(l => !/^(www|careers?|jobs?|apply|boards?|talent|recruiting|hire|wd\d+|myworkdayjobs|greenhouse|lever|ashbyhq|smartrecruiters|icims|com|co|org|net|io|uk|us|ca|de|fr)$/.test(l));
    return fromSlug(labels.at(-1));
  }
  // Page titles read "Job Application for X at Scale AI", "Software Engineer | Amazon", "Thanks for applying - Datadog".
  function fromTitle(title) {
    const text = String(title || '');
    const at = text.match(/\b(?:at|@)\s+([^|•·–—]{2,60}?)\s*$/i);
    if (at) { const company = cleanCompany(at[1]); if (company) return company; }
    // Fewest words wins; on a tie the later segment does ("Software Engineer | Acme Robotics").
    const segments = text.split(/\s[|•·–—-]\s/).map((segment, index) => ({ name: cleanCompany(segment), index })).filter(s => s.name);
    return segments.sort((a, b) => a.name.split(' ').length - b.name.split(' ').length || b.index - a.index)[0]?.name || '';
  }
  const workdayTenant = hostname => { const first = String(hostname || '').split('.')[0]; return /^wd\d+$/.test(first) ? '' : fromSlug(first); };
  // Workday paths look like /en-US/NVIDIAExternalCareerSite/job/...; skip the locale and the boilerplate suffix.
  const workdaySite = pathname => fromSlug(String(pathname || '').split('/').filter(s => s && !/^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(s))[0]?.replace(/(?:external)?(?:careers?|jobs?)?(?:site|portal)?$/i, ''));

  const adapters = [
    // Prefer the human-readable name (site name, title) over URL slugs like "scaleai".
    { id: 'lever', test: p => /(^|\.)jobs\.lever\.co$/.test(p.hostname), applied: p => /\/thanks\b/.test(p.pathname) || CONFIRM.test(p.text), company: p => cleanCompany(p.siteName) || fromTitle(p.title) || fromSlug(p.pathname.split('/')[1]) },
    { id: 'greenhouse', test: p => /greenhouse\.io$/.test(p.hostname), applied: p => CONFIRM.test(p.text), company: p => cleanCompany(p.siteName) || fromTitle(p.title) || fromSlug(p.pathname.split('/')[1]) },
    { id: 'ashby', test: p => /(^|\.)jobs\.ashbyhq\.com$/.test(p.hostname), applied: p => CONFIRM.test(p.text), company: p => cleanCompany(p.siteName) || fromTitle(p.title) || fromSlug(p.pathname.split('/')[1]) },
    { id: 'workday', test: p => /myworkdayjobs\.com$/.test(p.hostname), applied: p => CONFIRM.test(p.text), company: p => workdayTenant(p.hostname) || workdaySite(p.pathname) || cleanCompany(p.title) },
    { id: 'linkedin', test: p => /(^|\.)linkedin\.com$/.test(p.hostname), applied: p => /application (?:was |has been )?(?:sent|submitted)/i.test(p.text), company: p => { const m = p.text.match(/application (?:was |has been )?sent to ([^.!\n]{2,60})/i); return cleanCompany(m ? m[1] : p.jobCompany); } },
    { id: 'smartrecruiters', test: p => /smartrecruiters\.com$/.test(p.hostname), applied: p => CONFIRM.test(p.text), company: p => cleanCompany(p.siteName) || fromSlug(p.pathname.split('/')[1]) },
    { id: 'icims', test: p => /icims\.com$/.test(p.hostname), applied: p => CONFIRM.test(p.text), company: p => fromHost(p.hostname) || cleanCompany(p.title) },
    { id: 'generic', test: () => true, applied: p => CONFIRM.test(p.text), company: p => cleanCompany(p.jobCompany) || cleanCompany(p.siteName) || fromTitle(p.title) || fromHost(p.hostname) },
  ];

  // page: { hostname, pathname, title, siteName, jobCompany, text }
  function detect(page) {
    const p = { hostname: '', pathname: '', title: '', siteName: '', jobCompany: '', text: '', ...page };
    for (const adapter of adapters) {
      if (!adapter.test(p) || !adapter.applied(p)) continue;
      const company = adapter.company(p);
      return { adapter: adapter.id, company, confident: adapter.id !== 'generic' && !!company };
    }
    return null;
  }
  root.RecruiterOutreachDetect = { detect, cleanCompany, fromSlug, fromHost, fromTitle, CONFIRM };
})(typeof globalThis !== 'undefined' ? globalThis : this);
