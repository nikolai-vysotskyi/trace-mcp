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
import { Icon } from '../lattice/icons';
import { Button, Chip, ChipGroup, SearchField, SegmentedControl } from '../lattice/ui';
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
  /** Metric-backed KPI tiles show a placeholder instead of `0` while true. */
  metricsLoading?: boolean;
  filter: WorkspaceFilter;
  onFilterChange: (next: WorkspaceFilter) => void;
  view: ViewMode;
  onViewChange: (next: ViewMode) => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** Slot rendered at the end of the toolbar row (typically AddProjectControl). */
  rightExtra?: ReactNode;
}

const STATUS_CHIPS: Array<{ key: ProjectHealthStatus; label: string; title: string }> = [
  { key: 'ok', label: 'OK', title: 'Projects that indexed cleanly' },
  { key: 'indexing', label: 'Indexing', title: 'Projects currently being indexed' },
  { key: 'error', label: 'Error', title: 'Projects whose last index failed' },
];
const GRADE_CHIPS: TechDebtGrade[] = ['A', 'B', 'C', 'D', 'F'];
const VIEW_OPTIONS: Array<{ value: ViewMode; label: string }> = [
  { value: 'table', label: 'Table' },
  { value: 'compact', label: 'Compact' },
];

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
  /** Render a placeholder instead of `value` — the number isn't known yet. */
  pending?: boolean;
}

function KpiCell({
  label,
  value,
  compact = false,
  active = false,
  onClick,
  accent,
  pending = false,
}: KpiCellProps) {
  const interactive = onClick !== undefined;
  const color =
    accent === 'ok'
      ? 'var(--success)'
      : accent === 'warn'
      ? 'var(--warning)'
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
        style={{ color: active ? '#fff' : pending ? 'var(--text-tertiary)' : color }}
      >
        {/* ponytail: em dash, not a shimmer block — same box, no digit, no CSS. */}
        {pending ? '—' : compact ? formatCompact(value) : value.toLocaleString()}
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
  metricsLoading = false,
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
          <KpiCell label="Files" value={kpis.totalFiles} compact pending={metricsLoading} />
          <KpiCell label="Symbols" value={kpis.totalSymbols} compact pending={metricsLoading} />
          <KpiCell
            label="Healthy"
            value={kpis.healthy}
            accent="ok"
            pending={metricsLoading}
            active={filter.preset === 'healthy'}
            onClick={() => togglePreset('healthy')}
          />
          <KpiCell
            label="Needs attention"
            value={kpis.needsAttention}
            accent="warn"
            pending={metricsLoading}
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
          <SearchField
            value={queryDraft}
            onChange={setQueryDraft}
            placeholder="Search projects"
            aria-label="Search projects"
          />

          <ChipGroup label="Status">
            {STATUS_CHIPS.map((c) => (
              <Chip
                key={c.key}
                label={c.label}
                title={c.title}
                selected={filter.statuses?.includes(c.key) ?? false}
                onClick={() => onFilterChange({ ...filter, statuses: toggleInList(filter.statuses, c.key) })}
              />
            ))}
          </ChipGroup>

          {/* Bare `A B C D F` is unreadable without the group label. */}
          <ChipGroup label="Grade">
            {GRADE_CHIPS.map((g) => (
              <Chip
                key={g}
                label={g}
                selected={filter.grades?.includes(g) ?? false}
                onClick={() => onFilterChange({ ...filter, grades: toggleInList(filter.grades, g) })}
                title={`Tech debt grade ${g}`}
                aria-label={`Tech debt grade ${g}`}
              />
            ))}
          </ChipGroup>

          <Chip
            label={<><Icon name="lock" size={12} /> Security</>}
            selected={filter.hasSecurityFindings === true}
            onClick={() =>
              onFilterChange({
                ...filter,
                hasSecurityFindings: filter.hasSecurityFindings === true ? null : true,
              })
            }
            title="Projects with critical or high security findings"
          />
          <Chip
            label={<><Icon name="bug_report" size={12} /> Dead</>}
            selected={filter.hasDeadExports === true}
            onClick={() =>
              onFilterChange({
                ...filter,
                hasDeadExports: filter.hasDeadExports === true ? null : true,
              })
            }
            title="Projects with dead exports"
          />

          {!isDefaultFilter(filter) && (
            <Button variant="plain" onClick={() => onFilterChange(EMPTY_FILTER)}>
              Clear filters
            </Button>
          )}

          <span className="ml-auto flex items-center gap-2">
            <SegmentedControl
              options={VIEW_OPTIONS}
              value={view}
              onChange={onViewChange}
              aria-label="View mode"
            />
            <Button
              variant="bordered"
              disabled={refreshing}
              onClick={onRefresh}
              title="Refresh metrics"
            >
              {refreshing ? <Spinner /> : 'Refresh'}
            </Button>
            {rightExtra}
          </span>
        </div>
      </div>
    </>
  );
}
