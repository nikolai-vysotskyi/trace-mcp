/**
 * AI Activity — embed / LLM / rerank requests the daemon has made.
 *
 * Rebuilt on the macOS 26 layer (TRA-294). What it replaces, measured on the
 * running surface: three glass "stat pills" (`backdrop-filter: blur(12px)` on
 * what is content, not chrome) with 10px ALL-CAPS labels; a `MATCH`-style
 * type badge rendered `meta.label.toUpperCase()` at 9px/700; a status dot that
 * carried ok / error / pending in colour alone; a 320px-tall scroll box and a
 * 20px top margin inside a pane that is already full height.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../lattice/icons';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ListRow,
  SearchField,
  SectionError,
  StatusDot,
  Toolbar,
  ToolbarDivider,
  type Tone,
} from '../lattice/ui';

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

/* Tones come from the shared status palette, so every series in this surface
   is contrast-checked once, in tokens.css, instead of six times in hex here. */
const TYPE_META: Record<string, { label: string; tone: Tone }> = {
  embed: { label: 'Embed', tone: 'purple' },
  embed_batch: { label: 'Batch', tone: 'purple' },
  generate: { label: 'Generate', tone: 'blue' },
  generate_stream: { label: 'Stream', tone: 'accent' },
  rerank: { label: 'Rerank', tone: 'orange' },
};
const typeMeta = (t: string): { label: string; tone: Tone } =>
  TYPE_META[t] ?? { label: t.replace(/_/g, ' '), tone: 'neutral' };

const TYPE_VAR: Record<Tone, string> = {
  /* A meter segment is decoration, not text, so the neutral series takes the
     tertiary grey. At --label-secondary it out-weighed the purple/blue/red
     series beside it and read as a disabled bar (TRA-294). */
  neutral: 'var(--label-tertiary)',
  accent: 'var(--accent)',
  green: 'var(--status-green)',
  orange: 'var(--status-orange)',
  red: 'var(--status-red)',
  blue: 'var(--status-blue)',
  purple: 'var(--status-purple)',
};

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
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

/** ok / error / pending, said in a word as well as a tone. */
const STATUS_META: Record<AIEntry['status'], { tone: Tone; label: string; icon?: string }> = {
  ok: { tone: 'green', label: 'OK' },
  error: { tone: 'red', label: 'Error', icon: 'warning' },
  pending: { tone: 'orange', label: 'Running', icon: 'schedule' },
};

/* ── Metric card — content anatomy: label → value → footnote. No glass. ── */
function MetricCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  color?: string;
}) {
  return (
    <Card className="flex-1 min-w-0">
      <div className="px-3 py-2.5 flex flex-col gap-1">
        <div className="text-[11px] leading-[13px]" style={{ color: 'var(--label-secondary)' }}>
          {label}
        </div>
        <div
          className="text-[26px] leading-8 font-semibold tabular-nums"
          style={{ color: color ?? 'var(--label)', letterSpacing: '-0.01em' }}
        >
          {value}
        </div>
        {sub != null && (
          <div
            className="text-[11px] leading-[13px] tabular-nums"
            style={{ color: 'var(--label-secondary)' }}
          >
            {sub}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Share-of-requests bar plus its legend — and the legend IS the filter, so
    the four request types are named once instead of twice (a legend above the
    list and a chip row below it, saying the same thing). */
function TypeBar({
  stats,
  filter,
  onFilter,
}: {
  stats: AIStats;
  filter: string | null;
  onFilter: (next: string | null) => void;
}) {
  const types = Object.entries(stats.by_type);
  const total = stats.total_requests || 1;
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex overflow-hidden"
        style={{ gap: 1, height: 6, borderRadius: 3, background: 'var(--fill-quaternary)' }}
      >
        {types.map(([type, s]) => (
          <div
            key={type}
            title={`${typeMeta(type).label}: ${s.count}`}
            style={{
              width: `${(s.count / total) * 100}%`,
              background: TYPE_VAR[typeMeta(type).tone],
              minWidth: 2,
              borderRadius: 2,
              opacity: filter === null || filter === type ? 1 : 0.3,
              transition:
                'width var(--dur-large) var(--ease-out), opacity var(--dur-micro) var(--ease-out)',
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={`lx-chip single${filter === null ? ' is-on' : ''}`}
          aria-pressed={filter === null}
          onClick={() => onFilter(null)}
        >
          All {stats.total_requests.toLocaleString()}
        </button>
        {types.map(([type, s]) => {
          const meta = typeMeta(type);
          const active = filter === type;
          return (
            <button
              key={type}
              type="button"
              className={`lx-chip single${active ? ' is-on' : ''}`}
              aria-pressed={active}
              onClick={() => onFilter(active ? null : type)}
              title={`Show only ${meta.label.toLowerCase()} requests`}
            >
              <StatusDot tone={meta.tone} size={6} />
              {meta.label}
              <span className="tabular-nums">{s.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Single request row ── */
function RequestRow({ entry, isLast }: { entry: AIEntry; isLast: boolean }) {
  const [showDetail, setShowDetail] = useState(false);
  const meta = typeMeta(entry.type);
  const status = STATUS_META[entry.status];
  const isPending = entry.status === 'pending';
  const slow = entry.duration_ms > 5000;

  return (
    <div style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--separator)' }}>
      <button
        type="button"
        onClick={() => setShowDetail(!showDetail)}
        aria-expanded={showDetail}
        className="flex items-center gap-2 w-full text-left px-3"
        style={{
          minHeight: 36,
          padding: '7px 12px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          transition: 'background var(--dur-micro) var(--ease-out)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--fill-quaternary)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'none';
        }}
      >
        <StatusDot
          tone={status.tone}
          pulse={isPending}
          title={status.label}
          className="shrink-0"
        />
        <Badge tone={meta.tone}>{meta.label}</Badge>

        <span
          className="flex-1 min-w-0 truncate text-[13px] leading-4"
          style={{ color: 'var(--label)', fontWeight: 500 }}
        >
          {entry.provider}
          <span style={{ color: 'var(--label-secondary)', fontWeight: 400 }}> {entry.model}</span>
        </span>

        {entry.status === 'error' && (
          <Badge tone="red" icon="warning">
            Error
          </Badge>
        )}

        <span
          className="tabular-nums shrink-0 text-[11px] leading-[13px]"
          style={{
            fontFamily: 'var(--font-mono)',
            color: slow ? 'var(--status-orange)' : 'var(--label-secondary)',
          }}
          title={slow ? 'Over 5 seconds' : undefined}
        >
          {isPending ? 'running…' : fmtMs(entry.duration_ms)}
        </span>

        <span
          className="tabular-nums shrink-0 text-[11px] leading-[13px] text-right"
          style={{ color: 'var(--label-secondary)', width: 56 }}
        >
          {fmtAgo(entry.timestamp)}
        </span>
      </button>

      {showDetail && (
        <div
          style={{
            padding: '4px 12px 10px 32px',
            fontSize: 12,
            lineHeight: '15px',
            fontFamily: 'var(--font-mono)',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '3px 12px',
            color: 'var(--label)',
          }}
        >
          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>Time</span>
          <span>{fmtTime(entry.timestamp)}</span>
          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>URL</span>
          <span className="truncate">{entry.url}</span>
          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>
            Input
          </span>
          <span>
            {entry.type.startsWith('embed')
              ? `${entry.input_size.toLocaleString()} items`
              : `${entry.input_size.toLocaleString()} chars`}
          </span>
          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>
            Output
          </span>
          <span>
            {entry.type.startsWith('embed')
              ? `${entry.output_size.toLocaleString()} vectors`
              : `${entry.output_size.toLocaleString()} chars`}
          </span>
          {entry.error && (
            <>
              <span style={{ color: 'var(--status-red)', fontFamily: 'var(--font-ui)' }}>Error</span>
              <span
                style={{
                  color: 'var(--status-red)',
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

export function AIActivity({ subTab }: { subTab?: ReactNode }) {
  const [entries, setEntries] = useState<AIEntry[]>([]);
  const [stats, setStats] = useState<AIStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(readPersistedFilter);
  const [query, setQuery] = useState('');
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, filter ?? '');
    } catch {
      /* storage disabled or quota exceeded — ignore */
    }
  }, [filter]);

  const fetchActivity = useCallback(async () => {
    try {
      const res = await fetch('http://127.0.0.1:3741/api/ai/activity?limit=100'); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- talks to the app's own local daemon (127.0.0.1), not a remote endpoint.
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

  const feedTone: Tone = error ? 'red' : hasPending ? 'orange' : 'green';
  const feedLabel = error ? 'Offline' : hasPending ? 'Running' : 'Idle';

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ color: 'var(--label)' }}>
      <Toolbar scrolled={scrolled}>
        {subTab}
        <ToolbarDivider />
        <span
          className="flex items-center gap-1.5 shrink-0 text-[11px] leading-[13px]"
          style={{ color: 'var(--label-secondary)' }}
        >
          <StatusDot tone={feedTone} pulse={hasPending} />
          <span style={{ color: 'var(--label)' }}>{feedLabel}</span>
          <span className="tabular-nums">
            · {entries.length.toLocaleString()} request{entries.length === 1 ? '' : 's'}
          </span>
        </span>

        <span className="flex-1" />

        {filter !== null && (
          <Button
            variant="bordered"
            className="is-on shrink-0"
            icon="close"
            onClick={() => setFilter(null)}
            title="Show every request type"
          >
            {typeMeta(filter).label}
          </Button>
        )}

        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search requests"
          aria-label="Search requests"
        />
      </Toolbar>

      <div
        className="flex-1 min-h-0 overflow-y-auto"
        onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 0)}
      >
        <div className="flex flex-col gap-4 px-4 py-4">
          {stats && stats.total_requests > 0 && (
            <>
              <div className="flex gap-3">
                <MetricCard
                  label="Requests"
                  value={stats.total_requests.toLocaleString()}
                  sub={`${Object.keys(stats.by_type).length} type${Object.keys(stats.by_type).length !== 1 ? 's' : ''}`}
                />
                <MetricCard
                  label="Average latency"
                  value={fmtMs(avgMs)}
                  sub={`${fmtMs(stats.total_duration_ms)} total`}
                  color={
                    avgMs > 3000
                      ? 'var(--status-red)'
                      : avgMs > 1000
                        ? 'var(--status-orange)'
                        : undefined
                  }
                />
                <MetricCard
                  label="Errors"
                  value={stats.total_errors.toLocaleString()}
                  sub={errorRate > 0 ? `${errorRate}% of requests` : 'None so far'}
                  color={stats.total_errors > 0 ? 'var(--status-red)' : undefined}
                />
              </div>
              <TypeBar stats={stats} filter={filter} onFilter={setFilter} />
            </>
          )}

          <Card>
            {loading && entries.length === 0 && (
              <EmptyState compact icon="schedule" title="Connecting to the daemon…" />
            )}
            {error && entries.length === 0 && !loading && (
              <SectionError what="AI request history" onRetry={() => void fetchActivity()} />
            )}
            {!loading && !error && entries.length === 0 && (
              <EmptyState
                compact
                icon="neurology"
                title="No AI requests yet"
                subtitle="Embedding, generation and rerank calls show up here while a project indexes or a semantic search runs."
              />
            )}
            {filtered.map((e, i) => (
              <RequestRow key={e.id} entry={e} isLast={i === filtered.length - 1} />
            ))}
            {(filter !== null || normalizedQuery !== '') &&
              filtered.length === 0 &&
              entries.length > 0 && (
                <EmptyState
                  compact
                  icon="search"
                  title="No matching requests"
                  subtitle={`${entries.length.toLocaleString()} request${entries.length === 1 ? '' : 's'} are hidden by the current search and filter.`}
                  action={
                    <Button
                      icon="close"
                      onClick={() => {
                        setFilter(null);
                        setQuery('');
                      }}
                    >
                      Clear filters and search
                    </Button>
                  }
                />
              )}
          </Card>

        </div>
      </div>
    </div>
  );
}
