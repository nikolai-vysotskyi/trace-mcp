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
import { useTranslation } from 'react-i18next';
import { t } from '../i18n';
import { formatDate, formatNumber, relativeTime } from '../i18n/format';
import { daemonFetch } from '../daemon-fetch';
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
const TYPE_META: Record<string, { labelKey: string; tone: Tone }> = {
  embed: { labelKey: 'activity:typeEmbed', tone: 'purple' },
  embed_batch: { labelKey: 'activity:typeBatch', tone: 'purple' },
  generate: { labelKey: 'activity:typeGenerate', tone: 'blue' },
  generate_stream: { labelKey: 'activity:typeStream', tone: 'accent' },
  rerank: { labelKey: 'activity:typeRerank', tone: 'orange' },
};
/* A type the daemon grew since this list was written still gets a readable
   label — its own id with the underscores taken out — rather than a blank. */
const typeMeta = (type: string): { label: string; tone: Tone } => {
  const known = TYPE_META[type];
  return known
    ? { label: t(known.labelKey), tone: known.tone }
    : { label: type.replace(/_/g, ' '), tone: 'neutral' };
};

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

const fmtMs = (ms: number) =>
  ms < 1000
    ? t('activity:ms', { n: formatNumber(Math.round(ms)) })
    : t('activity:seconds', {
        n: formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      });
const fmtTime = (iso: string) => {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  return formatDate(ts, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
/* "2 hr. ago" through Intl. The hand-rolled version this replaces said "2h
   ago", which Russian cannot say without a minus sign (see i18n/format.ts). */
const fmtAgo = (iso: string) => relativeTime(new Date(iso).getTime(), Date.now(), 'short');

/** ok / error / pending, said in a word as well as a tone. */
const STATUS_META: Record<AIEntry['status'], { tone: Tone; labelKey: string; icon?: string }> = {
  ok: { tone: 'green', labelKey: 'activity:statusOk' },
  error: { tone: 'red', labelKey: 'activity:statusError', icon: 'warning' },
  pending: { tone: 'orange', labelKey: 'activity:statusRunning', icon: 'schedule' },
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
  const { t } = useTranslation('activity');
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
            title={t('typeCount', { label: typeMeta(type).label, n: formatNumber(s.count) })}
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
          {t('typeAll', { n: formatNumber(stats.total_requests) })}
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
              title={t('typeFilter', { label: meta.label })}
            >
              <StatusDot tone={meta.tone} size={6} />
              {meta.label}
              <span className="tabular-nums">{formatNumber(s.count)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Single request row ── */
function RequestRow({ entry, isLast }: { entry: AIEntry; isLast: boolean }) {
  const { t } = useTranslation('activity');
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
          title={t(status.labelKey)}
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
            {t('statusError')}
          </Badge>
        )}

        <span
          className="tabular-nums shrink-0 text-[11px] leading-[13px]"
          style={{
            fontFamily: 'var(--font-mono)',
            color: slow ? 'var(--status-orange)' : 'var(--label-secondary)',
          }}
          title={slow ? t('overFiveSeconds') : undefined}
        >
          {isPending ? t('running') : fmtMs(entry.duration_ms)}
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
          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>
            {t('detailTime')}
          </span>
          <span>{fmtTime(entry.timestamp)}</span>
          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>
            {t('detailUrl')}
          </span>
          <span className="truncate">{entry.url}</span>
          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>
            {t('detailInput')}
          </span>
          <span>
            {entry.type.startsWith('embed')
              ? t('items', { n: formatNumber(entry.input_size) })
              : t('chars', { n: formatNumber(entry.input_size) })}
          </span>
          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>
            {t('detailOutput')}
          </span>
          <span>
            {entry.type.startsWith('embed')
              ? t('vectors', { n: formatNumber(entry.output_size) })
              : t('chars', { n: formatNumber(entry.output_size) })}
          </span>
          {entry.error && (
            <>
              <span style={{ color: 'var(--status-red)', fontFamily: 'var(--font-ui)' }}>
                {t('detailError')}
              </span>
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
  const { t } = useTranslation('activity');
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
      const res = await daemonFetch('http://127.0.0.1:3741/api/ai/activity?limit=100'); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- talks to the app's own local daemon (127.0.0.1), not a remote endpoint.
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setEntries(data.entries ?? []);
      setStats(data.stats ?? null);
      setError(null);
    } catch (e) {
      /* A flag, not a message: `error` only decides between the feed's
         "Offline" state and the retry panel — its text is never rendered. */
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
  const feedLabel = error ? t('feedOffline') : hasPending ? t('feedRunning') : t('feedIdle');

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
            {`· ${t('requests', { count: entries.length, n: formatNumber(entries.length) })}`}
          </span>
        </span>

        <span className="flex-1" />

        {filter !== null && (
          <Button
            variant="bordered"
            className="is-on shrink-0"
            icon="close"
            onClick={() => setFilter(null)}
            title={t('showEveryType')}
          >
            {typeMeta(filter).label}
          </Button>
        )}

        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('searchRequests')}
          aria-label={t('searchRequests')}
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
                  label={t('metricRequests')}
                  value={formatNumber(stats.total_requests)}
                  sub={t('metricTypes', {
                    count: Object.keys(stats.by_type).length,
                    n: formatNumber(Object.keys(stats.by_type).length),
                  })}
                />
                <MetricCard
                  label={t('metricLatency')}
                  value={fmtMs(avgMs)}
                  sub={t('metricTotal', { duration: fmtMs(stats.total_duration_ms) })}
                  color={
                    avgMs > 3000
                      ? 'var(--status-red)'
                      : avgMs > 1000
                        ? 'var(--status-orange)'
                        : undefined
                  }
                />
                <MetricCard
                  label={t('metricErrors')}
                  value={formatNumber(stats.total_errors)}
                  sub={
                    errorRate > 0
                      ? t('metricErrorRate', { pct: formatNumber(errorRate) })
                      : t('metricNoErrors')
                  }
                  color={stats.total_errors > 0 ? 'var(--status-red)' : undefined}
                />
              </div>
              <TypeBar stats={stats} filter={filter} onFilter={setFilter} />
            </>
          )}

          <Card>
            {loading && entries.length === 0 && (
              <EmptyState compact icon="schedule" title={t('connecting')} />
            )}
            {error && entries.length === 0 && !loading && (
              <SectionError what={t('errorAiHistory')} onRetry={() => void fetchActivity()} />
            )}
            {!loading && !error && entries.length === 0 && (
              <EmptyState
                compact
                icon="neurology"
                title={t('emptyRequestsTitle')}
                subtitle={t('emptyRequestsBody')}
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
                  title={t('emptyRequestsMatchTitle')}
                  subtitle={t('emptyRequestsMatch', {
                    count: entries.length,
                    n: formatNumber(entries.length),
                  })}
                  action={
                    <Button
                      icon="close"
                      onClick={() => {
                        setFilter(null);
                        setQuery('');
                      }}
                    >
                      {t('clearFiltersAndSearch')}
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
