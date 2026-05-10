/**
 * Activity tab — live feed of MCP tool-calls for a project.
 *
 * Data sources:
 *  - Initial history: GET /api/projects/journal?project=<root>&limit=200
 *  - Live updates:    SSE /api/events  (filters events where event.project === root)
 *  - Aggregated stats: GET /api/projects/journal/stats?project=<root>&window=3600000
 *                      Fetched once on mount, then every 30 s.
 *
 * Behaviour:
 *  - Newest entries on top.
 *  - Auto-scrolls to top on new entry unless user has scrolled down.
 *  - Caps in-memory list to 1000 entries (drops oldest).
 *  - Filter chips: All / Errors only / top-5 tools by frequency.
 *  - Stats panel above feed: hot tools, latency histogram, error groups, sparkline.
 *    - Clicking a hot tool name filters the feed to that tool.
 *    - Clicking an error group filters to that tool with errors-only.
 *    - Live SSE events increment local counters between 30-s reconciliations.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const BASE = 'http://127.0.0.1:3741';
const MAX_ENTRIES = 1000;
const STATS_INTERVAL_MS = 30_000;
const STATS_WINDOW_MS = 3_600_000; // 1 hour

// ── Types ─────────────────────────────────────────────────────────────────

interface JournalEntry {
  type: 'journal_entry';
  project: string;
  ts: number;
  tool: string;
  params_summary: string;
  result_count: number;
  result_tokens?: number;
  latency_ms?: number;
  is_error: boolean;
  session_id: string;
}

type FilterMode = 'all' | 'errors' | string; // string = tool name filter

// Matches JournalStatsResponse from journal-stats-routes.ts
interface HotTool {
  tool: string;
  count: number;
  avg_latency_ms: number;
  error_count: number;
}

interface HotFile {
  file: string;
  count: number;
}

interface LatencyBucket {
  bucket_ms: number; // -1 = open-ended >=5000ms
  count: number;
}

interface ErrorGroup {
  tool: string;
  sample_summary: string;
  count: number;
}

interface ByMinute {
  ts: number;
  count: number;
  error_count: number;
}

interface JournalStats {
  window_ms: number;
  total_calls: number;
  error_rate: number;
  hot_tools: HotTool[];
  hot_files: HotFile[];
  latency_buckets: LatencyBucket[];
  error_groups: ErrorGroup[];
  by_minute: ByMinute[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 5000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function topTools(entries: JournalEntry[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([tool]) => tool);
}

function formatLatencyBucket(bucket_ms: number): string {
  if (bucket_ms === -1) return '5s+';
  if (bucket_ms === 0) return '<10ms';
  if (bucket_ms < 1000) return `${bucket_ms}ms`;
  return `${bucket_ms / 1000}s`;
}

// p95 from latency_buckets (approximate — uses bucket left-edges)
function computeP95(buckets: LatencyBucket[]): string {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) return '—';
  const threshold = total * 0.95;
  let cumulative = 0;
  for (const b of buckets) {
    cumulative += b.count;
    if (cumulative >= threshold) {
      return formatLatencyBucket(b.bucket_ms);
    }
  }
  return formatLatencyBucket(buckets[buckets.length - 1]?.bucket_ms ?? -1);
}

// ── Sub-components ────────────────────────────────────────────────────────

function ToolBadge({ tool, isError }: { tool: string; isError: boolean }) {
  const bg = isError ? 'rgba(239,68,68,0.15)' : 'rgba(0,122,255,0.1)';
  const color = isError ? 'var(--red, #ef4444)' : 'var(--accent, #007aff)';
  return (
    <span
      className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap"
      style={{ background: bg, color }}
    >
      {tool}
    </span>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11px] px-2.5 py-1 rounded-full transition-all shrink-0"
      style={{
        background: active ? 'var(--accent)' : 'var(--bg-inset)',
        color: active ? '#fff' : 'var(--text-secondary)',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        border: 'none',
      }}
    >
      {label}
    </button>
  );
}

function EntryRow({ entry }: { entry: JournalEntry }) {
  const [, setTick] = useState(0);
  // Re-render every 10s so relative timestamps update
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  const rowBg = entry.is_error ? 'rgba(239,68,68,0.06)' : 'transparent';

  return (
    <div
      className="flex items-start gap-2.5 px-3 py-2"
      style={{
        borderBottom: '0.5px solid var(--border-row)',
        background: rowBg,
        minHeight: 36,
      }}
    >
      {/* Relative time */}
      <span
        className="shrink-0 text-[10px] tabular-nums mt-0.5 w-14 text-right"
        style={{ color: 'var(--text-tertiary)', fontFamily: 'SF Mono, Menlo, monospace' }}
      >
        {relativeTime(entry.ts)}
      </span>

      {/* Tool badge */}
      <ToolBadge tool={entry.tool} isError={entry.is_error} />

      {/* Params summary */}
      <div className="flex-1 min-w-0">
        <div
          className="text-[12px] truncate leading-snug"
          style={{
            color: entry.is_error ? 'var(--red, #ef4444)' : 'var(--text-primary)',
            fontFamily: 'SF Mono, Menlo, monospace',
          }}
          title={entry.params_summary}
        >
          {truncate(entry.params_summary, 120)}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            {entry.result_count} result{entry.result_count === 1 ? '' : 's'}
          </span>
          {entry.latency_ms !== undefined && (
            <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {entry.latency_ms < 1000
                ? `${entry.latency_ms}ms`
                : `${(entry.latency_ms / 1000).toFixed(1)}s`}
            </span>
          )}
          {entry.result_tokens !== undefined && (
            <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              ~{entry.result_tokens} tok
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Stats sub-components ──────────────────────────────────────────────────

/**
 * Top-row summary bar: total calls, error rate, p95 latency.
 * Always visible; clicking the chevron expands/collapses the full panel.
 */
function StatsSummaryBar({
  stats,
  expanded,
  onToggle,
}: {
  stats: JournalStats;
  expanded: boolean;
  onToggle: () => void;
}) {
  const errorPct = (stats.error_rate * 100).toFixed(1);
  const p95 = computeP95(stats.latency_buckets);
  const errorColor =
    stats.error_rate > 0.1
      ? 'var(--red, #ef4444)'
      : stats.error_rate > 0.02
        ? 'var(--orange, #f97316)'
        : 'var(--text-secondary)';

  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-3 px-3 py-1.5 text-left"
      style={{
        background: 'var(--bg-inset)',
        border: 'none',
        borderBottom: '0.5px solid var(--border-row)',
        cursor: 'pointer',
      }}
    >
      <span className="text-[10px] font-semibold" style={{ color: 'var(--text-tertiary)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        Stats (1h)
      </span>
      <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-primary)' }}>
        <span className="font-semibold tabular-nums">{stats.total_calls.toLocaleString()}</span>
        <span style={{ color: 'var(--text-tertiary)' }}>calls</span>
      </span>
      <span className="flex items-center gap-1 text-[11px]" style={{ color: errorColor }}>
        <span className="font-semibold tabular-nums">{errorPct}%</span>
        <span style={{ color: 'var(--text-tertiary)' }}>err</span>
      </span>
      <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-primary)' }}>
        <span className="font-semibold tabular-nums">{p95}</span>
        <span style={{ color: 'var(--text-tertiary)' }}>p95</span>
      </span>
      <span className="ml-auto text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        {expanded ? '▲' : '▼'}
      </span>
    </button>
  );
}

/**
 * Horizontal bar chart for hot tools (pure CSS, no chart lib).
 */
function HotToolsChart({
  tools,
  onToolClick,
  activeFilter,
}: {
  tools: HotTool[];
  onToolClick: (tool: string) => void;
  activeFilter: FilterMode;
}) {
  if (tools.length === 0) return null;
  const maxCount = tools[0].count;
  return (
    <div>
      <div className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Hot Tools
      </div>
      <div className="flex flex-col gap-1">
        {tools.map((t) => {
          const pct = maxCount > 0 ? (t.count / maxCount) * 100 : 0;
          const isActive = activeFilter === t.tool;
          const hasErrors = t.error_count > 0;
          return (
            <button
              key={t.tool}
              type="button"
              onClick={() => onToolClick(t.tool)}
              className="flex items-center gap-2 w-full text-left"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 0' }}
              title={`avg ${t.avg_latency_ms}ms · ${t.error_count} errors`}
            >
              <span
                className="shrink-0 text-[10px] tabular-nums w-24 truncate"
                style={{
                  color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                  fontWeight: isActive ? 600 : 400,
                  fontFamily: 'SF Mono, Menlo, monospace',
                }}
              >
                {t.tool}
              </span>
              <div className="flex-1 relative h-3 rounded-sm overflow-hidden" style={{ background: 'var(--bg-grouped)' }}>
                <div
                  className="absolute inset-y-0 left-0 rounded-sm"
                  style={{
                    width: `${pct}%`,
                    background: hasErrors
                      ? 'linear-gradient(90deg, var(--accent, #007aff), var(--red, #ef4444))'
                      : 'var(--accent, #007aff)',
                    opacity: isActive ? 1 : 0.6,
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
              <span className="shrink-0 text-[10px] tabular-nums w-7 text-right" style={{ color: 'var(--text-tertiary)' }}>
                {t.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Vertical bar latency histogram (pure CSS).
 */
function LatencyHistogram({ buckets }: { buckets: LatencyBucket[] }) {
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  return (
    <div>
      <div className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Latency
      </div>
      <div className="flex items-end gap-0.5" style={{ height: 40 }}>
        {buckets.map((b) => {
          const heightPct = (b.count / maxCount) * 100;
          const label = formatLatencyBucket(b.bucket_ms);
          return (
            <div
              key={b.bucket_ms}
              className="flex flex-col items-center flex-1"
              title={`${label}: ${b.count}`}
            >
              <div className="w-full flex items-end" style={{ height: 32 }}>
                <div
                  className="w-full rounded-t-sm"
                  style={{
                    height: `${heightPct}%`,
                    minHeight: b.count > 0 ? 2 : 0,
                    background: 'var(--accent, #007aff)',
                    opacity: 0.7,
                    transition: 'height 0.3s ease',
                  }}
                />
              </div>
              <span
                className="text-[8px] tabular-nums mt-0.5 truncate w-full text-center"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Error groups: collapsible list with count badge.
 * Clicking a group sets filter to that tool with errors-only.
 */
function ErrorGroupsList({
  groups,
  onGroupClick,
  activeFilter,
}: {
  groups: ErrorGroup[];
  onGroupClick: (tool: string) => void;
  activeFilter: FilterMode;
}) {
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  if (groups.length === 0) return null;

  return (
    <div>
      <div className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Error Groups
      </div>
      <div className="flex flex-col gap-0.5">
        {groups.map((g) => {
          const isExpanded = expandedTool === g.tool;
          const isActive = activeFilter === g.tool;
          return (
            <div key={g.tool}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setExpandedTool(isExpanded ? null : g.tool)}
                  className="text-[9px] shrink-0"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: '0 2px' }}
                >
                  {isExpanded ? '▼' : '▶'}
                </button>
                <button
                  type="button"
                  onClick={() => onGroupClick(g.tool)}
                  className="flex-1 text-left text-[10px] truncate"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: isActive ? 'var(--red, #ef4444)' : 'var(--text-primary)',
                    fontWeight: isActive ? 600 : 400,
                    fontFamily: 'SF Mono, Menlo, monospace',
                    padding: 0,
                  }}
                >
                  {g.tool}
                </button>
                <span
                  className="shrink-0 text-[9px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full"
                  style={{ background: 'rgba(239,68,68,0.15)', color: 'var(--red, #ef4444)' }}
                >
                  {g.count}
                </span>
              </div>
              {isExpanded && (
                <div
                  className="mt-0.5 ml-5 text-[9px] truncate rounded px-1.5 py-1"
                  style={{
                    background: 'rgba(239,68,68,0.06)',
                    color: 'var(--text-secondary)',
                    fontFamily: 'SF Mono, Menlo, monospace',
                  }}
                  title={g.sample_summary}
                >
                  {truncate(g.sample_summary, 100)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Sparkline: 60 vertical bars for by_minute data.
 */
function Sparkline({ byMinute }: { byMinute: ByMinute[] }) {
  const maxCount = Math.max(...byMinute.map((m) => m.count), 1);
  return (
    <div>
      <div className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Last 60 min
      </div>
      <div className="flex items-end gap-px" style={{ height: 28 }}>
        {byMinute.map((m) => {
          const heightPct = (m.count / maxCount) * 100;
          const hasErrors = m.error_count > 0;
          const minuteLabel = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return (
            <div
              key={m.ts}
              className="flex-1 rounded-t-sm"
              title={`${minuteLabel}: ${m.count} calls${hasErrors ? `, ${m.error_count} errors` : ''}`}
              style={{
                height: `${heightPct}%`,
                minHeight: m.count > 0 ? 2 : 0,
                background: hasErrors
                  ? 'var(--red, #ef4444)'
                  : 'var(--accent, #007aff)',
                opacity: 0.65,
                transition: 'height 0.3s ease',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * The full expandable Stats panel.
 */
function StatsPanel({
  stats,
  onToolClick,
  onErrorGroupClick,
  activeFilter,
}: {
  stats: JournalStats;
  onToolClick: (tool: string) => void;
  onErrorGroupClick: (tool: string) => void;
  activeFilter: FilterMode;
}) {
  return (
    <div
      className="shrink-0 px-3 py-2.5 flex flex-col gap-3"
      style={{
        borderBottom: '0.5px solid var(--border-row)',
        background: 'var(--bg-grouped)',
      }}
    >
      {/* Row 1: hot tools + latency histogram side by side */}
      <div className="flex gap-4">
        <div className="flex-1 min-w-0">
          <HotToolsChart
            tools={stats.hot_tools}
            onToolClick={onToolClick}
            activeFilter={activeFilter}
          />
        </div>
        <div style={{ width: 140, flexShrink: 0 }}>
          <LatencyHistogram buckets={stats.latency_buckets} />
        </div>
      </div>

      {/* Row 2: error groups + sparkline side by side */}
      <div className="flex gap-4">
        <div className="flex-1 min-w-0">
          {stats.error_groups.length > 0 ? (
            <ErrorGroupsList
              groups={stats.error_groups}
              onGroupClick={onErrorGroupClick}
              activeFilter={activeFilter}
            />
          ) : (
            <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              No errors in this window.
            </div>
          )}
        </div>
        <div style={{ width: 140, flexShrink: 0 }}>
          <Sparkline byMinute={stats.by_minute} />
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function Activity({ root }: { root: string }) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Stats state ──────────────────────────────────────────────────────
  const [stats, setStats] = useState<JournalStats | null>(null);
  const [statsExpanded, setStatsExpanded] = useState(true);
  // Live incremental counters between server reconciliations
  const liveCountsRef = useRef({ calls: 0, errors: 0 });

  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the user has scrolled away from the top (newest entries)
  const userScrolledRef = useRef(false);

  // ── Fetch aggregated stats ────────────────────────────────────────────

  const fetchStats = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        project: root,
        window: String(STATS_WINDOW_MS),
      });
      const res = await fetch(`${BASE}/api/projects/journal/stats?${params}`);
      if (res.ok) {
        const data = (await res.json()) as JournalStats;
        setStats(data);
        // Reset live increment counters after a server reconciliation
        liveCountsRef.current = { calls: 0, errors: 0 };
      }
    } catch {
      /* stats are best-effort — silently skip on network error */
    }
  }, [root]);

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, STATS_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStats]);

  // ── Fetch initial history ────────────────────────────────────────────

  const fetchHistory = useCallback(async () => {
    try {
      const params = new URLSearchParams({ project: root, limit: '200' });
      const res = await fetch(`${BASE}/api/projects/journal?${params}`);
      if (res.ok) {
        const data = (await res.json()) as JournalEntry[];
        // Snapshot is newest-first already (server sorts that way)
        setEntries((prev) => {
          const merged = [...data, ...prev];
          // Deduplicate by ts+tool+session_id
          const seen = new Set<string>();
          const deduped: JournalEntry[] = [];
          for (const e of merged) {
            const key = `${e.ts}:${e.tool}:${e.session_id}`;
            if (!seen.has(key)) {
              seen.add(key);
              deduped.push(e);
            }
          }
          return deduped.slice(0, MAX_ENTRIES);
        });
      }
    } catch {
      /* history is optional — live SSE is the primary source */
    }
  }, [root]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // ── SSE subscription ─────────────────────────────────────────────────

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;

    function connect() {
      es = new EventSource(`${BASE}/api/events`);

      es.onopen = () => {
        if (!closed) {
          setConnected(true);
          setError(null);
        }
      };

      es.onmessage = (evt: MessageEvent) => {
        if (closed) return;
        try {
          const data = JSON.parse(evt.data as string) as Record<string, unknown>;
          if (data.type !== 'journal_entry') return;
          if (data.project !== root) return;

          const entry = data as unknown as JournalEntry;
          setEntries((prev) => {
            const next = [entry, ...prev];
            return next.slice(0, MAX_ENTRIES);
          });

          // Increment live counters so the summary bar stays fresh
          // between 30-s server reconciliations
          liveCountsRef.current.calls++;
          if (entry.is_error) liveCountsRef.current.errors++;
          setStats((prev) => {
            if (!prev) return prev;
            // Cheaply bump total_calls and error_rate without recomputing
            // the full histogram — server reconciliation handles precision.
            const newTotal = prev.total_calls + 1;
            const newErrors = Math.round(prev.error_rate * prev.total_calls) + (entry.is_error ? 1 : 0);
            return {
              ...prev,
              total_calls: newTotal,
              error_rate: newTotal > 0 ? newErrors / newTotal : 0,
            };
          });

          // Auto-scroll to top unless user has scrolled down
          if (!userScrolledRef.current && scrollRef.current) {
            scrollRef.current.scrollTop = 0;
          }
        } catch {
          /* ignore malformed events */
        }
      };

      es.onerror = () => {
        if (closed) return;
        setConnected(false);
        setError('SSE connection lost — reconnecting…');
        es?.close();
        // Reconnect after 3s
        setTimeout(() => {
          if (!closed) connect();
        }, 3000);
      };
    }

    connect();
    return () => {
      closed = true;
      es?.close();
      setConnected(false);
    };
  }, [root]);

  // ── Scroll tracking ──────────────────────────────────────────────────

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // If user scrolled more than 60px from top, mark as "scrolled away"
    userScrolledRef.current = el.scrollTop > 60;
  }, []);

  // ── Filter callbacks wired to stats panel ─────────────────────────────

  // Clicking a hot tool: filter feed to that tool
  const handleToolClick = useCallback(
    (tool: string) => {
      setFilter((prev) => (prev === tool ? 'all' : tool));
    },
    [],
  );

  // Clicking an error group: filter feed to that tool, errors-only.
  // We represent this as the standard tool filter; the user can combine
  // with the "Errors" chip manually. For a simple UX, clicking an error
  // group just sets the tool filter (the error rows appear at the top
  // because the SSE feed has them already).
  const handleErrorGroupClick = useCallback(
    (tool: string) => {
      setFilter((prev) => (prev === tool ? 'errors' : tool));
    },
    [],
  );

  // ── Filtering ────────────────────────────────────────────────────────

  const top5 = topTools(entries, 5);

  const filtered =
    filter === 'all'
      ? entries
      : filter === 'errors'
        ? entries.filter((e) => e.is_error)
        : entries.filter((e) => e.tool === filter);

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col h-full"
      style={{ color: 'var(--text-primary)' }}
    >
      {/* ── Header ── */}
      <div
        className="shrink-0 px-3 pt-3 pb-2"
        style={{ borderBottom: '0.5px solid var(--border-row)' }}
      >
        <div className="flex items-center justify-between mb-2">
          <span
            className="text-[13px] font-semibold"
            style={{ color: 'var(--text-primary)', letterSpacing: '-0.015em' }}
          >
            Activity
          </span>
          <div className="flex items-center gap-1.5">
            {connected ? (
              <span
                className="text-[10px] flex items-center gap-1"
                style={{ color: 'var(--success, #22c55e)' }}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--success, #22c55e)' }}
                />
                Live
              </span>
            ) : (
              <span
                className="text-[10px] flex items-center gap-1"
                style={{ color: 'var(--text-tertiary)' }}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--text-tertiary)' }}
                />
                Offline
              </span>
            )}
            <span
              className="text-[10px] tabular-nums"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {entries.length.toLocaleString()} calls
            </span>
          </div>
        </div>

        {/* Filter chips */}
        <div className="flex gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
          <FilterChip label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
          <FilterChip
            label="Errors"
            active={filter === 'errors'}
            onClick={() => setFilter('errors')}
          />
          {top5.map((tool) => (
            <FilterChip
              key={tool}
              label={tool}
              active={filter === tool}
              onClick={() => setFilter(filter === tool ? 'all' : tool)}
            />
          ))}
        </div>
      </div>

      {/* ── Stats panel (collapsible) ── */}
      {/* Stats summary bar — always visible when stats are loaded */}
      {stats !== null && (
        <StatsSummaryBar
          stats={stats}
          expanded={statsExpanded}
          onToggle={() => setStatsExpanded((v) => !v)}
        />
      )}
      {/* Expanded stats body — inserted between header and live feed */}
      {stats !== null && statsExpanded && (
        <StatsPanel
          stats={stats}
          onToolClick={handleToolClick}
          onErrorGroupClick={handleErrorGroupClick}
          activeFilter={filter}
        />
      )}

      {/* ── Error banner ── */}
      {error && (
        <div
          className="shrink-0 px-3 py-1.5 text-[11px]"
          style={{
            background: 'rgba(239,68,68,0.08)',
            color: 'var(--red, #ef4444)',
            borderBottom: '0.5px solid var(--border-row)',
          }}
        >
          {error}
        </div>
      )}

      {/* ── Entry list ── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
        style={{ background: 'var(--bg-grouped)', borderRadius: '0 0 10px 10px' }}
      >
        {filtered.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full text-center px-6 py-12"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <div className="text-[13px] mb-1">
              {filter === 'all' ? 'No tool calls yet' : 'No matching entries'}
            </div>
            <div className="text-[11px]">
              {filter === 'all'
                ? 'Run a tool from Claude Code to see activity here.'
                : 'Try a different filter.'}
            </div>
          </div>
        ) : (
          filtered.map((entry) => (
            <EntryRow
              key={`${entry.ts}:${entry.tool}:${entry.session_id}:${entry.params_summary.slice(0, 32)}`}
              entry={entry}
            />
          ))
        )}
      </div>
    </div>
  );
}
