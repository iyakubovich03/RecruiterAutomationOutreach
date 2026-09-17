"use client";
import { useEffect, useState } from 'react';
import type { SearchDebug } from './SearchDiagnostics';

const steps: [string, string[]][] = [
  ['Searching LinkedIn results', ['Search', 'Recruiter search', 'Profile filter', 'Recruiter discovery', 'Company association']],
  ['Checking the company domain', ['Domain search', 'Company website', 'Mail servers', 'Domain decision', 'Domain discovery']],
  ['Reading RocketReach formats', ['Email pattern cache', 'RocketReach search', 'RocketReach page', 'RocketReach format', 'RocketReach formats', 'Email patterns']],
  ['Building email candidates', ['Email candidates']],
];
const stepOf = (stage: string) => steps.findIndex(([, names]) => names.includes(stage));

export default function SearchProgress({ running, onViewRequests }: { running: boolean; onViewRequests: () => void }) {
  const [live, setLive] = useState<SearchDebug | null>(null);
  useEffect(() => {
    if (!running) return;
    let active = true;
    const poll = async () => { try { const r = await fetch('/api/discover/status'); if (r.ok) { const v = await r.json() as SearchDebug; if (active) setLive(v); } } catch { /* next poll retries */ } };
    void poll();
    const timer = setInterval(() => void poll(), 1200);
    return () => { active = false; clearInterval(timer); setLive(null); };
  }, [running]);
  if (!running) return null;
  const events = live?.events || [];
  const reached = Math.max(0, ...events.map(e => stepOf(e.stage)));
  const last = events.at(-1);
  return <section className="progress" aria-live="polite">
    <div className="progress-steps">{steps.map(([label], i) => <div key={label} className={'progress-step ' + (i < reached ? 'done' : i === reached ? 'active' : '')}>{i < reached ? '✓' : i === reached ? <span className="spinner" /> : '○'} {label}</div>)}</div>
    <div className="progress-detail">{last?.detail || 'Starting search…'}</div>
    <button className="plain" onClick={onViewRequests}>View every request and its result →</button>
  </section>;
}
