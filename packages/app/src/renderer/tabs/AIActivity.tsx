import { useCallback, useEffect, useState } from 'react';

/* ═══ AI Activity panel ════════════════════════════════════════════ */

interface AIEntry {
  id: number;
  type: string;
  provider: string;
  model: string;
  url: string;
  status: 'ok' | 'error' | 'pending';
  duration_ms: number;
  input_size: number;
  output_size: number;
  error?: string;
  timestamp: string;
}

interface AIStats {
  total_requests: number;
  total_errors: number;
  total_duration_ms: number;
  by_type: Record<string, { count: number; errors: number; total_ms: number }>;
}

/* ── Helpers ── */

const TYPE_META: Record<string, { label: string; icon: string; color: string }> = {
  embed: { label: 'Embed', icon: 'E', color: '#5856d6' },
  embed_batch: { label: 'Batch', icon: 'B', color: '#af52de' },
  generate: { label: 'LLM', icon: 'G', color: '#007aff' },
  generate_stream: { label: 'Stream', icon: 'S', color: '#32ade6' },
  rerank: { label: 'Rerank', icon: 'R', color: '#ff9500' },
};
const typeMeta = (t: string) =>
  TYPE_META[t] ?? { label: t, icon: '?', color: 'var(--text-tertiary)' };
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
};
const fmtAgo = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

/* ── Stat card (glass pill) ── */
function StatPill({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        padding: '8px 10px',
        background: 'var(--fill-control)',
        borderRadius: 10,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '0.5px solid var(--border)',
        boxShadow: 'var(--shadow-control)',
      }}
    >
      <div
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--text-tertiary)', marginBottom: 2 }}
      >
        {label}
      </div>
      <div
        className="text-[15px] font-bold tabular-nums"
        style={{ color: color ?? 'var(--text-primary)', lineHeight: 1.1 }}
      >
        {value}
      </div>
      {sub && (
        <div
          className="text-[10px] tabular-nums"
          style={{ color: 'var(--text-tertiary)', marginTop: 1 }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

/* ── Type breakdown mini-bar ── */
function TypeBar({ stats }: { stats: AIStats }) {
  const types = Object.entries(stats.by_type);
  const total = stats.total_requests || 1;
  return (
    <div
      style={{
        display: 'flex',
        gap: 1,
        height: 4,
        borderRadius: 2,
        overflow: 'hidden',
        background: 'var(--bg-inset)',
      }}
    >
      {types.map(([type, s]) => (
        <div
          key={type}
          title={`${typeMeta(type).label}: ${s.count}`}
          style={{
            width: `${(s.count / total) * 100}%`,
            background: typeMeta(type).color,
            minWidth: 2,
            borderRadius: 1,
            transition: 'width .3s ease',
          }}
        />
      ))}
    </div>
  );
}

/* ── Single request row ── */
function RequestRow({ entry, isLast }: { entry: AIEntry; isLast: boolean }) {
  const [showDetail, setShowDetail] = useState(false);
  const meta = typeMeta(entry.type);
  const isPending = entry.status === 'pending';

  return (
    <div style={{ borderBottom: isLast ? 'none' : '1px solid var(--border-row)' }}>
      <button
        type="button"
        onClick={() => setShowDetail(!showDetail)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '7px 12px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background .1s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg-active)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'none';
        }}
      >
        {/* Status indicator */}
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            flexShrink: 0,
            background:
              entry.status === 'ok'
                ? 'var(--success)'
                : entry.status === 'error'
                  ? 'var(--destructive)'
                  : 'var(--warning)',
            boxShadow: isPending
              ? '0 0 6px var(--warning)'
              : entry.status === 'ok'
                ? '0 0 4px var(--success)'
                : undefined,
            animation: isPending ? 'pulse 1.5s ease-in-out infinite' : undefined,
          }}
        />

        {/* Type badge */}
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.03em',
            padding: '1px 5px',
            borderRadius: 4,
            background: `${meta.color}1a`,
            color: meta.color,
            flexShrink: 0,
            fontFamily: 'SF Mono, Menlo, monospace',
          }}
        >
          {meta.label.toUpperCase()}
        </span>

        {/* Provider + model */}
        <span
          className="flex-1 min-w-0 truncate"
          style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 500 }}
        >
          {entry.provider}
          <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}> {entry.model}</span>
        </span>

        {/* Duration or pending */}
        <span
          className="tabular-nums"
          style={{
            fontSize: 11,
            flexShrink: 0,
            fontFamily: 'SF Mono, Menlo, monospace',
            color: isPending
              ? 'var(--warning)'
              : entry.duration_ms > 5000
                ? 'var(--destructive)'
                : entry.duration_ms > 1000
                  ? 'var(--warning)'
                  : 'var(--text-secondary)',
          }}
        >
          {isPending ? '...' : fmtMs(entry.duration_ms)}
        </span>

        {/* Time ago */}
        <span
          className="tabular-nums"
          style={{
            fontSize: 10,
            color: 'var(--text-tertiary)',
            flexShrink: 0,
            width: 52,
            textAlign: 'right',
          }}
        >
          {fmtAgo(entry.timestamp)}
        </span>
      </button>

      {/* Expanded detail */}
      {showDetail && (
        <div
          style={{
            padding: '4px 12px 8px 32px',
            fontSize: 11,
            fontFamily: 'SF Mono, Menlo, monospace',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '2px 10px',
            color: 'var(--text-secondary)',
          }}
        >
          <span style={{ color: 'var(--text-tertiary)' }}>Time</span>
          <span>{fmtTime(entry.timestamp)}</span>
          <span style={{ color: 'var(--text-tertiary)' }}>URL</span>
          <span className="truncate">{entry.url}</span>
          <span style={{ color: 'var(--text-tertiary)' }}>Input</span>
          <span>
            {entry.type.startsWith('embed')
              ? `${entry.input_size} items`
              : `${entry.input_size.toLocaleString()} chars`}
          </span>
          <span style={{ color: 'var(--text-tertiary)' }}>Output</span>
          <span>
            {entry.type.startsWith('embed')
              ? `${entry.output_size} vectors`
              : `${entry.output_size.toLocaleString()} chars`}
          </span>
          {entry.error && (
            <>
              <span style={{ color: 'var(--destructive)' }}>Error</span>
              <span
                style={{
                  color: 'var(--destructive)',
                  wordBreak: 'break-word',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {entry.error}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main component ── */
const FILTER_STORAGE_KEY = 'aiactivity.filter';

function readPersistedFilter(): string | null {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (raw === null) return null;
    if (raw === '') return null;
    return raw;
  } catch {
    return null;
  }
}

export function AIActivity() {
  const [entries, setEntries] = useState<AIEntry[]>([]);
  const [stats, setStats] = useState<AIStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(readPersistedFilter);
  const [query, setQuery] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, filter ?? '');
    } catch {
      /* storage disabled or quota exceeded — ignore */
    }
  }, [filter]);

  const fetchActivity = useCallback(async () => {
    try {
      const res = await fetch('http://127.0.0.1:3741/api/ai/activity?limit=100');
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setEntries(data.entries ?? []);
      setStats(data.stats ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error)?.message ?? 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchActivity();
    const interval = setInterval(fetchActivity, 2500);
    return () => clearInterval(interval);
  }, [fetchActivity]);

  const hasPending = entries.some((e) => e.status === 'pending');
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = entries.filter((e) => {
    if (filter && e.type !== filter) return false;
    if (!normalizedQuery) return true;
    const haystack = [e.url, e.provider, e.model, e.error ?? '', e.type]
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
  const errorRate =
    stats && stats.total_requests > 0
      ? Math.round((stats.total_errors / stats.total_requests) * 100)
      : 0;
  const avgMs =
    stats && stats.total_requests > 0
      ? Math.round(stats.total_duration_ms / stats.total_requests)
      : 0;

  return (
    <div className="space-y-3" style={{ marginTop: 20 }}>
      {/* ── Section header ── */}
      <div className="flex items-center gap-2">
        <div
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Activity Monitor
        </div>
        {hasPending && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: 'var(--success)',
              boxShadow: '0 0 6px var(--success)',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}
          />
        )}
        {error && !loading && entries.length === 0 && (
          <span className="text-[10px]" style={{ color: 'var(--destructive)' }}>
            Offline
          </span>
        )}
        <div style={{ marginLeft: 'auto', position: 'relative', width: 180 }}>
          <input
            type="text"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder="Search url, provider, model…"
            style={{
              width: '100%',
              background: 'var(--fill-control)',
              border: '0.5px solid var(--border)',
              borderRadius: 6,
              fontSize: 11,
              padding: query ? '4px 22px 4px 8px' : '4px 8px',
              color: 'var(--text-primary)',
              outline: 'none',
            }}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              style={{
                position: 'absolute',
                right: 4,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                fontSize: 12,
                lineHeight: 1,
                padding: '2px 4px',
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* ── Stats pills ── */}
      {stats && stats.total_requests > 0 && (
        <>
          <div className="flex gap-2">
            <StatPill
              label="Requests"
              value={stats.total_requests.toLocaleString()}
              sub={`${Object.keys(stats.by_type).length} type${Object.keys(stats.by_type).length !== 1 ? 's' : ''}`}
            />
            <StatPill
              label="Avg latency"
              value={fmtMs(avgMs)}
              sub={`total ${fmtMs(stats.total_duration_ms)}`}
              color={
                avgMs > 3000 ? 'var(--destructive)' : avgMs > 1000 ? 'var(--warning)' : undefined
              }
            />
            <StatPill
              label="Errors"
              value={stats.total_errors.toString()}
              sub={errorRate > 0 ? `${errorRate}% rate` : 'none'}
              color={stats.total_errors > 0 ? 'var(--destructive)' : 'var(--success)'}
            />
          </div>
          <TypeBar stats={stats} />
        </>
      )}

      {/* ── Filter chips ── */}
      {stats && Object.keys(stats.by_type).length > 1 && (
        <div className="flex gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => setFilter(null)}
            className="text-[10px] font-medium px-2.5 py-1 rounded-full transition-all"
            style={{
              background: !filter ? 'var(--accent)' : 'var(--fill-control)',
              color: !filter ? '#fff' : 'var(--text-secondary)',
              border: `0.5px solid ${!filter ? 'var(--accent)' : 'var(--border)'}`,
              cursor: 'pointer',
            }}
          >
            All
          </button>
          {Object.entries(stats.by_type).map(([type, s]) => {
            const meta = typeMeta(type);
            const active = filter === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => setFilter(active ? null : type)}
                className="text-[10px] font-medium px-2.5 py-1 rounded-full transition-all flex items-center gap-1"
                style={{
                  background: active ? `${meta.color}22` : 'var(--fill-control)',
                  color: active ? meta.color : 'var(--text-secondary)',
                  border: `0.5px solid ${active ? `${meta.color}44` : 'var(--border)'}`,
                  cursor: 'pointer',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                }}
              >
                {meta.label}
                <span className="tabular-nums" style={{ opacity: 0.7 }}>
                  {s.count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Request list ── */}
      <div
        style={{
          background: 'var(--bg-grouped)',
          borderRadius: 10,
          boxShadow: 'var(--shadow-grouped)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            maxHeight: 320,
            overflowY: 'auto',
            scrollbarWidth: 'thin',
            scrollbarColor: 'var(--text-tertiary) transparent',
          }}
        >
          {loading && entries.length === 0 && (
            <div className="text-center py-6 text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Connecting to daemon...
            </div>
          )}
          {!loading && entries.length === 0 && !error && (
            <div className="text-center py-8 px-4">
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                No AI requests yet
              </div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                Requests appear here during indexing and semantic search
              </div>
            </div>
          )}
          {error && entries.length === 0 && (
            <div className="text-center py-6 px-4">
              <div className="text-[11px] font-medium" style={{ color: 'var(--destructive)' }}>
                Cannot reach daemon
              </div>
              <div className="text-[10px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                {error}
              </div>
            </div>
          )}
          {filtered.map((e, i) => (
            <RequestRow key={e.id} entry={e} isLast={i === filtered.length - 1} />
          ))}
          {(filter || normalizedQuery) && filtered.length === 0 && entries.length > 0 && (
            <div className="text-center py-4 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {normalizedQuery
                ? `No requests match "${query}"`
                : `No ${typeMeta(filter!).label.toLowerCase()} requests`}
            </div>
          )}
        </div>
      </div>

      {/* Pulse animation */}
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
}
