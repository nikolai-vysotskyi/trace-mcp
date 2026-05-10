import { useCallback, useEffect, useMemo, useState } from 'react';
import { EMPTY_FILTER_VALUE, FilterBar, type FilterValue, matchesFilter } from '../components/FilterBar';

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
  git_branch: string | null;
  review_status: 'pending' | 'approved' | 'rejected' | null;
  created_at: string;
  updated_at: number | null;
}

interface DecisionStats {
  total: number;
  active: number;
  by_type: Record<string, number>;
  by_source: Record<string, number>;
  /** Number of mined decisions awaiting human review (review_status='pending'). */
  pending_reviews?: number;
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

type DecisionType = (typeof DECISION_TYPES)[number];

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

// ── Add/Edit decision inline form ─────────────────────────────────────────────

interface DecisionFormValues {
  title: string;
  content: string;
  type: DecisionType;
  file_path: string;
  symbol_id: string;
  tags: string;
}

const EMPTY_FORM: DecisionFormValues = {
  title: '',
  content: '',
  type: 'preference',
  file_path: '',
  symbol_id: '',
  tags: '',
};

function DecisionForm({
  root,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  root: string;
  initial?: Partial<DecisionFormValues>;
  submitLabel: string;
  onSubmit: (values: DecisionFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<DecisionFormValues>({ ...EMPTY_FORM, ...initial });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof DecisionFormValues) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => setValues((v) => ({ ...v, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!values.title.trim()) { setError('Title is required'); return; }
    if (!values.content.trim()) { setError('Content is required'); return; }
    setError(null);
    setPending(true);
    try {
      await onSubmit(values);
    } catch (err) {
      setError((err as Error).message ?? 'Unknown error');
    } finally {
      setPending(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-inset)',
    border: '0.5px solid var(--border-row)',
    borderRadius: 6,
    color: 'var(--text-primary)',
    fontSize: 12,
    padding: '4px 8px',
    width: '100%',
    outline: 'none',
  };

  return (
    <form
      onSubmit={(e) => { void handleSubmit(e); }}
      className="space-y-2 px-3 py-3"
      style={{ background: 'var(--bg-grouped)', borderRadius: 10 }}
      // Prevent click-through to parent toggles
      onClick={(e) => e.stopPropagation()}
    >
      <div className="space-y-1.5">
        <label className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          Title *
        </label>
        <input
          type="text"
          value={values.title}
          onChange={set('title')}
          placeholder="Short summary"
          style={inputStyle}
          disabled={pending}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          Content *
        </label>
        <textarea
          value={values.content}
          onChange={set('content')}
          placeholder="Full decision text, reasoning, context…"
          rows={4}
          style={{ ...inputStyle, resize: 'vertical' }}
          disabled={pending}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <label className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            Type
          </label>
          <select
            value={values.type}
            onChange={set('type')}
            style={inputStyle}
            disabled={pending}
          >
            {DECISION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            Tags (comma-separated)
          </label>
          <input
            type="text"
            value={values.tags}
            onChange={set('tags')}
            placeholder="e.g. auth, api, db"
            style={inputStyle}
            disabled={pending}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <label className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            File path (optional)
          </label>
          <input
            type="text"
            value={values.file_path}
            onChange={set('file_path')}
            placeholder="src/auth/index.ts"
            style={inputStyle}
            disabled={pending}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            Symbol ID (optional)
          </label>
          <input
            type="text"
            value={values.symbol_id}
            onChange={set('symbol_id')}
            placeholder="MyClass.myMethod"
            style={inputStyle}
            disabled={pending}
          />
        </div>
      </div>

      {error && (
        <div className="text-[11px]" style={{ color: '#f87171' }}>
          {error}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={pending}
          className="text-[12px] font-medium px-3 py-1 rounded"
          style={{
            background: 'var(--accent)',
            color: '#fff',
            cursor: pending ? 'not-allowed' : 'pointer',
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="text-[12px] px-3 py-1 rounded"
          style={{
            background: 'var(--bg-inset)',
            color: 'var(--text-secondary)',
            border: '0.5px solid var(--border-row)',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>

      {/* Suppress unused variable warning — root used in parent for POST URL */}
      <input type="hidden" value={root} />
    </form>
  );
}

// ── DecisionCard — with Edit / Invalidate actions ────────────────────────────

function DecisionCard({
  decision,
  root,
  expanded,
  onToggle,
  onUpdated,
  onInvalidated,
}: {
  decision: DecisionRow;
  root: string;
  expanded: boolean;
  onToggle: () => void;
  onUpdated: (updated: DecisionRow) => void;
  onInvalidated: (id: number) => void;
}) {
  const tags = parseTags(decision.tags);
  const isActive = decision.valid_until === null;
  const [editing, setEditing] = useState(false);
  const [confirmInvalidate, setConfirmInvalidate] = useState(false);
  const [actionPending, setActionPending] = useState(false);

  const handleEdit = async (values: DecisionFormValues) => {
    const res = await fetch(`${BASE}/api/projects/decisions/${decision.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: values.title,
        content: values.content,
        type: values.type,
        file_path: values.file_path || undefined,
        symbol_id: values.symbol_id || undefined,
        tags: values.tags,
      }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    // Optimistic update — reflect the new values locally
    onUpdated({
      ...decision,
      title: values.title,
      content: values.content,
      type: values.type,
      file_path: values.file_path || null,
      symbol_id: values.symbol_id || null,
      tags: values.tags
        ? JSON.stringify(values.tags.split(',').map((t) => t.trim()).filter(Boolean))
        : null,
    });
    setEditing(false);
  };

  const handleInvalidate = async () => {
    setActionPending(true);
    try {
      const res = await fetch(`${BASE}/api/projects/decisions/${decision.id}/invalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      onInvalidated(decision.id);
    } finally {
      setActionPending(false);
      setConfirmInvalidate(false);
    }
  };

  return (
    <div style={{ opacity: isActive ? 1 : 0.5 }}>
      {/* Edit form replaces the entire card when active */}
      {editing ? (
        <DecisionForm
          root={root}
          initial={{
            title: decision.title,
            content: decision.content,
            type: decision.type as DecisionType,
            file_path: decision.file_path ?? '',
            symbol_id: decision.symbol_id ?? '',
            tags: parseTags(decision.tags).join(', '),
          }}
          submitLabel="Save changes"
          onSubmit={handleEdit}
          onCancel={() => setEditing(false)}
        />
      ) : (
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

            {/* Action buttons — visible in header, stop toggle propagation */}
            {isActive && (
              <div
                className="flex items-center gap-1 shrink-0"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => { setEditing(true); }}
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                  style={{
                    background: 'var(--bg-inset)',
                    color: 'var(--text-secondary)',
                    border: '0.5px solid var(--border-row)',
                    cursor: 'pointer',
                  }}
                  title="Edit decision"
                >
                  Edit
                </button>
                {confirmInvalidate ? (
                  <>
                    <button
                      type="button"
                      onClick={() => { void handleInvalidate(); }}
                      disabled={actionPending}
                      className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                      style={{
                        background: 'rgba(239,68,68,0.15)',
                        color: '#f87171',
                        cursor: actionPending ? 'not-allowed' : 'pointer',
                        opacity: actionPending ? 0.6 : 1,
                      }}
                    >
                      {actionPending ? '…' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmInvalidate(false)}
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{
                        background: 'var(--bg-inset)',
                        color: 'var(--text-tertiary)',
                        cursor: 'pointer',
                      }}
                    >
                      ✕
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmInvalidate(true)}
                    className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                    style={{
                      background: 'rgba(239,68,68,0.08)',
                      color: '#f87171',
                      border: '0.5px solid rgba(239,68,68,0.2)',
                      cursor: 'pointer',
                    }}
                    title="Invalidate decision"
                  >
                    Invalidate
                  </button>
                )}
              </div>
            )}

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
      )}
    </div>
  );
}

function DecisionsView({ root }: { root: string }) {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [stats, setStats] = useState<DecisionStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // Filter state — match feeds the FTS `q` parameter, exclude is applied
  // client-side over the returned rows. Depth is intentionally disabled for
  // this view: decisions are a flat list with no hierarchical depth concept.
  const [filter, setFilter] = useState<FilterValue>(EMPTY_FILTER_VALUE);
  const [activeType, setActiveType] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const fetchDecisions = useCallback(
    async (search: string, type: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ project: root, limit: '50', offset: '0' });
        // Only forward plain-text matches as the FTS query — regex form
        // (`/.../`) wouldn't survive server-side FTS, so we drop it and let
        // the client-side filter do the work after the fetch.
        if (search && !search.startsWith('/')) params.set('q', search);
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
  }, [fetchStats]);

  // Refetch whenever match or active type changes. FilterBar already
  // debounces so we can react synchronously here.
  useEffect(() => {
    void fetchDecisions(filter.match, activeType);
  }, [fetchDecisions, filter.match, activeType]);

  // Client-side filter pass: applies `match` (when regex), and `exclude`
  // against title + content + type + file_path so the user can quickly
  // narrow noisy result sets without a server round-trip.
  const visibleDecisions = useMemo(() => {
    if (!filter.match && !filter.exclude) return decisions;
    return decisions.filter((d) => {
      const haystack = `${d.title}\n${d.content}\n${d.type}\n${d.file_path ?? ''}`;
      // For regex matches the server returned everything (we couldn't push
      // the regex down) so we still need the include check here. For plain
      // text the server already filtered, so matchesFilter is a no-op pass.
      if (filter.match && !matchesFilter(haystack, filter.match)) return false;
      if (filter.exclude && matchesFilter(haystack, filter.exclude)) return false;
      return true;
    });
  }, [decisions, filter.match, filter.exclude]);

  const handleTypeFilter = (type: string) => {
    const next = activeType === type ? '' : type;
    setActiveType(next);
  };

  const handleAdd = async (values: DecisionFormValues) => {
    const res = await fetch(`${BASE}/api/projects/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_root: root,
        title: values.title,
        content: values.content,
        type: values.type,
        file_path: values.file_path || undefined,
        symbol_id: values.symbol_id || undefined,
        tags: values.tags || undefined,
        source: 'manual',
      }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    setShowAddForm(false);
    // Refetch to get accurate totals and server-generated id
    await fetchDecisions(filter.match, activeType);
    await fetchStats();
  };

  const handleUpdated = (updated: DecisionRow) => {
    setDecisions((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  };

  const handleInvalidated = (id: number) => {
    setDecisions((prev) =>
      prev.map((d) =>
        d.id === id ? { ...d, valid_until: new Date().toISOString() } : d,
      ),
    );
    void fetchStats();
  };

  return (
    <div className="space-y-3">
      {/* Stats panel */}
      {stats && <StatsPanel stats={stats} />}

      {/* Add decision button / form */}
      {showAddForm ? (
        <DecisionForm
          root={root}
          submitLabel="Add decision"
          onSubmit={handleAdd}
          onCancel={() => setShowAddForm(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowAddForm(true)}
          className="text-[12px] font-medium px-3 py-1.5 rounded-md"
          style={{
            background: 'var(--accent)',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          + Add decision
        </button>
      )}

      {/* Filter bar — match feeds FTS, exclude is client-side */}
      <div
        className="px-3 py-2"
        style={{
          background: 'var(--bg-grouped)',
          border: '0.5px solid var(--border-row)',
          borderRadius: 8,
          boxShadow: 'var(--shadow-grouped)',
        }}
      >
        <FilterBar
          value={filter}
          onChange={setFilter}
          depthEnabled={false}
          storageKey="filter:decisions"
          placeholder={{
            match: 'Search decisions…',
            exclude: 'hide rows containing…',
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

          {!loading && visibleDecisions.length === 0 && (
            <div className="px-3 py-4 text-[12px] text-center" style={{ color: 'var(--text-tertiary)' }}>
              {filter.match || filter.exclude || activeType
                ? 'No matching decisions.'
                : 'No decisions stored yet.'}
            </div>
          )}

          {!loading &&
            visibleDecisions.map((d, i) => {
              const isLast = i === visibleDecisions.length - 1;
              return (
                <div
                  key={d.id}
                  style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--border-row)' }}
                >
                  <DecisionCard
                    decision={d}
                    root={root}
                    expanded={expandedId === d.id}
                    onToggle={() => setExpandedId(expandedId === d.id ? null : d.id)}
                    onUpdated={handleUpdated}
                    onInvalidated={handleInvalidated}
                  />
                </div>
              );
            })}

          {!loading && total > visibleDecisions.length && (
            <div
              className="px-3 py-1.5 text-[10px] text-center"
              style={{ color: 'var(--text-tertiary)', borderTop: '0.5px solid var(--border-row)' }}
            >
              {filter.exclude
                ? `Showing ${visibleDecisions.length} of ${total} (${decisions.length - visibleDecisions.length} hidden by exclude)`
                : `Showing ${visibleDecisions.length} of ${total} — refine your search to narrow results`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Corpus query modal ────────────────────────────────────────────────────────

function CorpusQueryModal({
  corpusName,
  root,
  onClose,
}: {
  corpusName: string;
  root: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ excerpt: string; tokens_used: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setError(null);
    setResult(null);
    setPending(true);
    try {
      const res = await fetch(`${BASE}/api/projects/corpora/${encodeURIComponent(corpusName)}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_root: root, query, max_tokens: 4000 }),
      });
      const data = (await res.json()) as { excerpt?: string; tokens_used?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult({ excerpt: data.excerpt ?? '', tokens_used: data.tokens_used ?? 0 });
    } catch (err) {
      setError((err as Error).message ?? 'Query failed');
    } finally {
      setPending(false);
    }
  };

  const handleCopy = () => {
    if (!result) return;
    void navigator.clipboard.writeText(result.excerpt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg mx-4 rounded-xl shadow-2xl space-y-3 p-4"
        style={{ background: 'var(--bg-primary)', maxHeight: '80vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            Query corpus:{' '}
            <span style={{ fontFamily: 'SF Mono, Menlo, monospace' }}>{corpusName}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-[13px] px-2 py-0.5 rounded"
            style={{ color: 'var(--text-tertiary)', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        <form onSubmit={(e) => { void handleQuery(e); }} className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What do you want to know from this corpus?"
            autoFocus
            className="flex-1 text-[12px] outline-none px-2.5"
            style={{
              background: 'var(--bg-grouped)',
              border: '0.5px solid var(--border-row)',
              borderRadius: 6,
              height: 30,
              color: 'var(--text-primary)',
            }}
            disabled={pending}
          />
          <button
            type="submit"
            disabled={pending || !query.trim()}
            className="text-[12px] font-medium px-3 py-1 rounded"
            style={{
              background: 'var(--accent)',
              color: '#fff',
              cursor: pending || !query.trim() ? 'not-allowed' : 'pointer',
              opacity: pending || !query.trim() ? 0.6 : 1,
            }}
          >
            {pending ? '…' : 'Search'}
          </button>
        </form>

        {error && (
          <div className="text-[11px]" style={{ color: '#f87171' }}>
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                ~{result.tokens_used} tokens
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className="text-[10px] px-2 py-0.5 rounded font-medium"
                style={{
                  background: 'var(--bg-inset)',
                  color: copied ? '#34d399' : 'var(--text-secondary)',
                  border: '0.5px solid var(--border-row)',
                  cursor: 'pointer',
                }}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre
              className="text-[11px] leading-relaxed whitespace-pre-wrap overflow-auto"
              style={{
                background: 'var(--bg-inset)',
                borderRadius: 6,
                padding: '8px 10px',
                color: 'var(--text-secondary)',
                maxHeight: 320,
                border: '0.5px solid var(--border-row)',
              }}
            >
              {result.excerpt}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function CorporaView({ root }: { root: string }) {
  const [corpora, setCorpora] = useState<CorpusItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [queryCorpus, setQueryCorpus] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const fetchCorpora = useCallback(() => {
    setLoading(true);
    fetch(`${BASE}/api/projects/corpora?${new URLSearchParams({ project: root })}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { corpora: CorpusItem[] } | null) => {
        if (data) setCorpora(data.corpora);
      })
      .catch(() => {/* optional */})
      .finally(() => setLoading(false));
  }, [root]);

  useEffect(() => {
    fetchCorpora();
  }, [fetchCorpora]);

  const handleDelete = async (name: string) => {
    setDeletePending(name);
    try {
      const params = new URLSearchParams({ project_root: root });
      const res = await fetch(
        `${BASE}/api/projects/corpora/${encodeURIComponent(name)}?${params}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      setCorpora((prev) => prev.filter((c) => c.name !== name));
    } catch {
      /* error surface: could add toast */
    } finally {
      setDeletePending(null);
      setConfirmDelete(null);
    }
  };

  return (
    <div className="space-y-3">
      {queryCorpus && (
        <CorpusQueryModal
          corpusName={queryCorpus}
          root={root}
          onClose={() => setQueryCorpus(null)}
        />
      )}

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
            const isDeleting = deletePending === c.name;
            const isConfirming = confirmDelete === c.name;
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

                  {/* Action buttons */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => setQueryCorpus(c.name)}
                      className="text-[11px] font-medium px-2 py-1 rounded"
                      style={{
                        background: 'var(--accent)',
                        color: '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      Query
                    </button>

                    {isConfirming ? (
                      <>
                        <button
                          type="button"
                          onClick={() => { void handleDelete(c.name); }}
                          disabled={isDeleting}
                          className="text-[11px] font-medium px-2 py-1 rounded"
                          style={{
                            background: 'rgba(239,68,68,0.15)',
                            color: '#f87171',
                            cursor: isDeleting ? 'not-allowed' : 'pointer',
                            opacity: isDeleting ? 0.6 : 1,
                          }}
                        >
                          {isDeleting ? '…' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(null)}
                          className="text-[11px] px-1.5 py-1 rounded"
                          style={{
                            background: 'var(--bg-inset)',
                            color: 'var(--text-tertiary)',
                            border: '0.5px solid var(--border-row)',
                            cursor: 'pointer',
                          }}
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(c.name)}
                        className="text-[11px] font-medium px-2 py-1 rounded"
                        style={{
                          background: 'var(--bg-inset)',
                          color: 'var(--text-secondary)',
                          border: '0.5px solid var(--border-row)',
                          cursor: 'pointer',
                        }}
                      >
                        Delete
                      </button>
                    )}
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

// ── Review queue (memoir-style confidence triage) ─────────────────────────────

/**
 * Compact card for a single pending decision. Shows the extracted text,
 * source session id, file_path, confidence (numeric + bar), captured branch,
 * plus Approve / Reject buttons. Buttons fire optimistic UI: the card is
 * removed before the POST resolves; on failure the card is reinserted and
 * an inline error replaces the buttons.
 */
function ReviewCard({
  decision,
  onApprove,
  onReject,
}: {
  decision: DecisionRow;
  onApprove: (id: number) => Promise<void>;
  onReject: (id: number) => Promise<void>;
}) {
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confidencePct = Math.round((decision.confidence ?? 0) * 100);
  const tags = parseTags(decision.tags);

  const handle = (kind: 'approve' | 'reject') => async () => {
    setPending(kind);
    setError(null);
    try {
      if (kind === 'approve') {
        await onApprove(decision.id);
      } else {
        await onReject(decision.id);
      }
    } catch (e) {
      setError((e as Error).message ?? 'Action failed');
      setPending(null);
    }
  };

  return (
    <div className="px-3 py-2.5 space-y-2">
      {/* Header: title + type/source badges */}
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="text-[13px] font-medium leading-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              {decision.title}
            </span>
            <TypeBadge type={decision.type} />
            <SourceBadge source={decision.source} />
            <span
              className="text-[9px] px-1.5 py-0.5 rounded font-medium uppercase shrink-0"
              style={{
                background: 'rgba(234,179,8,0.15)',
                color: '#fbbf24',
                letterSpacing: '0.03em',
              }}
            >
              pending review
            </span>
          </div>
        </div>
      </div>

      {/* Content excerpt */}
      <div
        className="text-[12px] leading-relaxed whitespace-pre-wrap"
        style={{ color: 'var(--text-secondary)' }}
      >
        {decision.content}
      </div>

      {/* Confidence bar + numeric */}
      <div className="flex items-center gap-2">
        <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          confidence
        </span>
        <div
          className="flex-1 h-1.5 rounded overflow-hidden"
          style={{ background: 'var(--bg-inset)', maxWidth: 200 }}
        >
          <div
            style={{
              width: `${confidencePct}%`,
              height: '100%',
              background:
                confidencePct >= 75
                  ? 'var(--green, #22c55e)'
                  : confidencePct >= 50
                  ? '#fbbf24'
                  : '#f87171',
            }}
          />
        </div>
        <span
          className="text-[10px] tabular-nums"
          style={{ color: 'var(--text-secondary)' }}
        >
          {confidencePct}%
        </span>
      </div>

      {/* Meta row: session, file, branch */}
      <div className="flex items-center gap-3 flex-wrap">
        {decision.session_id && (
          <a
            href={`#session:${decision.session_id}`}
            className="text-[10px] truncate max-w-[180px] hover:underline"
            style={{
              color: 'var(--accent, #818cf8)',
              fontFamily: 'SF Mono, Menlo, monospace',
            }}
            title={`Session ${decision.session_id}`}
          >
            {decision.session_id.slice(0, 14)}…
          </a>
        )}
        {decision.file_path && (
          <span
            className="text-[10px] truncate max-w-[200px]"
            style={{
              color: 'var(--text-tertiary)',
              fontFamily: 'SF Mono, Menlo, monospace',
            }}
            title={decision.file_path}
          >
            {decision.file_path}
          </span>
        )}
        {decision.git_branch && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{
              background: 'var(--bg-inset)',
              color: 'var(--text-secondary)',
              border: '0.5px solid var(--border-row)',
              fontFamily: 'SF Mono, Menlo, monospace',
            }}
            title={`Captured on branch ${decision.git_branch}`}
          >
            {decision.git_branch}
          </span>
        )}
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
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

      {/* Action buttons */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={() => { void handle('approve')(); }}
          disabled={pending !== null}
          className="text-[12px] font-medium px-3 py-1.5 rounded"
          style={{
            background: 'var(--green, #22c55e)',
            color: '#fff',
            cursor: pending ? 'not-allowed' : 'pointer',
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={() => { void handle('reject')(); }}
          disabled={pending !== null}
          className="text-[12px] font-medium px-3 py-1.5 rounded"
          style={{
            background: 'rgba(239,68,68,0.15)',
            color: '#f87171',
            border: '0.5px solid rgba(239,68,68,0.4)',
            cursor: pending ? 'not-allowed' : 'pointer',
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        {error && (
          <span className="text-[11px] self-center" style={{ color: '#f87171' }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

interface ToastState {
  message: string;
  kind: 'error' | 'success';
}

function ReviewView({
  root,
  onPendingCountChange,
}: {
  root: string;
  onPendingCountChange?: (count: number) => void;
}) {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const fetchPending = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        project: root,
        review_status: 'pending',
        limit: '100',
      });
      const res = await fetch(`${BASE}/api/projects/decisions?${params}`);
      if (res.ok) {
        const data = (await res.json()) as { decisions: DecisionRow[]; total: number };
        setDecisions(data.decisions);
        onPendingCountChange?.(data.total);
      }
    } catch {
      /* optional */
    }
    setLoading(false);
  }, [root, onPendingCountChange]);

  useEffect(() => {
    void fetchPending();
  }, [fetchPending]);

  const showToast = (message: string, kind: ToastState['kind']) => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 3000);
  };

  // Optimistic action: drop the card immediately, POST in the background.
  // On failure, splice the card back into the list and surface a toast.
  const handleAction = async (
    id: number,
    status: 'approved' | 'rejected',
  ): Promise<void> => {
    const idx = decisions.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const removed = decisions[idx];

    setDecisions((prev) => prev.filter((d) => d.id !== id));
    onPendingCountChange?.(Math.max(0, decisions.length - 1));

    try {
      const res = await fetch(`${BASE}/api/projects/decisions/${id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      showToast(`Decision ${status}.`, 'success');
    } catch (e) {
      // Revert: reinsert at original index so list order is preserved.
      setDecisions((prev) => {
        const next = [...prev];
        next.splice(idx, 0, removed);
        return next;
      });
      onPendingCountChange?.(decisions.length);
      showToast((e as Error).message ?? 'Action failed', 'error');
      throw e;
    }
  };

  return (
    <div className="space-y-3">
      {/* Toast */}
      {toast && (
        <div
          className="px-3 py-2 text-[12px] rounded-md"
          style={{
            background:
              toast.kind === 'error'
                ? 'rgba(239,68,68,0.15)'
                : 'rgba(34,197,94,0.15)',
            color: toast.kind === 'error' ? '#f87171' : '#22c55e',
            border: `0.5px solid ${toast.kind === 'error' ? '#f8717140' : '#22c55e40'}`,
          }}
        >
          {toast.message}
        </div>
      )}

      <div className="flex items-baseline justify-between mb-1.5 px-3">
        <span
          className="text-[11px]"
          style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}
        >
          Review queue
        </span>
        {!loading && (
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {decisions.length}
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
            Nothing to review — the queue is empty.
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
                <ReviewCard
                  decision={d}
                  onApprove={(id) => handleAction(id, 'approved')}
                  onReject={(id) => handleAction(id, 'rejected')}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

type SubTab = 'decisions' | 'review' | 'corpora' | 'sessions';

export function MemoryExplorer({ root }: { root: string }) {
  const [activeTab, setActiveTab] = useState<SubTab>('decisions');
  // Pending count lives in the parent so the Review (N) badge in the tab bar
  // stays in sync with optimistic mutations inside ReviewView.
  const [pendingCount, setPendingCount] = useState(0);

  // Refresh the badge whenever the user switches into Memory or any sub-view.
  // Cheap stats endpoint, returns the same number ReviewView would compute.
  useEffect(() => {
    let cancelled = false;
    void fetch(`${BASE}/api/projects/decisions/stats?${new URLSearchParams({ project: root })}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: DecisionStats | null) => {
        if (!cancelled && data && typeof data.pending_reviews === 'number') {
          setPendingCount(data.pending_reviews);
        }
      })
      .catch(() => { /* optional */ });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const tabs: { key: SubTab; label: string }[] = [
    { key: 'decisions', label: 'Decisions' },
    { key: 'review', label: `Review (${pendingCount})` },
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
      {activeTab === 'review' && (
        <ReviewView root={root} onPendingCountChange={setPendingCount} />
      )}
      {activeTab === 'corpora' && <CorporaView root={root} />}
      {activeTab === 'sessions' && <SessionsView root={root} />}
    </div>
  );
}
