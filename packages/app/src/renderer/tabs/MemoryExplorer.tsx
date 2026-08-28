import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { matchesFilter } from '../components/FilterBar';
import { Icon } from '../lattice/icons';
import {
  Badge,
  Button,
  Card,
  ConfirmPopover,
  EmptyState,
  Menu,
  MenuItem,
  MenuSeparator,
  SearchField,
  Section,
  SectionError,
  SegmentedControl,
  SkeletonRows,
  StatusDot,
  Toolbar,
  ToolbarDivider,
  useMenuAnchor,
  type Tone,
} from '../lattice/ui';

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

/* Decision categories. A tone is one channel; `label` is the other, so the
   colour never has to be read on its own. Tones come from the shared status
   palette — the old map was seven hand-picked hex pairs at 9px/700 ALL CAPS. */
const TYPE_META: Record<string, { label: string; tone: Tone }> = {
  architecture_decision: { label: 'Architecture', tone: 'purple' },
  tech_choice: { label: 'Tech choice', tone: 'blue' },
  bug_root_cause: { label: 'Bug root cause', tone: 'red' },
  preference: { label: 'Preference', tone: 'green' },
  tradeoff: { label: 'Trade-off', tone: 'orange' },
  discovery: { label: 'Discovery', tone: 'accent' },
  convention: { label: 'Convention', tone: 'neutral' },
};

function typeMeta(type: string): { label: string; tone: Tone } {
  return TYPE_META[type] ?? { label: type.replace(/_/g, ' '), tone: 'neutral' };
}

/** Tone → the CSS variable it paints with, for the one place that needs the
    raw colour (a 6px meter segment, where a Badge does not fit). */
const TONE_VAR: Record<Tone, string> = {
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

/** ↑↓ walks a list of rows. Roving DOM focus rather than a selection index:
    the focus ring, the Enter handler and the scroll-into-view are already
    correct on a focused row, so there is no second notion of "current" to keep
    in sync. Anything the arrows land on is a row — the per-row ••• is a real
    <button>, so it stays out of the walk and on the Tab path. */
function rovingArrowKeys(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"]')];
  if (rows.length === 0) return;
  e.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    at === -1
      ? 0
      : e.key === 'ArrowDown'
        ? Math.min(at + 1, rows.length - 1)
        : Math.max(at - 1, 0);
  rows[next]?.focus();
}

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Added by hand',
  mined: 'Mined from a session',
  auto: 'Recorded automatically',
};

function TypeBadge({ type }: { type: string }) {
  const { label, tone } = typeMeta(type);
  return <Badge tone={tone}>{label}</Badge>;
}

function SourceBadge({ source }: { source: string }) {
  return (
    <Badge tone="neutral" title={SOURCE_LABEL[source] ?? source}>
      {SOURCE_LABEL[source] ?? source}
    </Badge>
  );
}

/** The one toolbar + one scroll container each Memory sub-view is built on.
    The sub-tab switcher rides on the toolbar's leading edge rather than in a
    row of its own — the old surface stacked the tab pills, a stat card, a lone
    accent button and a filter card before any content appeared (TRA-294). */
function ViewShell({
  subTab,
  status,
  actions,
  children,
}: {
  subTab?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [scrolled, setScrolled] = useState(false);
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Toolbar scrolled={scrolled}>
        {subTab}
        {status != null && (
          <>
            <ToolbarDivider />
            <span
              className="shrink-0 text-[11px] leading-[13px] tabular-nums"
              style={{ color: 'var(--label-secondary)' }}
            >
              {status}
            </span>
          </>
        )}
        <span className="flex-1" />
        {actions}
      </Toolbar>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 0)}
      >
        <div className="flex flex-col gap-4 px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

// ── Sub-views ─────────────────────────────────────────────────────────────────

/** The decision mix, as one row of the surface rather than a 70px card that
    was 96% whitespace around three numbers with 2.21:1 labels. The counts live
    in the toolbar now; this is only the per-type breakdown, and each segment is
    named in the legend under it. */
function TypeMix({
  stats,
  activeType,
  onTypeClick,
}: {
  stats: DecisionStats;
  activeType: string;
  onTypeClick: (type: string) => void;
}) {
  const entries = Object.entries(stats.by_type)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, n]) => sum + n, 0) || 1;

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex overflow-hidden"
        style={{ gap: 1, height: 6, borderRadius: 3, background: 'var(--fill-quaternary)' }}
      >
        {entries.map(([type, n]) => (
          <div
            key={type}
            title={`${typeMeta(type).label}: ${n}`}
            style={{
              width: `${(n / total) * 100}%`,
              minWidth: 2,
              borderRadius: 2,
              background: TONE_VAR[typeMeta(type).tone],
              opacity: activeType === '' || activeType === type ? 1 : 0.3,
              transition: 'opacity var(--dur-micro) var(--ease-out)',
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {entries.map(([type, n]) => {
          const meta = typeMeta(type);
          const active = activeType === type;
          return (
            <button
              key={type}
              type="button"
              className={`lx-chip single${active ? ' is-on' : ''}`}
              aria-pressed={active}
              onClick={() => onTypeClick(type)}
              title={`Show only ${meta.label.toLowerCase()} decisions`}
            >
              <StatusDot tone={meta.tone} size={6} />
              {meta.label}
              <span className="tabular-nums">{n}</span>
            </button>
          );
        })}
      </div>
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
    background: 'var(--fill-quaternary)',
    boxShadow: 'inset 0 0 0 0.5px var(--separator)',
    border: 0,
    borderRadius: 'var(--radius-input)',
    color: 'var(--label)',
    fontSize: 13,
    lineHeight: '16px',
    fontFamily: 'inherit',
    padding: '5px 8px',
    width: '100%',
    outline: 'none',
  };

  return (
    <form
      onSubmit={(e) => { void handleSubmit(e); }}
      className="flex flex-col gap-3 px-3 py-3"
      style={{
        background: 'var(--surface)',
        borderRadius: 12,
        border: '0.5px solid var(--separator)',
      }}
      // Prevent click-through to parent toggles
      onClick={(e) => e.stopPropagation()}
    >
      <div className="space-y-1.5">
        <label className="text-[11px] leading-[13px]" style={{ color: 'var(--label-secondary)' }}>
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
        <label className="text-[11px] leading-[13px]" style={{ color: 'var(--label-secondary)' }}>
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
          <label className="text-[11px] leading-[13px]" style={{ color: 'var(--label-secondary)' }}>
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
          <label className="text-[11px] leading-[13px]" style={{ color: 'var(--label-secondary)' }}>
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
          <label className="text-[11px] leading-[13px]" style={{ color: 'var(--label-secondary)' }}>
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
          <label className="text-[11px] leading-[13px]" style={{ color: 'var(--label-secondary)' }}>
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
        <div
          role="alert"
          className="flex items-center gap-1.5 text-[13px] leading-4"
          style={{ color: 'var(--status-red)' }}
        >
          <Icon name="warning" size={14} />
          {error}
        </div>
      )}

      {/* macOS puts the confirming action last, on the trailing edge. */}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="prominent" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
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
  const [actionPending, setActionPending] = useState(false);
  /* Invalidate is destructive and used rarely, so it lives behind the row's
     ••• menu with a named confirmation — not as a red bordered button sitting
     in every row, one stray click from expiring a decision (TRA-294). */
  const rowMenu = useMenuAnchor();
  const confirm = useMenuAnchor();

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
      confirm.close();
    }
  };

  return (
    <div>
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
        <>
          {/* A div with role=button, not a <button>: this row contains its own
              buttons, and a nested <button> is invalid HTML that Chromium
              reparents out of the row, desyncing React's refs. */}
          <div
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            onClick={onToggle}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              onToggle();
            }}
            className="w-full text-left px-3 py-2.5 flex items-start gap-2"
            style={{ cursor: 'pointer' }}
          >
            {/* Expired is said in a badge as well as shown by the dot — the
                old card carried it as a 50% opacity wash and nothing else. */}
            <span className="mt-1 shrink-0">
              <StatusDot
                tone={isActive ? 'green' : 'neutral'}
                size={6}
                title={isActive ? 'Active' : 'Expired'}
              />
            </span>

            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span
                  className="text-[13px] leading-4 font-medium"
                  style={{ color: 'var(--label)' }}
                >
                  {decision.title}
                </span>
                <TypeBadge type={decision.type} />
                <SourceBadge source={decision.source} />
                {!isActive && <Badge tone="neutral">Expired</Badge>}
              </div>

              <div
                className="flex items-center gap-2 flex-wrap text-[11px] leading-[13px]"
                style={{ color: 'var(--label-secondary)' }}
              >
                {decision.file_path && (
                  <span
                    className="truncate max-w-[220px]"
                    style={{ fontFamily: 'var(--font-mono)' }}
                    title={decision.file_path}
                  >
                    {decision.file_path}
                  </span>
                )}
                <span className="tabular-nums">{formatDate(decision.created_at)}</span>
              </div>
            </div>

            <div
              className="flex items-center gap-1 shrink-0"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              role="presentation"
            >
              <Button
                ref={rowMenu.ref}
                variant="icon"
                icon="more_horiz"
                onClick={() => (rowMenu.at ? rowMenu.close() : rowMenu.open())}
                aria-haspopup="menu"
                aria-expanded={rowMenu.at !== null}
                aria-label={`Actions for ${decision.title}`}
                title="Actions"
              />
            </div>

            <span className="shrink-0 mt-0.5 flex" style={{ color: 'var(--label-secondary)' }}>
              <Icon name={expanded ? 'expand_more' : 'chevron_right'} size={16} />
            </span>
          </div>

          {rowMenu.at && (
            <Menu x={rowMenu.at.x} y={rowMenu.at.y} align="end" onClose={rowMenu.close}>
              <MenuItem
                icon="edit"
                onClick={() => {
                  rowMenu.close();
                  setEditing(true);
                }}
              >
                Edit decision…
              </MenuItem>
              {isActive && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    danger
                    icon="archive"
                    disabled={actionPending}
                    onClick={() => {
                      const at = rowMenu.at;
                      rowMenu.close();
                      if (at) confirm.openAt(at);
                    }}
                  >
                    Invalidate decision…
                  </MenuItem>
                </>
              )}
            </Menu>
          )}

          {confirm.at && (
            <ConfirmPopover
              x={confirm.at.x}
              y={confirm.at.y}
              align="end"
              danger
              title={`Invalidate ${decision.title}?`}
              body="It stops being read back to assistants from now on. The record itself is kept, with today as its end date."
              confirmLabel={actionPending ? 'Invalidating…' : 'Invalidate'}
              onConfirm={() => void handleInvalidate()}
              onCancel={confirm.close}
            />
          )}

          {/* Expanded body */}
          {expanded && (
            <div
              className="px-3 pb-3 flex flex-col gap-2"
              style={{ borderTop: '0.5px solid var(--separator)' }}
            >
              <div
                className="text-[13px] leading-[18px] whitespace-pre-wrap mt-2"
                style={{ color: 'var(--label)' }}
              >
                {decision.content}
              </div>

              <div
                className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2 text-[11px] leading-[13px]"
                style={{ borderTop: '0.5px solid var(--separator)' }}
              >
                {decision.symbol_id && (
                  <>
                    <span style={{ color: 'var(--label-secondary)' }}>Symbol</span>
                    <span
                      className="truncate"
                      style={{ color: 'var(--label)', fontFamily: 'var(--font-mono)' }}
                      title={decision.symbol_id}
                    >
                      {decision.symbol_id}
                    </span>
                  </>
                )}
                {decision.file_path && (
                  <>
                    <span style={{ color: 'var(--label-secondary)' }}>File</span>
                    <span
                      className="truncate"
                      style={{ color: 'var(--label)', fontFamily: 'var(--font-mono)' }}
                      title={decision.file_path}
                    >
                      {decision.file_path}
                    </span>
                  </>
                )}
                <span style={{ color: 'var(--label-secondary)' }}>Valid from</span>
                <span className="tabular-nums" style={{ color: 'var(--label)' }}>
                  {formatDate(decision.valid_from)}
                </span>
                {decision.valid_until && (
                  <>
                    <span style={{ color: 'var(--label-secondary)' }}>Expired</span>
                    <span className="tabular-nums" style={{ color: 'var(--label)' }}>
                      {formatDate(decision.valid_until)}
                    </span>
                  </>
                )}
                {decision.confidence < 1 && (
                  <>
                    <span style={{ color: 'var(--label-secondary)' }}>Confidence</span>
                    <span className="tabular-nums" style={{ color: 'var(--label)' }}>
                      {Math.round(decision.confidence * 100)}%
                    </span>
                  </>
                )}
              </div>

              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {tags.map((tag) => (
                    <Badge key={tag} tone="neutral">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DecisionsView({ root, subTab }: { root: string; subTab?: ReactNode }) {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [stats, setStats] = useState<DecisionStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  /* A swallowed fetch failure used to fall through to "No decisions yet",
     inviting you to re-add decisions you already have. Failure is its own
     state (TRA-294). */
  const [failed, setFailed] = useState(false);
  /* One search field feeds the FTS `q` parameter; one optional exclude field
     hides rows client-side. Both take plain text or /regex/i. This replaces the
     shared FilterBar, whose MATCH / EXCLUDE labels were 10.5px/700 ALL-CAPS
     jargon bolted to two inputs inside a bordered card (TRA-294). FilterBar
     itself stays — the Graph surface still uses it. */
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [exclude, setExclude] = useState('');
  const [showExclude, setShowExclude] = useState(false);
  const [activeType, setActiveType] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const overflow = useMenuAnchor();

  /* FilterBar used to own the debounce; typing straight into a fetch would
     issue one request per keystroke. */
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(id);
  }, [query]);

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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { decisions: DecisionRow[]; total: number };
        setDecisions(data.decisions);
        setTotal(data.total);
        setFailed(false);
      } catch {
        setFailed(true);
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

  useEffect(() => {
    void fetchDecisions(debouncedQuery, activeType);
  }, [fetchDecisions, debouncedQuery, activeType]);

  // Client-side filter pass: applies `query` (when regex), and `exclude`
  // against title + content + type + file_path so the user can quickly
  // narrow noisy result sets without a server round-trip.
  const visibleDecisions = useMemo(() => {
    if (!debouncedQuery && !exclude) return decisions;
    return decisions.filter((d) => {
      const haystack = `${d.title}\n${d.content}\n${d.type}\n${d.file_path ?? ''}`;
      // For regex matches the server returned everything (we couldn't push
      // the regex down) so we still need the include check here. For plain
      // text the server already filtered, so matchesFilter is a no-op pass.
      if (debouncedQuery && !matchesFilter(haystack, debouncedQuery)) return false;
      if (exclude && matchesFilter(haystack, exclude)) return false;
      return true;
    });
  }, [decisions, debouncedQuery, exclude]);

  const handleTypeFilter = (type: string) => {
    const next = activeType === type ? '' : type;
    setActiveType(next);
  };

  const handleAdd = async (values: DecisionFormValues) => {
    const res = await fetch(`${BASE}/api/projects/decisions`, { // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- BASE is the app's own local daemon (127.0.0.1), not a remote endpoint.
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
    await fetchDecisions(debouncedQuery, activeType);
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

  const hasFilters = debouncedQuery !== '' || exclude !== '' || activeType !== '';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Toolbar ───────────────────────────────────────────────────
          ONE row. It replaces four stacked ones: the tab pills, a 70px stat
          card holding three numbers, a 40px accent "+ Add decision" button
          alone on its own line, and a bordered MATCH / EXCLUDE card. */}
      <Toolbar scrolled={scrolled}>
        {subTab}
        <ToolbarDivider />
        <span
          className="flex items-center gap-1 shrink-0 text-[11px] leading-[13px] tabular-nums"
          style={{ color: 'var(--label-secondary)' }}
        >
          <span style={{ color: 'var(--label)' }}>
            {stats == null
              ? '—'
              : `${stats.total.toLocaleString()} decision${stats.total === 1 ? '' : 's'}`}
          </span>
          {stats != null && stats.total > stats.active && (
            <span>· {(stats.total - stats.active).toLocaleString()} expired</span>
          )}
        </span>

        <span className="flex-1" />

        {showExclude || exclude !== '' ? (
          <SearchField
            value={exclude}
            onChange={setExclude}
            placeholder="Exclude"
            aria-label="Exclude decisions containing"
            className="shrink-0"
          />
        ) : null}

        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search decisions"
          aria-label="Search decisions"
        />

        <Button
          variant="prominent"
          icon="add"
          onClick={() => setShowAddForm(true)}
          disabled={showAddForm}
        >
          Add decision
        </Button>

        <Button
          ref={overflow.ref}
          variant="icon"
          icon="more_horiz"
          onClick={() => (overflow.at ? overflow.close() : overflow.open())}
          aria-haspopup="menu"
          aria-expanded={overflow.at !== null}
          aria-label="More actions"
          title="More actions"
        />
      </Toolbar>

      {overflow.at && (
        <Menu x={overflow.at.x} y={overflow.at.y} align="end" onClose={overflow.close}>
          <MenuItem
            showCheckSlot
            checked={showExclude || exclude !== ''}
            onClick={() => {
              if (showExclude || exclude !== '') {
                setExclude('');
                setShowExclude(false);
              } else {
                setShowExclude(true);
              }
            }}
          >
            Exclude field
          </MenuItem>
          {hasFilters && (
            <>
              <MenuSeparator />
              <MenuItem
                icon="close"
                onClick={() => {
                  setQuery('');
                  setExclude('');
                  setActiveType('');
                  overflow.close();
                }}
              >
                Clear search and filters
              </MenuItem>
            </>
          )}
        </Menu>
      )}

      <div
        className="flex-1 min-h-0 overflow-y-auto"
        onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 0)}
      >
        <div className="flex flex-col gap-4 px-4 py-4">
          {showAddForm && (
            <DecisionForm
              root={root}
              submitLabel="Add decision"
              onSubmit={handleAdd}
              onCancel={() => setShowAddForm(false)}
            />
          )}

          {/* The mix doubles as the type filter: colour is the meter, the
              chip next to it is the name and the count. */}
          {stats != null && stats.total > 0 && (
            <TypeMix stats={stats} activeType={activeType} onTypeClick={handleTypeFilter} />
          )}

          <Section
            title="Decisions"
            trailing={
              loading || failed ? undefined : (
                <span
                  className="text-[11px] leading-[13px] tabular-nums"
                  style={{ color: 'var(--label-secondary)' }}
                >
                  {visibleDecisions.length === total
                    ? `${total.toLocaleString()} found`
                    : `${visibleDecisions.length.toLocaleString()} of ${total.toLocaleString()}`}
                </span>
              )
            }
          >
            <Card>
              {loading && <SkeletonRows rows={4} />}

              {!loading && failed && (
                <SectionError
                  what="the decisions for this project"
                  onRetry={() => fetchDecisions(debouncedQuery, activeType)}
                />
              )}

              {!loading && !failed && visibleDecisions.length === 0 && (
                hasFilters ? (
                  <EmptyState
                    compact
                    icon="search"
                    title="No matching decisions"
                    subtitle="Nothing stored for this project matches the current search and filters."
                    action={
                      <Button
                        icon="close"
                        onClick={() => {
                          setQuery('');
                          setExclude('');
                          setActiveType('');
                        }}
                      >
                        Clear search and filters
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    compact
                    icon="neurology"
                    title="No decisions yet"
                    subtitle="A decision is a note about why this codebase is the way it is — a trade-off, a convention, the root cause of a bug. Assistants read them back before they change your code."
                    action={
                      <Button variant="prominent" icon="add" onClick={() => setShowAddForm(true)}>
                        Add the first decision
                      </Button>
                    }
                  />
                )
              )}

              {!loading && visibleDecisions.length > 0 && (
                <div onKeyDown={rovingArrowKeys}>
                  {visibleDecisions.map((d, i) => {
                    const isLast = i === visibleDecisions.length - 1;
                    return (
                      <div
                        key={d.id}
                        style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--separator)' }}
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
                </div>
              )}

              {!loading && visibleDecisions.length > 0 && total > visibleDecisions.length && (
                <div
                  className="px-3 py-2 text-[11px] leading-[13px] text-center"
                  style={{
                    color: 'var(--label-secondary)',
                    borderTop: '0.5px solid var(--separator)',
                  }}
                >
                  {exclude
                    ? `${(decisions.length - visibleDecisions.length).toLocaleString()} more hidden by the exclude filter`
                    : 'Narrow the search to see the rest'}
                </div>
              )}
            </Card>
          </Section>
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
      className="fixed inset-0 z-50 flex items-start justify-center"
      style={{ background: 'rgb(0 0 0 / 0.35)', paddingTop: '10vh' }}
      onClick={onClose}
      role="presentation"
    >
      {/* A sheet, not a centred web modal: 12px radius, panel shadow, Esc and
          a backdrop press both dismiss. */}
      <div
        className="w-full max-w-lg mx-4 flex flex-col gap-3 p-4"
        style={{
          background: 'var(--surface-raised)',
          border: '0.5px solid var(--separator)',
          borderRadius: 'var(--radius-panel)',
          boxShadow: 'var(--shadow-panel)',
          maxHeight: '70vh',
          overflowY: 'auto',
        }}
        role="dialog"
        aria-label={`Query corpus ${corpusName}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[17px] leading-[22px] font-semibold" style={{ color: 'var(--label)' }}>
            Query{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{corpusName}</span>
          </span>
          <Button variant="icon" icon="close" onClick={onClose} aria-label="Close" title="Close" />
        </div>

        <form onSubmit={(e) => { void handleQuery(e); }} className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What do you want to know from this corpus?"
            autoFocus
            aria-label="Corpus query"
            className="flex-1 outline-none px-2.5 text-[13px]"
            style={{
              background: 'var(--fill-quaternary)',
              boxShadow: 'inset 0 0 0 0.5px var(--separator)',
              border: 0,
              borderRadius: 'var(--radius-input)',
              height: 28,
              color: 'var(--label)',
              fontFamily: 'inherit',
            }}
            disabled={pending}
          />
          <Button
            type="submit"
            size="large"
            variant="prominent"
            disabled={pending || !query.trim()}
          >
            {pending ? 'Searching…' : 'Search'}
          </Button>
        </form>

        {error && (
          <div
            role="alert"
            className="flex items-center gap-1.5 text-[13px] leading-4"
            style={{ color: 'var(--status-red)' }}
          >
            <Icon name="warning" size={14} />
            {error}
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span
                className="text-[11px] leading-[13px] tabular-nums"
                style={{ color: 'var(--label-secondary)' }}
              >
                ~{result.tokens_used.toLocaleString()} tokens
              </span>
              <Button size="small" icon={copied ? 'check' : 'content_copy'} onClick={handleCopy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre
              className="text-[12px] leading-[16px] whitespace-pre-wrap overflow-auto"
              style={{
                background: 'var(--fill-quaternary)',
                borderRadius: 'var(--radius-input)',
                padding: '8px 10px',
                color: 'var(--label)',
                maxHeight: 320,
                boxShadow: 'inset 0 0 0 0.5px var(--separator)',
                fontFamily: 'var(--font-mono)',
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

function CorporaView({ root, subTab }: { root: string; subTab?: ReactNode }) {
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
    <ViewShell
      subTab={subTab}
      status={
        loading
          ? 'Loading…'
          : `${corpora.length.toLocaleString()} corpus${corpora.length === 1 ? '' : 'es'}`
      }
    >
      {queryCorpus && (
        <CorpusQueryModal
          corpusName={queryCorpus}
          root={root}
          onClose={() => setQueryCorpus(null)}
        />
      )}

      <Section title="Corpora">
        <Card>
          {loading && <SkeletonRows rows={3} />}

          {!loading && corpora.length === 0 && (
            <EmptyState
              compact
              icon="database"
              title="No corpora yet"
              subtitle="A corpus is a saved slice of this codebase an assistant can pull in one call. Build one with the build_corpus tool."
            />
          )}

          {!loading &&
            corpora.map((c, i) => {
              const isLast = i === corpora.length - 1;
              return (
                <div
                  key={c.name}
                  className="px-3 py-2.5"
                  style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--separator)' }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className="text-[13px] leading-4 font-medium"
                          style={{ color: 'var(--label)', fontFamily: 'var(--font-mono)' }}
                        >
                          {c.name}
                        </span>
                        <Badge tone="neutral">{c.scope}</Badge>
                      </div>

                      {c.description && (
                        <div
                          className="text-[13px] leading-4"
                          style={{ color: 'var(--label-secondary)' }}
                        >
                          {c.description}
                        </div>
                      )}

                      {(c.featureQuery || c.modulePath) && (
                        <div
                          className="text-[11px] leading-[13px] truncate"
                          style={{
                            color: 'var(--label-secondary)',
                            fontFamily: 'var(--font-mono)',
                          }}
                          title={c.featureQuery ?? c.modulePath}
                        >
                          {c.featureQuery ?? c.modulePath}
                        </div>
                      )}

                      <div
                        className="flex items-center gap-3 flex-wrap text-[11px] leading-[13px] tabular-nums"
                        style={{ color: 'var(--label-secondary)' }}
                      >
                        <span>
                          {c.symbolCount.toLocaleString()} symbols · {c.fileCount.toLocaleString()}{' '}
                          files
                        </span>
                        <span>~{(c.tokenBudget / 1000).toFixed(0)}K token budget</span>
                        {c.sizeKB !== null && <span>{c.sizeKB} KB</span>}
                        <span>{formatDate(c.createdAt)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button variant="prominent" onClick={() => setQueryCorpus(c.name)}>
                        Query
                      </Button>
                      <CorpusDeleteButton
                        name={c.name}
                        pending={deletePending === c.name}
                        onDelete={() => void handleDelete(c.name)}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
        </Card>
      </Section>
    </ViewShell>
  );
}

/** Delete, behind a named confirmation popover. The old row put "Delete" and
    an inline "Confirm ✕" pair straight in the row at 11px. */
function CorpusDeleteButton({
  name,
  pending,
  onDelete,
}: {
  name: string;
  pending: boolean;
  onDelete: () => void;
}) {
  const confirm = useMenuAnchor();
  return (
    <>
      <Button
        ref={confirm.ref}
        variant="icon"
        icon="trash"
        disabled={pending}
        onClick={() => (confirm.at ? confirm.close() : confirm.open())}
        aria-label={`Delete corpus ${name}`}
        title={`Delete corpus ${name}`}
      />
      {confirm.at && (
        <ConfirmPopover
          x={confirm.at.x}
          y={confirm.at.y}
          align="end"
          danger
          title={`Delete corpus ${name}?`}
          body="The saved slice is removed. The code it points at is untouched, and you can rebuild it."
          confirmLabel={pending ? 'Deleting…' : 'Delete corpus'}
          onConfirm={() => {
            onDelete();
            confirm.close();
          }}
          onCancel={confirm.close}
        />
      )}
    </>
  );
}

function SessionsView({ root, subTab }: { root: string; subTab?: ReactNode }) {
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
    <ViewShell
      subTab={subTab}
      status={
        loading
          ? 'Loading…'
          : `${sessions.length.toLocaleString()} session${sessions.length === 1 ? '' : 's'}`
      }
    >
      <Section title="Mined sessions">
        <Card>
          {loading && <SkeletonRows rows={4} />}

          {!loading && sessions.length === 0 && (
            <EmptyState
              compact
              icon="history"
              title="No sessions mined yet"
              subtitle="Mining reads past assistant transcripts for decisions worth keeping. Run the mine_sessions tool to fill this list."
            />
          )}

          {!loading &&
            sessions.map((s, i) => {
              const isLast = i === sessions.length - 1;
              return (
                <div
                  key={s.session_path}
                  className="px-3 py-2.5"
                  style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--separator)' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <div
                        className="text-[13px] leading-4 truncate"
                        style={{ color: 'var(--label)', fontFamily: 'var(--font-mono)' }}
                        title={s.session_path}
                      >
                        {shortPath(s.session_path)}
                      </div>
                      <div
                        className="text-[11px] leading-[13px] tabular-nums"
                        style={{ color: 'var(--label-secondary)' }}
                      >
                        {formatDate(s.mined_at)}
                      </div>
                    </div>
                    {/* A count is the signal, so it is a number and a noun —
                        not a green-vs-grey colour swap on the same string. */}
                    <Badge tone={s.decisions_found > 0 ? 'green' : 'neutral'}>
                      {s.decisions_found} decision{s.decisions_found === 1 ? '' : 's'}
                    </Badge>
                  </div>
                </div>
              );
            })}
        </Card>
      </Section>
    </ViewShell>
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

  const confidenceTone: Tone =
    confidencePct >= 75 ? 'green' : confidencePct >= 50 ? 'orange' : 'red';

  return (
    <div className="px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[13px] leading-4 font-medium" style={{ color: 'var(--label)' }}>
          {decision.title}
        </span>
        <TypeBadge type={decision.type} />
        <SourceBadge source={decision.source} />
        <Badge tone="orange" icon="schedule">
          Awaiting review
        </Badge>
      </div>

      <div
        className="text-[13px] leading-[18px] whitespace-pre-wrap"
        style={{ color: 'var(--label-secondary)' }}
      >
        {decision.content}
      </div>

      {/* Confidence: a meter AND the number, so the tone is never the only
          thing carrying "how sure was the miner". */}
      <div className="flex items-center gap-2">
        <span
          className="text-[11px] leading-[13px] shrink-0"
          style={{ color: 'var(--label-secondary)' }}
        >
          Confidence
        </span>
        <div
          className="flex-1 overflow-hidden"
          style={{ height: 6, borderRadius: 3, background: 'var(--fill-quaternary)', maxWidth: 200 }}
        >
          <div
            style={{
              width: `${confidencePct}%`,
              height: '100%',
              borderRadius: 3,
              background: TONE_VAR[confidenceTone],
            }}
          />
        </div>
        <span
          className="text-[11px] leading-[13px] tabular-nums"
          style={{ color: 'var(--label)' }}
        >
          {confidencePct}%
        </span>
      </div>

      <div
        className="flex items-center gap-3 flex-wrap text-[11px] leading-[13px]"
        style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-mono)' }}
      >
        {decision.session_id && (
          <span className="truncate max-w-[180px]" title={`Session ${decision.session_id}`}>
            {decision.session_id.slice(0, 14)}…
          </span>
        )}
        {decision.file_path && (
          <span className="truncate max-w-[220px]" title={decision.file_path}>
            {decision.file_path}
          </span>
        )}
        {decision.git_branch && (
          <Badge tone="neutral" title={`Captured on branch ${decision.git_branch}`}>
            {decision.git_branch}
          </Badge>
        )}
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Badge key={tag} tone="neutral">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="prominent"
          icon="check"
          disabled={pending !== null}
          onClick={() => { void handle('approve')(); }}
        >
          {pending === 'approve' ? 'Approving…' : 'Approve'}
        </Button>
        <Button
          icon="close"
          disabled={pending !== null}
          onClick={() => { void handle('reject')(); }}
        >
          {pending === 'reject' ? 'Rejecting…' : 'Reject'}
        </Button>
        {error && (
          <span
            role="alert"
            className="text-[11px] leading-[13px] flex items-center gap-1"
            style={{ color: 'var(--status-red)' }}
          >
            <Icon name="warning" size={12} />
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
  subTab,
  onPendingCountChange,
}: {
  root: string;
  subTab?: ReactNode;
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
    <ViewShell
      subTab={subTab}
      status={
        loading
          ? 'Loading…'
          : `${decisions.length.toLocaleString()} awaiting review`
      }
    >
      {toast && (
        <div
          role="status"
          className="flex items-center gap-2 px-3 py-2 text-[13px] leading-4"
          style={{
            borderRadius: 10,
            background:
              toast.kind === 'error'
                ? 'color-mix(in oklab, var(--status-red) 12%, transparent)'
                : 'color-mix(in oklab, var(--status-green) 12%, transparent)',
            color: toast.kind === 'error' ? 'var(--status-red)' : 'var(--status-green)',
          }}
        >
          <Icon name={toast.kind === 'error' ? 'warning' : 'check'} size={14} />
          {toast.message}
        </div>
      )}

      <Section title="Review queue">
        <Card>
          {loading && <SkeletonRows rows={3} />}

          {!loading && decisions.length === 0 && (
            <EmptyState
              compact
              icon="done_all"
              title="Nothing to review"
              subtitle="Decisions mined from past sessions land here first, so you can approve or reject them before assistants read them back."
            />
          )}

          {!loading &&
            decisions.map((d, i) => {
              const isLast = i === decisions.length - 1;
              return (
                <div
                  key={d.id}
                  style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--separator)' }}
                >
                  <ReviewCard
                    decision={d}
                    onApprove={(id) => handleAction(id, 'approved')}
                    onReject={(id) => handleAction(id, 'rejected')}
                  />
                </div>
              );
            })}
        </Card>
      </Section>
    </ViewShell>
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

  const switcher = (
    <SegmentedControl
      className="shrink-0"
      options={tabs.map((t) => ({ value: t.key, label: t.label }))}
      value={activeTab}
      onChange={setActiveTab}
      aria-label="Memory section"
    />
  );

  return (
    <>
      {activeTab === 'decisions' && <DecisionsView root={root} subTab={switcher} />}
      {activeTab === 'review' && (
        <ReviewView root={root} subTab={switcher} onPendingCountChange={setPendingCount} />
      )}
      {activeTab === 'corpora' && <CorporaView root={root} subTab={switcher} />}
      {activeTab === 'sessions' && <SessionsView root={root} subTab={switcher} />}
    </>
  );
}
