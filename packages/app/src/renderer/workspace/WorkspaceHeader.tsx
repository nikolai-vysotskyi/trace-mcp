/**
 * WorkspaceHeader — top strip of the unified Workspace tab.
 *
 * Layout:
 *  Row 1 — KPI strip: Total · Files · Symbols · Healthy · Needs attention · Indexing
 *  Row 2 — Search input · status/grade/security/dead chips · Clear · View toggle · Refresh · {rightExtra}
 *
 * Receives all data + state via props; does not call useWorkspaceProjects.
 */
import { type ReactNode, useEffect, useState } from 'react';
import {
  EMPTY_FILTER,
  type ProjectHealthStatus,
  type TechDebtGrade,
  type ViewMode,
  type WorkspaceFilter,
  type WorkspaceFilterPreset,
  type WorkspaceKpis,
} from './types';

export interface WorkspaceHeaderProps {
  kpis: WorkspaceKpis;
  filter: WorkspaceFilter;
  onFilterChange: (next: WorkspaceFilter) => void;
  view: ViewMode;
  onViewChange: (next: ViewMode) => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** Slot rendered at the end of the toolbar row (typically AddProjectControl). */
  rightExtra?: ReactNode;
}

const STATUS_CHIPS: Array<{ key: ProjectHealthStatus; label: string }> = [
  { key: 'ok', label: 'OK' },
  { key: 'indexing', label: 'Indexing' },
  { key: 'error', label: 'Error' },
];
const GRADE_CHIPS: TechDebtGrade[] = ['A', 'B', 'C', 'D', 'F'];

function isDefaultFilter(f: WorkspaceFilter): boolean {
  return (
    f.query === '' &&
    f.statuses === null &&
    f.grades === null &&
    f.hasSecurityFindings === null &&
    f.hasDeadExports === null &&
    f.preset === null
  );
}

function toggleInList<T>(list: T[] | null, value: T): T[] | null {
  const set = new Set(list ?? []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  const arr = [...set];
  return arr.length === 0 ? null : arr;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

// ── KPI cell ──────────────────────────────────────────────────────────────

interface KpiCellProps {
  label: string;
  value: number;
  compact?: boolean;
  active?: boolean;
  onClick?: () => void;
  accent?: 'ok' | 'warn' | 'busy';
}

function KpiCell({ label, value, compact = false, active = false, onClick, accent }: KpiCellProps) {
  const interactive = onClick !== undefined;
  const color =
    accent === 'ok'
      ? '#34c759'
      : accent === 'warn'
      ? '#ff9f0a'
      : accent === 'busy'
      ? 'var(--accent)'
      : 'var(--text-primary)';
  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={onClick}
      className="flex flex-col items-start justify-center px-3 py-1.5 rounded-md transition-colors text-left"
      style={{
        background: active ? 'var(--accent)' : 'var(--bg-secondary)',
        border: `0.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        cursor: interactive ? 'pointer' : 'default',
        minWidth: 92,
      }}
    >
      <span
        className="text-base font-semibold tabular-nums leading-tight"
        style={{ color: active ? '#fff' : color }}
      >
        {compact ? formatCompact(value) : value.toLocaleString()}
      </span>
      <span
        className="text-[10px] font-medium leading-tight mt-0.5"
        style={{ color: active ? '#fff' : 'var(--text-tertiary)' }}
      >
        {label}
      </span>
    </button>
  );
}

// ── Chip ──────────────────────────────────────────────────────────────────

interface ChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
  accent?: string;
  title?: string;
}

function Chip({ label, active, onClick, accent, title }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="text-[11px] px-2 py-0.5 rounded-full font-medium transition-colors whitespace-nowrap"
      style={{
        background: active ? accent ?? 'var(--accent)' : 'var(--fill-control)',
        color: active ? '#fff' : 'var(--text-secondary)',
        border: `0.5px solid ${active ? accent ?? 'var(--accent)' : 'var(--border)'}`,
      }}
    >
      {label}
    </button>
  );
}

// ── View toggle ───────────────────────────────────────────────────────────

interface ViewToggleProps {
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
}

function ViewToggle({ view, onViewChange }: ViewToggleProps) {
  const opts: Array<{ key: ViewMode; label: string }> = [
    { key: 'table', label: 'Table' },
    { key: 'compact', label: 'Compact' },
  ];
  return (
    <div
      className="flex items-center rounded-md overflow-hidden"
      style={{ border: '0.5px solid var(--border)' }}
    >
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onViewChange(o.key)}
          className="text-[11px] px-2 py-1 font-medium transition-colors"
          style={{
            background: view === o.key ? 'var(--accent)' : 'transparent',
            color: view === o.key ? '#fff' : 'var(--text-secondary)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Spinner (local — inline CSS @keyframes is the renderer's spinner idiom) ──

function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        border: '1.5px solid var(--border)',
        borderTopColor: 'var(--accent)',
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
        verticalAlign: 'middle',
      }}
    />
  );
}

// ── Header ────────────────────────────────────────────────────────────────

export function WorkspaceHeader({
  kpis,
  filter,
  onFilterChange,
  view,
  onViewChange,
  onRefresh,
  refreshing,
  rightExtra,
}: WorkspaceHeaderProps) {
  // Locally-debounced search so typing doesn't spam upstream re-renders.
  const [queryDraft, setQueryDraft] = useState(filter.query);
  useEffect(() => {
    setQueryDraft(filter.query);
  }, [filter.query]);
  useEffect(() => {
    if (queryDraft === filter.query) return;
    const t = setTimeout(() => onFilterChange({ ...filter, query: queryDraft }), 200);
    return () => clearTimeout(t);
  }, [queryDraft, filter, onFilterChange]);

  const togglePreset = (preset: WorkspaceFilterPreset) => {
    onFilterChange({ ...filter, preset: filter.preset === preset ? null : preset });
  };

  return (
    <>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div className="flex flex-col gap-2 px-3 py-2 shrink-0">
        {/* ── Row 1: KPI strip ─────────────────────────────────────── */}
        <div className="flex items-stretch gap-2 flex-wrap">
          <KpiCell
            label="Projects"
            value={kpis.totalProjects}
            active={filter.preset === null && filter.statuses === null && filter.grades === null && filter.query === ''}
            onClick={() => onFilterChange(EMPTY_FILTER)}
          />
          <KpiCell label="Files" value={kpis.totalFiles} compact />
          <KpiCell label="Symbols" value={kpis.totalSymbols} compact />
          <KpiCell
            label="Healthy"
            value={kpis.healthy}
            accent="ok"
            active={filter.preset === 'healthy'}
            onClick={() => togglePreset('healthy')}
          />
          <KpiCell
            label="Needs attention"
            value={kpis.needsAttention}
            accent="warn"
            active={filter.preset === 'needs_attention'}
            onClick={() => togglePreset('needs_attention')}
          />
          <KpiCell
            label="Indexing"
            value={kpis.indexing}
            accent="busy"
            active={filter.preset === 'indexing'}
            onClick={() => togglePreset('indexing')}
          />
        </div>

        {/* ── Row 2: toolbar ──────────────────────────────────────── */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            placeholder="Search projects…"
            value={queryDraft}
            onChange={(e) => setQueryDraft(e.target.value)}
            className="text-xs px-2 py-1 rounded-md outline-none"
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              minWidth: 180,
            }}
          />

          <div className="flex items-center gap-1">
            {STATUS_CHIPS.map((s) => (
              <Chip
                key={s.key}
                label={s.label}
                active={filter.statuses?.includes(s.key) ?? false}
                onClick={() => onFilterChange({ ...filter, statuses: toggleInList(filter.statuses, s.key) })}
              />
            ))}
          </div>

          <div className="flex items-center gap-1">
            {GRADE_CHIPS.map((g) => (
              <Chip
                key={g}
                label={g}
                active={filter.grades?.includes(g) ?? false}
                onClick={() => onFilterChange({ ...filter, grades: toggleInList(filter.grades, g) })}
                title={`Filter by tech-debt grade ${g}`}
              />
            ))}
          </div>

          <Chip
            label="🔒 Security"
            active={filter.hasSecurityFindings === true}
            accent="#ff3b30"
            onClick={() =>
              onFilterChange({
                ...filter,
                hasSecurityFindings: filter.hasSecurityFindings === true ? null : true,
              })
            }
            title="Projects with critical or high security findings"
          />
          <Chip
            label="💀 Dead"
            active={filter.hasDeadExports === true}
            accent="#ff9f0a"
            onClick={() =>
              onFilterChange({
                ...filter,
                hasDeadExports: filter.hasDeadExports === true ? null : true,
              })
            }
            title="Projects with dead exports"
          />

          {!isDefaultFilter(filter) && (
            <button
              type="button"
              onClick={() => onFilterChange(EMPTY_FILTER)}
              className="text-[11px] px-1.5 py-0.5 rounded font-medium transition-colors hover:bg-[var(--bg-active)]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Clear filters
            </button>
          )}

          <span className="ml-auto flex items-center gap-2">
            <ViewToggle view={view} onViewChange={onViewChange} />
            <button
              type="button"
              disabled={refreshing}
              onClick={onRefresh}
              className="text-[11px] px-2 py-1 rounded font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{
                background: 'var(--fill-control)',
                color: 'var(--accent)',
                border: '0.5px solid var(--border)',
              }}
              title="Refresh metrics"
            >
              {refreshing ? <Spinner /> : 'Refresh'}
            </button>
            {rightExtra}
          </span>
        </div>
      </div>
    </>
  );
}
