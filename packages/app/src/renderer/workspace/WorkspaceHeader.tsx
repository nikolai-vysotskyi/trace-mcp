/**
 * WorkspaceHeader — dashboard strip + toolbar of the unified Workspace tab.
 *
 * Layout:
 *  KPI grid — six content cards, each in card anatomy (label → value →
 *             comparison). Opaque, hairline, no shadow, no glass.
 *  Toolbar  — 52px glass row holding search, one Filter pop-up, the view
 *             toggle, the single prominent action (+ Add) and an overflow
 *             menu. Everything else lives in that menu: the ceiling is four
 *             actions plus search, not thirteen controls in a wrap-around row.
 *
 * Receives all data + state via props; does not call useWorkspaceProjects.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../lattice/icons';
import { Menu, MenuItem, MenuSection, MenuSeparator, SegmentedControl } from '../lattice/ui';
import { KpiTile } from './components/KpiTile';
import {
  EMPTY_FILTER,
  type ProjectHealthStatus,
  type TechDebtGrade,
  type ViewMode,
  type WorkspaceFilter,
  type WorkspaceFilterPreset,
  type WorkspaceKpis,
} from './types';
import { type KpiBaseline, describeAge, loadBaseline, rollBaseline, saveBaseline } from './kpiBaseline';

export interface WorkspaceHeaderProps {
  kpis: WorkspaceKpis;
  /** Metric-backed KPI tiles show skeletons instead of `0` while true. */
  metricsLoading?: boolean;
  filter: WorkspaceFilter;
  onFilterChange: (next: WorkspaceFilter) => void;
  view: ViewMode;
  onViewChange: (next: ViewMode) => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** True once the content pane is scrolled — fades in the scroll-edge hairline. */
  scrolled?: boolean;
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

/** How many filter facets are narrowing the list — shown on the Filter button. */
export function activeFilterCount(f: WorkspaceFilter): number {
  return (
    (f.statuses?.length ?? 0) +
    (f.grades?.length ?? 0) +
    (f.hasSecurityFindings === true ? 1 : 0) +
    (f.hasDeadExports === true ? 1 : 0) +
    (f.preset !== null ? 1 : 0)
  );
}

function toggleInList<T>(list: T[] | null, value: T): T[] | null {
  const set = new Set(list ?? []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  const arr = [...set];
  return arr.length === 0 ? null : arr;
}

/** `n` as a share of `total`, e.g. "36% of 116 projects". */
function share(n: number, total: number): string {
  if (total === 0) return 'no projects yet';
  return `${Math.round((n / total) * 100)}% of ${total.toLocaleString()} projects`;
}

// ── Toolbar bits ──────────────────────────────────────────────────────────

const TOOLBAR_BTN =
  'inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[11px] font-medium transition-colors';

/** Anchors a Menu under a toolbar button. */
function useMenuAnchor() {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    setAt(r ? { x: r.right, y: r.bottom + 4 } : { x: 0, y: 52 });
  };
  return { ref, at, open, close: () => setAt(null) };
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
  scrolled = false,
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

  // Baseline for the delta chips. Rolled once, after the first real metrics
  // land — snapshotting the zeros of a cold cache would invent a huge delta.
  const [baseline, setBaseline] = useState<KpiBaseline | null>(null);
  const rolled = useRef(false);
  useEffect(() => {
    if (metricsLoading || rolled.current) return;
    rolled.current = true;
    const { previous, next } = rollBaseline(Date.now(), loadBaseline(), kpis);
    setBaseline(previous);
    if (next) saveBaseline(next);
  }, [metricsLoading, kpis]);

  const deltaCaption = useMemo(
    () => (baseline ? `vs ${describeAge(baseline.at, Date.now())}` : undefined),
    [baseline],
  );
  const delta = (pick: (k: WorkspaceKpis) => number): number | null =>
    baseline ? pick(kpis) - pick(baseline.kpis) : null;

  const filterMenu = useMenuAnchor();
  const overflowMenu = useMenuAnchor();
  const filterCount = activeFilterCount(filter);

  const togglePreset = (preset: WorkspaceFilterPreset) => {
    onFilterChange({ ...filter, preset: filter.preset === preset ? null : preset });
  };

  return (
    <div className="flex flex-col shrink-0">
      {/* ── KPI grid ───────────────────────────────────────────────── */}
      <div className="flex items-stretch gap-4 px-4 pt-4 pb-3 flex-wrap">
        <KpiTile
          label="Projects"
          value={kpis.totalProjects}
          delta={delta((k) => k.totalProjects)}
          deltaCaption={deltaCaption}
          footnote="tracking from today"
          active={isDefaultFilter(filter)}
          onClick={() => onFilterChange(EMPTY_FILTER)}
        />
        <KpiTile
          label="Files"
          value={kpis.totalFiles}
          compact
          pending={metricsLoading}
          delta={delta((k) => k.totalFiles)}
          deltaCaption={deltaCaption}
          footnote={
            kpis.totalProjects > 0
              ? `${Math.round(kpis.totalFiles / kpis.totalProjects).toLocaleString()} per project`
              : 'no projects yet'
          }
        />
        <KpiTile
          label="Symbols"
          value={kpis.totalSymbols}
          compact
          pending={metricsLoading}
          delta={delta((k) => k.totalSymbols)}
          deltaCaption={deltaCaption}
          footnote={
            kpis.totalFiles > 0
              ? `${Math.round(kpis.totalSymbols / kpis.totalFiles).toLocaleString()} per file`
              : 'nothing indexed yet'
          }
        />
        <KpiTile
          label="Healthy"
          value={kpis.healthy}
          tone="ok"
          pending={metricsLoading}
          footnote={share(kpis.healthy, kpis.totalProjects)}
          active={filter.preset === 'healthy'}
          onClick={() => togglePreset('healthy')}
        />
        <KpiTile
          label="Needs attention"
          value={kpis.needsAttention}
          tone="warn"
          pending={metricsLoading}
          footnote={share(kpis.needsAttention, kpis.totalProjects)}
          active={filter.preset === 'needs_attention'}
          onClick={() => togglePreset('needs_attention')}
        />
        <KpiTile
          label="Indexing"
          value={kpis.indexing}
          tone="busy"
          footnote={
            kpis.indexing === 0 ? 'nothing running' : share(kpis.indexing, kpis.totalProjects)
          }
          active={filter.preset === 'indexing'}
          onClick={() => togglePreset('indexing')}
        />
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-2 px-4 shrink-0 ws-glass"
        style={{
          height: 52,
          // Scroll-edge effect: the hairline fades in only once content is
          // sliding under the toolbar. No permanent hard border.
          borderBottom: '0.5px solid transparent',
          borderBottomColor: scrolled ? 'var(--border)' : 'transparent',
          transition: 'border-bottom-color 200ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <label className="relative flex items-center" style={{ minWidth: 200 }}>
          <span
            className="absolute left-2 pointer-events-none inline-flex"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <Icon name="search" size={12} />
          </span>
          <input
            type="search"
            aria-label="Search projects"
            placeholder="Search projects"
            value={queryDraft}
            onChange={(e) => setQueryDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQueryDraft('');
            }}
            className="w-full h-6 pl-7 pr-2 rounded-full text-[13px] outline-none"
            style={{
              background: 'var(--fill-control)',
              color: 'var(--text-primary)',
              border: '0.5px solid var(--border)',
            }}
          />
        </label>

        <button
          ref={filterMenu.ref}
          type="button"
          onClick={() => (filterMenu.at ? filterMenu.close() : filterMenu.open())}
          className={TOOLBAR_BTN}
          aria-haspopup="menu"
          aria-expanded={filterMenu.at !== null}
          style={{
            background: filterCount > 0 ? 'var(--bg-active)' : 'var(--fill-control)',
            color: filterCount > 0 ? 'var(--accent)' : 'var(--text-secondary)',
            border: '0.5px solid var(--border)',
          }}
        >
          <Icon name="tune" size={12} />
          Filter
          {filterCount > 0 && <span className="tabular-nums">· {filterCount}</span>}
        </button>

        <span className="ml-auto flex items-center gap-2">
          <SegmentedControl
            aria-label="View mode"
            size="mini"
            value={view === 'compact' ? 'compact' : 'table'}
            onChange={(v) => onViewChange(v as ViewMode)}
            options={[
              { value: 'table', label: 'Table', title: 'Wide table with every metric' },
              { value: 'compact', label: 'Compact', title: 'One line per project' },
            ]}
          />
          {rightExtra}
          <button
            ref={overflowMenu.ref}
            type="button"
            onClick={() => (overflowMenu.at ? overflowMenu.close() : overflowMenu.open())}
            aria-haspopup="menu"
            aria-expanded={overflowMenu.at !== null}
            aria-label="More actions"
            title="More actions"
            className="inline-flex items-center justify-center w-6 h-6 rounded-full transition-colors"
            style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}
          >
            <Icon name="more_horiz" size={14} />
          </button>
        </span>
      </div>

      {filterMenu.at && (
        <Menu x={filterMenu.at.x} y={filterMenu.at.y} align="end" onClose={filterMenu.close}>
          <MenuSection>Status</MenuSection>
          {STATUS_CHIPS.map((s) => (
            <MenuItem
              key={s.key}
              showCheckSlot
              checked={filter.statuses?.includes(s.key) ?? false}
              onClick={() =>
                onFilterChange({ ...filter, statuses: toggleInList(filter.statuses, s.key) })
              }
            >
              {s.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuSection>Tech-debt grade</MenuSection>
          {GRADE_CHIPS.map((g) => (
            <MenuItem
              key={g}
              showCheckSlot
              checked={filter.grades?.includes(g) ?? false}
              onClick={() => onFilterChange({ ...filter, grades: toggleInList(filter.grades, g) })}
            >
              Grade {g}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuSection>Findings</MenuSection>
          <MenuItem
            showCheckSlot
            checked={filter.hasSecurityFindings === true}
            icon="lock"
            onClick={() =>
              onFilterChange({
                ...filter,
                hasSecurityFindings: filter.hasSecurityFindings === true ? null : true,
              })
            }
          >
            Has security findings
          </MenuItem>
          <MenuItem
            showCheckSlot
            checked={filter.hasDeadExports === true}
            icon="bug_report"
            onClick={() =>
              onFilterChange({
                ...filter,
                hasDeadExports: filter.hasDeadExports === true ? null : true,
              })
            }
          >
            Has dead exports
          </MenuItem>
          {!isDefaultFilter(filter) && (
            <>
              <MenuSeparator />
              <MenuItem
                icon="close"
                onClick={() => {
                  onFilterChange(EMPTY_FILTER);
                  filterMenu.close();
                }}
              >
                Clear filters
              </MenuItem>
            </>
          )}
        </Menu>
      )}

      {overflowMenu.at && (
        <Menu x={overflowMenu.at.x} y={overflowMenu.at.y} align="end" onClose={overflowMenu.close}>
          <MenuItem
            icon="refresh"
            shortcut="⌘R"
            disabled={refreshing}
            onClick={() => {
              onRefresh();
              overflowMenu.close();
            }}
          >
            {refreshing ? 'Refreshing metrics…' : 'Refresh metrics'}
          </MenuItem>
          <MenuItem
            icon="close"
            disabled={isDefaultFilter(filter)}
            onClick={() => {
              onFilterChange(EMPTY_FILTER);
              overflowMenu.close();
            }}
          >
            Clear filters
          </MenuItem>
        </Menu>
      )}
    </div>
  );
}
