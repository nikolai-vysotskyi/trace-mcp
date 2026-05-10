import { useCallback, useEffect, useRef, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DecisionRow {
  id: number;
  title: string;
  content: string;
  type: string;
  project_root: string;
  service_name: string | null;
  symbol_id: string | null;
  file_path: string | null;
  tags: string | null;
  valid_from: string;
  valid_until: string | null;
  session_id: string | null;
  source: 'manual' | 'mined' | 'auto';
  confidence: number;
  created_at: string;
}

interface DecisionStats {
  total: number;
  active: number;
  by_type: Record<string, number>;
  by_source: Record<string, number>;
}

interface CorpusItem {
  name: string;
  scope: string;
  modulePath?: string;
  featureQuery?: string;
  tokenBudget: number;
  createdAt: string;
  updatedAt: string;
  description?: string;
  symbolCount: number;
  fileCount: number;
  estimatedTokens: number;
  sizeKB: number | null;
}

interface MinedSession {
  session_path: string;
  mined_at: string;
  decisions_found: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = 'http://127.0.0.1:3741';

const DECISION_TYPES = [
  'architecture_decision',
  'tech_choice',
  'bug_root_cause',
  'preference',
  'tradeoff',
  'discovery',
  'convention',
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortPath(p: string): string {
  return p
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^[A-Z]:\\Users\\[^\\]+/, '~');
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function typeBadgeColors(type: string): { bg: string; text: string } {
  const map: Record<string, { bg: string; text: string }> = {
    architecture_decision: { bg: 'rgba(99,102,241,0.15)', text: '#818cf8' },
    tech_choice: { bg: 'rgba(59,130,246,0.15)', text: '#60a5fa' },
    bug_root_cause: { bg: 'rgba(239,68,68,0.15)', text: '#f87171' },
    preference: { bg: 'rgba(16,185,129,0.15)', text: '#34d399' },
    tradeoff: { bg: 'rgba(234,179,8,0.15)', text: '#fbbf24' },
    discovery: { bg: 'rgba(236,72,153,0.15)', text: '#f472b6' },
    convention: { bg: 'rgba(107,114,128,0.15)', text: '#9ca3af' },
  };
  return map[type] ?? { bg: 'rgba(107,114,128,0.15)', text: '#9ca3af' };
}

function TypeBadge({ type }: { type: string }) {
  const { bg, text } = typeBadgeColors(type);
  const label = type.replace(/_/g, ' ');
  return (
    <span
      className="text-[9px] px-1.5 py-0.5 rounded font-medium uppercase shrink-0"
      style={{ background: bg, color: text, letterSpacing: '0.03em' }}
    >
      {label}
    </span>
  );
}

function SourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    manual: '#34d399',
    mined: '#60a5fa',
    auto: '#fbbf24',
  };
  return (
    <span
      className="text-[9px] px-1.5 py-0.5 rounded font-medium uppercase shrink-0"
      style={{
        background: 'rgba(255,255,255,0.06)',
        color: colors[source] ?? '#9ca3af',
        border: `0.5px solid ${colors[source] ?? '#9ca3af'}40`,
      }}
    >
      {source}
    </span>
  );
}

// ── Sub-views ─────────────────────────────────────────────────────────────────

function StatsPanel({ stats }: { stats: DecisionStats }) {
  const typeEntries = Object.entries(stats.by_type).sort((a, b) => b[1] - a[1]);
  return (
    <div
      className="px-3 py-2.5 space-y-2"
      style={{
        background: 'var(--bg-grouped)',
        borderRadius: 10,
        boxShadow: 'var(--shadow-grouped)',
      }}
    >
      {/* Totals row */}
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center">
          <span
            className="text-[20px] font-semibold tabular-nums leading-none"
            style={{ color: 'var(--text-primary)' }}
          >
            {stats.total}
          </span>
          <span className="text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            total
          </span>
        </div>
        <div className="flex flex-col items-center">
          <span
            className="text-[20px] font-semibold tabular-nums leading-none"
            style={{ color: 'var(--green, #22c55e)' }}
          >
            {stats.active}
          </span>
          <span className="text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            active
          </span>
        </div>
        <div className="flex flex-col items-center">
          <span
            className="text-[20px] font-semibold tabular-nums leading-none"
            style={{ color: 'var(--text-secondary)' }}
          >
            {stats.total - stats.active}
          </span>
          <span className="text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            expired
          </span>
        </div>
      </div>

      {/* Type breakdown */}
      {typeEntries.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1" style={{ borderTop: '0.5px solid var(--border-row)' }}>
          {typeEntries.map(([type, count]) => {
            const { bg, text } = typeBadgeColors(type);
            return (
              <span
                key={type}
                className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                style={{ background: bg, color: text }}
              >
                {type.replace(/_/g, ' ')} · {count}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DecisionCard({
  decision,
  expanded,
  onToggle,
}: {
  decision: DecisionRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tags = parseTags(decision.tags);
  const isActive = decision.valid_until === null;

  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full text-left"
      style={{ cursor: 'pointer' }}
    >
      {/* Collapsed header */}
      <div className="px-3 py-2.5 flex items-start gap-2">
        {/* Active indicator dot */}
        <div
          className="mt-1 shrink-0 w-1.5 h-1.5 rounded-full"
          style={{ background: isActive ? 'var(--green, #22c55e)' : 'var(--text-tertiary)' }}
          title={isActive ? 'Active' : 'Expired'}
        />

        <div className="flex-1 min-w-0 space-y-1">
          {/* Title + badges row */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="text-[13px] font-medium leading-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              {decision.title}
            </span>
            <TypeBadge type={decision.type} />
            <SourceBadge source={decision.source} />
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-2 flex-wrap">
            {decision.file_path && (
              <span
                className="text-[10px] truncate max-w-[180px]"
                style={{ color: 'var(--text-tertiary)', fontFamily: 'SF Mono, Menlo, monospace' }}
                title={decision.file_path}
              >
                {decision.file_path}
              </span>
            )}
            <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {formatDate(decision.created_at)}
            </span>
          </div>
        </div>

        {/* Chevron */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 mt-1 transition-transform"
          style={{
            color: 'var(--text-tertiary)',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div
          className="px-3 pb-3 space-y-2"
          style={{ borderTop: '0.5px solid var(--border-row)' }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {/* Content */}
          <div
            className="text-[12px] leading-relaxed whitespace-pre-wrap mt-2"
            style={{ color: 'var(--text-secondary)' }}
          >
            {decision.content}
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1" style={{ borderTop: '0.5px solid var(--border-row)' }}>
            {decision.symbol_id && (
              <>
                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                  Symbol
                </span>
                <span
                  className="text-[10px] truncate"
                  style={{ color: 'var(--text-secondary)', fontFamily: 'SF Mono, Menlo, monospace' }}
                  title={decision.symbol_id}
                >
                  {decision.symbol_id}
                </span>
              </>
            )}
            {decision.file_path && (
              <>
                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                  File
                </span>
                <span
                  className="text-[10px] truncate"
                  style={{ color: 'var(--text-secondary)', fontFamily: 'SF Mono, Menlo, monospace' }}
                  title={decision.file_path}
                >
                  {decision.file_path}
                </span>
              </>
            )}
            <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              Valid from
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
              {formatDate(decision.valid_from)}
            </span>
            {decision.valid_until && (
              <>
                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                  Expired
                </span>
                <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                  {formatDate(decision.valid_until)}
                </span>
              </>
            )}
            {decision.confidence < 1 && (
              <>
                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                  Confidence
                </span>
                <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {Math.round(decision.confidence * 100)}%
                </span>
              </>
            )}
          </div>

          {/* Tags */}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'var(--bg-inset)',
                    color: 'var(--text-secondary)',
                    border: '0.5px solid var(--border-row)',
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </button>
  );
}

function DecisionsView({ root }: { root: string }) {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [stats, setStats] = useState<DecisionStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [activeType, setActiveType] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchDecisions = useCallback(
    async (search: string, type: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ project: root, limit: '50', offset: '0' });
        if (search) params.set('q', search);
        if (type) params.set('type', type);
        const res = await fetch(`${BASE}/api/projects/decisions?${params}`);
        if (res.ok) {
          const data = (await res.json()) as { decisions: DecisionRow[]; total: number };
          setDecisions(data.decisions);
          setTotal(data.total);
        }
      } catch {
        /* optional */
      }
      setLoading(false);
    },
    [root],
  );

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(
        `${BASE}/api/projects/decisions/stats?${new URLSearchParams({ project: root })}`,
      );
      if (res.ok) setStats((await res.json()) as DecisionStats);
    } catch {
      /* optional */
    }
  }, [root]);

  useEffect(() => {
    fetchStats();
    fetchDecisions('', '');
  }, [fetchStats, fetchDecisions]);

  const handleSearch = (value: string) => {
    setQ(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      fetchDecisions(value, activeType);
    }, 300);
  };

  const handleTypeFilter = (type: string) => {
    const next = activeType === type ? '' : type;
    setActiveType(next);
    fetchDecisions(q, next);
  };

  return (
    <div className="space-y-3">
      {/* Stats panel */}
      {stats && <StatsPanel stats={stats} />}

      {/* Search input */}
      <div className="relative">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={q}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search decisions…"
          className="w-full text-[12px] outline-none pl-7 pr-3"
          style={{
            background: 'var(--bg-grouped)',
            border: '0.5px solid var(--border-row)',
            borderRadius: 8,
            height: 30,
            color: 'var(--text-primary)',
            boxShadow: 'var(--shadow-grouped)',
          }}
        />
      </div>

      {/* Type filter chips */}
      <div className="flex flex-wrap gap-1">
        {DECISION_TYPES.map((t) => {
          const active = activeType === t;
          const { bg, text } = typeBadgeColors(t);
          return (
            <button
              type="button"
              key={t}
              onClick={() => handleTypeFilter(t)}
              className="text-[10px] px-2 py-0.5 rounded font-medium uppercase transition-all"
              style={{
                background: active ? bg : 'var(--bg-inset)',
                color: active ? text : 'var(--text-tertiary)',
                border: active ? `0.5px solid ${text}40` : '0.5px solid transparent',
                cursor: 'pointer',
              }}
            >
              {t.replace(/_/g, ' ')}
            </button>
          );
        })}
      </div>

      {/* Results */}
      <div>
        <div className="flex items-baseline justify-between mb-1.5 px-3">
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}>
            Decisions
          </span>
          {!loading && (
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
              {total} found
            </span>
          )}
        </div>

        <div
          style={{
            background: 'var(--bg-grouped)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-grouped)',
            overflow: 'hidden',
          }}
        >
          {loading && (
            <div className="px-3 py-4 text-[12px] text-center" style={{ color: 'var(--text-tertiary)' }}>
              Loading…
            </div>
          )}

          {!loading && decisions.length === 0 && (
            <div className="px-3 py-4 text-[12px] text-center" style={{ color: 'var(--text-tertiary)' }}>
              {q || activeType ? 'No matching decisions.' : 'No decisions stored yet.'}
            </div>
          )}

          {!loading &&
            decisions.map((d, i) => {
              const isLast = i === decisions.length - 1;
              return (
                <div
                  key={d.id}
                  style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--border-row)' }}
                >
                  <DecisionCard
                    decision={d}
                    expanded={expandedId === d.id}
                    onToggle={() => setExpandedId(expandedId === d.id ? null : d.id)}
                  />
                </div>
              );
            })}

          {!loading && total > decisions.length && (
            <div
              className="px-3 py-1.5 text-[10px] text-center"
              style={{ color: 'var(--text-tertiary)', borderTop: '0.5px solid var(--border-row)' }}
            >
              Showing {decisions.length} of {total} — refine your search to narrow results
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CorporaView({ root }: { root: string }) {
  const [corpora, setCorpora] = useState<CorpusItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`${BASE}/api/projects/corpora?${new URLSearchParams({ project: root })}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { corpora: CorpusItem[] } | null) => {
        if (data) setCorpora(data.corpora);
      })
      .catch(() => {/* optional */})
      .finally(() => setLoading(false));
  }, [root]);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between mb-1.5 px-3">
        <span className="text-[11px]" style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}>
          Corpora
        </span>
        {!loading && (
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {corpora.length}
          </span>
        )}
      </div>

      <div
        style={{
          background: 'var(--bg-grouped)',
          borderRadius: 10,
          boxShadow: 'var(--shadow-grouped)',
          overflow: 'hidden',
        }}
      >
        {loading && (
          <div className="px-3 py-4 text-[12px] text-center" style={{ color: 'var(--text-tertiary)' }}>
            Loading…
          </div>
        )}

        {!loading && corpora.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-center" style={{ color: 'var(--text-tertiary)' }}>
            No corpora for this project.
          </div>
        )}

        {!loading &&
          corpora.map((c, i) => {
            const isLast = i === corpora.length - 1;
            return (
              <div
                key={c.name}
                className="px-3 py-2.5"
                style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--border-row)' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="text-[13px] font-medium"
                        style={{ color: 'var(--text-primary)', fontFamily: 'SF Mono, Menlo, monospace' }}
                      >
                        {c.name}
                      </span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase"
                        style={{ background: 'var(--bg-inset)', color: 'var(--text-secondary)' }}
                      >
                        {c.scope}
                      </span>
                    </div>

                    {c.description && (
                      <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        {c.description}
                      </div>
                    )}

                    {(c.featureQuery || c.modulePath) && (
                      <div
                        className="text-[10px] truncate"
                        style={{ color: 'var(--text-tertiary)', fontFamily: 'SF Mono, Menlo, monospace' }}
                        title={c.featureQuery ?? c.modulePath}
                      >
                        {c.featureQuery ?? c.modulePath}
                      </div>
                    )}

                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                        {c.symbolCount} symbols · {c.fileCount} files
                      </span>
                      <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                        ~{(c.tokenBudget / 1000).toFixed(0)}K budget
                      </span>
                      {c.sizeKB !== null && (
                        <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                          {c.sizeKB} KB
                        </span>
                      )}
                      <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                        {formatDate(c.createdAt)}
                      </span>
                    </div>
                  </div>

                  {/* Action buttons (stubbed for MVP) */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled
                      className="text-[11px] font-medium px-2 py-1 rounded opacity-40"
                      style={{
                        background: 'var(--accent)',
                        color: '#fff',
                        cursor: 'not-allowed',
                      }}
                      title="Query corpus (coming soon)"
                    >
                      Query
                    </button>
                    <button
                      type="button"
                      disabled
                      className="text-[11px] font-medium px-2 py-1 rounded opacity-40"
                      style={{
                        background: 'var(--bg-inset)',
                        color: 'var(--text-secondary)',
                        border: '0.5px solid var(--border-row)',
                        cursor: 'not-allowed',
                      }}
                      title="Delete corpus (coming soon)"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

function SessionsView({ root }: { root: string }) {
  const [sessions, setSessions] = useState<MinedSession[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(
      `${BASE}/api/projects/sessions?${new URLSearchParams({ project: root, limit: '100' })}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { sessions: MinedSession[] } | null) => {
        if (data) setSessions(data.sessions);
      })
      .catch(() => {/* optional */})
      .finally(() => setLoading(false));
  }, [root]);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between mb-1.5 px-3">
        <span
          className="text-[11px]"
          style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}
        >
          Mined sessions
        </span>
        {!loading && (
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {sessions.length}
          </span>
        )}
      </div>

      <div
        style={{
          background: 'var(--bg-grouped)',
          borderRadius: 10,
          boxShadow: 'var(--shadow-grouped)',
          overflow: 'hidden',
        }}
      >
        {loading && (
          <div className="px-3 py-4 text-[12px] text-center" style={{ color: 'var(--text-tertiary)' }}>
            Loading…
          </div>
        )}

        {!loading && sessions.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-center" style={{ color: 'var(--text-tertiary)' }}>
            No mined sessions yet.
          </div>
        )}

        {!loading &&
          sessions.map((s, i) => {
            const isLast = i === sessions.length - 1;
            return (
              <div
                key={s.session_path}
                className="px-3 py-2.5"
                style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--border-row)' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div
                      className="text-[11px] truncate"
                      style={{
                        color: 'var(--text-primary)',
                        fontFamily: 'SF Mono, Menlo, monospace',
                      }}
                      title={s.session_path}
                    >
                      {shortPath(s.session_path)}
                    </div>
                    <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                      {formatDate(s.mined_at)}
                    </div>
                  </div>
                  <span
                    className="shrink-0 text-[11px] tabular-nums font-medium"
                    style={{
                      color:
                        s.decisions_found > 0
                          ? 'var(--green, #22c55e)'
                          : 'var(--text-tertiary)',
                    }}
                    title={`${s.decisions_found} decision${s.decisions_found === 1 ? '' : 's'} found`}
                  >
                    {s.decisions_found} found
                  </span>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

type SubTab = 'decisions' | 'corpora' | 'sessions';

export function MemoryExplorer({ root }: { root: string }) {
  const [activeTab, setActiveTab] = useState<SubTab>('decisions');

  const tabs: { key: SubTab; label: string }[] = [
    { key: 'decisions', label: 'Decisions' },
    { key: 'corpora', label: 'Corpora' },
    { key: 'sessions', label: 'Sessions' },
  ];

  return (
    <div className="space-y-4 pb-4">
      {/* Tab bar */}
      <div className="flex gap-1">
        {tabs.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              type="button"
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="text-[12px] px-3 py-1.5 rounded-md font-medium transition-all"
              style={{
                background: active ? 'var(--accent)' : 'var(--bg-inset)',
                color: active ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontWeight: active ? 600 : 400,
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      {activeTab === 'decisions' && <DecisionsView root={root} />}
      {activeTab === 'corpora' && <CorporaView root={root} />}
      {activeTab === 'sessions' && <SessionsView root={root} />}
    </div>
  );
}
