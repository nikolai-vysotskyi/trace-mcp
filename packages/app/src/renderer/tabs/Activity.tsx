/**
 * Activity tab — live feed of MCP tool-calls for a project.
 *
 * Data sources:
 *  - Initial history: GET /api/projects/journal?project=<root>&limit=200
 *  - Live updates:    SSE /api/events  (filters events where event.project === root)
 *
 * Behaviour:
 *  - Newest entries on top.
 *  - Auto-scrolls to top on new entry unless user has scrolled down.
 *  - Caps in-memory list to 1000 entries (drops oldest).
 *  - Filter chips: All / Errors only / top-5 tools by frequency.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const BASE = 'http://127.0.0.1:3741';
const MAX_ENTRIES = 1000;

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

// ── Main component ────────────────────────────────────────────────────────

export function Activity({ root }: { root: string }) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the user has scrolled away from the top (newest entries)
  const userScrolledRef = useRef(false);

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
