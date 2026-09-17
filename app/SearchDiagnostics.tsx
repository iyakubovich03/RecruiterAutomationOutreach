"use client";
import { useEffect, useState } from 'react';
export type SearchDebug = { company: string; running: boolean; startedAt?: string; events: { stage: string; status: string; detail: string; source?: string; at: string }[] };
export default function SearchDiagnostics({ running, report, retry }: { running: boolean; report?: SearchDebug | null; retry: () => void }) {
  const [live, setLive] = useState<SearchDebug | null>(null), [issue, setIssue] = useState('');
  useEffect(() => {
    let active = true;
    async function poll() { try { const response = await fetch('/api/discover/status'); if (!response.ok) throw new Error('Search status is unavailable.'); const value = await response.json() as SearchDebug; if (active) { setLive(value); setIssue(''); } } catch (e) { if (active) setIssue(e instanceof Error ? e.message : 'Status connection failed.'); } }
    void poll();
    if (!running) return () => { active = false; };
    const timer = setInterval(() => void poll(), 1500);
    return () => { active = false; clearInterval(timer); };
  }, [running]);
  const data = running ? live : report || live;
  if (!data || (!running && !data.events.length)) return <section className="panel"><div className="empty"><span className="empty-icon">≡</span><h3>No requests yet</h3><p>Search for a company and every request made on your behalf — search queries, pages read, formats found, and failures — will be listed here.</p></div></section>;
  const failures = data.events.filter(e => ['error', 'blocked', 'unresolved'].includes(e.status)).length;
  return <section className="panel search-debug" aria-label="Search requests">
    <div className="section-heading"><div><h2>Requests {data.company ? `· ${data.company}` : ''}</h2><p role="status">{running ? (data.events.at(-1)?.detail || 'Starting search…') : `${data.events.length} steps · ${failures} failed. Newest at the bottom.`}</p></div><div className="button-row"><button className="secondary" disabled={running} onClick={retry}>Run fresh search</button><button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(data, null, 2)); setIssue('Report copied.'); } catch { setIssue('Copy unavailable. Select and copy the list below.'); } }}>Copy report</button></div></div>
    {issue && <p className="hint">{issue}</p>}
    <ol>{data.events.map((event, i) => <li key={i} className={['error', 'blocked', 'unresolved'].includes(event.status) ? 'diagnostic-error' : ['empty', 'rejected', 'partial', 'skipped', 'ambiguous'].includes(event.status) ? 'diagnostic-warning' : ''}><strong>{event.stage}</strong> <span className="tag">{event.status}</span> <small>{new Date(event.at).toLocaleTimeString()}</small><p>{event.detail}</p>{event.source && <a href={event.source} target="_blank" rel="noreferrer">{event.source}</a>}</li>)}</ol>
  </section>;
}
