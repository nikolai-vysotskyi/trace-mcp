/**
 * WorkspaceHeader — dashboard strip + toolbar of the unified Workspace tab.
 *
 * Layout, top to bottom — chrome first, then content (DESIGN.md §6):
 *  Toolbar  — glass row, 52px on one line, holding search, one Filter pop-up,
 *             the view toggle, the single prominent action (+ Add) and an
 *             overflow menu. Everything else lives in that menu: the ceiling is
 *             four actions plus search, not thirteen controls in a row. It
 *             wraps rather than clipping — at a 420px pane the trailing group
 *             used to run 51px past the window with nothing to scroll, which
 *             put + Add's chevron and the overflow menu out of reach entirely.
 *  KPI grid — six content cards, each in card anatomy (label → value →
 *             comparison). Opaque, hairline, no shadow, no glass. `dense`
 *             collapses each to a 36px line when the pane cannot afford 112px.
 *
 * Receives all data + state via props; does not call useWorkspaceProjects.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { t } from '../i18n';
import { formatNumber, relativeTime } from '../i18n/format';
import { Icon } from '../lattice/icons';
import {
  Button,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  SearchField,
  SegmentedControl,
  Toolbar,
  useMenuAnchor,
} from '../lattice/ui';
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
import { type KpiBaseline, loadBaseline, rollBaseline, saveBaseline } from './kpiBaseline';

export interface WorkspaceHeaderProps {
  kpis: WorkspaceKpis;
  /** Metric-backed KPI tiles show skeletons instead of `0` while true. */
  metricsLoading?: boolean;
  /**
   * The daemon's project LIST hasn't landed yet. Projects and Indexing are
   * derived from that list rather than from metrics, so without this they
   * render a confident `0` for a number nobody knows yet.
   */
  listLoading?: boolean;
  /**
   * The metrics request finished and failed. Distinct from `metricsLoading`:
   * a skeleton says "still coming", and this says "not coming".
   */
  metricsFailed?: boolean;
  /**
   * The project list itself is unavailable (daemon down). Without this the
   * list-derived tiles read `0` and the baseline turns a dead connection into
   * "↓ −12 vs today", i.e. reports a lost connection as lost projects.
   */
  listFailed?: boolean;
  filter: WorkspaceFilter;
  onFilterChange: (next: WorkspaceFilter) => void;
  view: ViewMode;
  onViewChange: (next: ViewMode) => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** True once the content pane is scrolled — fades in the scroll-edge hairline. */
  scrolled?: boolean;
  /** Collapse the KPI tiles to one line each — see {@link KpiTileProps.dense}. */
  dense?: boolean;
  /**
   * How many tiles per row, from `kpiColumns()` in Workspace.tsx — always a
   * divisor of six, so every row is full and every tile is the same width.
   * Defaults to three for a standalone render with no pane to measure.
   */
  kpiColumns?: number;
  /** The pane is too narrow for the table, so Compact is the only view. */
  hideViewToggle?: boolean;
  /** Slot rendered at the end of the toolbar row (typically AddProjectControl). */
  rightExtra?: ReactNode;
  /**
   * Slot between the toolbar and the KPI grid, for the line that qualifies the
   * numbers below it — "these are the last indexed numbers". Below the grid it
   * would be a footnote to figures the reader has already believed (TRA-397).
   */
  banner?: ReactNode;
}

/* Built per render rather than at module scope: a language switch has to
   relabel the filter menu and the view toggle without a reload. */
const statusChips = (): Array<{ key: ProjectHealthStatus; label: string; title: string }> => [
  { key: 'ok', label: t('workspace:statusOk'), title: t('workspace:filterStatusOkTitle') },
  {
    key: 'indexing',
    label: t('workspace:statusIndexing'),
    title: t('workspace:filterStatusIndexingTitle'),
  },
  { key: 'error', label: t('workspace:statusError'), title: t('workspace:filterStatusErrorTitle') },
];
const GRADE_CHIPS: TechDebtGrade[] = ['A', 'B', 'C', 'D', 'F'];
const viewOptions = (): Array<{ value: ViewMode; label: string }> => [
  { value: 'table', label: t('workspace:viewTable') },
  { value: 'compact', label: t('workspace:viewCompact') },
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

/**
 * `n` as a share of `total`, e.g. "36% of 116 projects".
 *
 * Only for a metric that really is a subset of the workspace — Indexing is a
 * state every project is either in or not. Healthy and Needs attention are
 * overlapping predicates (a grade-B project with 15 dead exports is in both),
 * so a share reads as a partition it isn't: 57% + 83% of the same 53 projects
 * is impossible arithmetic on the face of the strip (TRA-459). Those two name
 * their criterion instead.
 */
function share(n: number, total: number): string {
  if (total === 0) return t('workspace:kpiNoProjectsYet');
  return t('workspace:kpiShare', {
    count: total,
    percent: Math.round((n / total) * 100),
    total: formatNumber(total),
  });
}

// ── Header ────────────────────────────────────────────────────────────────

export function WorkspaceHeader({
  kpis,
  metricsLoading = false,
  listLoading = false,
  metricsFailed = false,
  listFailed = false,
  filter,
  onFilterChange,
  view,
  onViewChange,
  onRefresh,
  refreshing,
  scrolled = false,
  dense = false,
  kpiColumns = 3,
  hideViewToggle = false,
  rightExtra,
  banner,
}: WorkspaceHeaderProps) {
  const { t } = useTranslation('workspace');
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

  // Baseline for the delta chips. Rolled once, after a reading somebody
  // actually has — snapshotting zeros would invent a huge delta.
  //
  // All four states, not just `metricsLoading` (TRA-458). That one is false the
  // moment the request FAILS (`Workspace.tsx` passes `metricsLoading &&
  // errorKind === null`), and it says nothing about the project LIST that
  // Projects and Indexing are derived from. One launch with the daemon down
  // stored all zeros and the dashboard then reported the entire workspace —
  // "↑ +53 projects, ↑ +656.2k symbols vs 5 hours ago" — as this afternoon's
  // growth, for the next 24 hours.
  const [baseline, setBaseline] = useState<KpiBaseline | null>(null);
  const rolled = useRef(false);
  useEffect(() => {
    if (metricsLoading || listLoading || metricsFailed || listFailed || rolled.current) return;
    rolled.current = true;
    const { previous, next } = rollBaseline(Date.now(), loadBaseline(), kpis);
    setBaseline(previous);
    if (next) saveBaseline(next);
  }, [metricsLoading, listLoading, metricsFailed, listFailed, kpis]);

  const deltaCaption = useMemo(
    () =>
      baseline
        ? t('kpiDeltaCaption', { when: relativeTime(Date.parse(baseline.at), Date.now()) })
        : undefined,
    [baseline, t],
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
      {/* ── Toolbar ────────────────────────────────────────────────── */}
      {/* Chrome sits above content (DESIGN.md §6). With the KPI strip first, a
          357px block of cards pushed the toolbar past the bottom of a 420px
          window and nothing could scroll it back (TRA-325). */}
      {/* Ceiling is search + 4 actions. Everything else is in the two menus. */}
      <Toolbar scrolled={scrolled}>
        <SearchField
          value={queryDraft}
          onChange={setQueryDraft}
          placeholder={t('searchProjects')}
          aria-label={t('searchProjects')}
        />

        <Button
          ref={filterMenu.ref}
          icon="tune"
          active={filterCount > 0}
          onClick={() => (filterMenu.at ? filterMenu.close() : filterMenu.open())}
          aria-haspopup="menu"
          aria-expanded={filterMenu.at !== null}
        >
          {t('filter')}
          {filterCount > 0 && <span className="tabular-nums">· {filterCount}</span>}
        </Button>

        <span className="ml-auto flex items-center gap-2">
          {/* Hidden, not disabled, while Table cannot fit: a toggle whose only
              other option is unusable is a control with nothing to choose. The
              stored preference is untouched and returns with the width. */}
          {!hideViewToggle && (
            <SegmentedControl
              aria-label={t('viewMode')}
              size="small"
              value={view === 'compact' ? 'compact' : 'table'}
              onChange={(v) => onViewChange(v as ViewMode)}
              options={viewOptions()}
            />
          )}
          {rightExtra}
          <Button
            ref={overflowMenu.ref}
            variant="icon"
            icon="more_horiz"
            onClick={() => (overflowMenu.at ? overflowMenu.close() : overflowMenu.open())}
            aria-haspopup="menu"
            aria-expanded={overflowMenu.at !== null}
            aria-label={t('moreActions')}
            title={t('moreActions')}
          />
        </span>
      </Toolbar>

      {banner}

      {/* ── KPI grid ───────────────────────────────────────────────── */}
      {/* A grid, not a wrapping flexbox. Flex-wrap stretches the last row's
          survivors across the leftover width, which at a 1000px window put one
          748px tile next to five 137px ones (TRA-467). Equal tracks, and a
          column count that divides six so no row is ever short. */}
      <div
        className="grid items-stretch gap-4 px-4 pt-4 pb-3"
        style={{ gridTemplateColumns: `repeat(${kpiColumns}, minmax(0, 1fr))` }}
      >
        <KpiTile
          label={t('kpiProjects')}
          value={kpis.totalProjects}
          dense={dense}
          pending={listLoading}
          unavailable={listFailed}
          delta={delta((k) => k.totalProjects)}
          deltaCaption={deltaCaption}
          footnote={t('kpiTrackingFromToday')}
          /* No `active`, no `onClick`. Projects is the workspace total, not a
             filter: lighting it when NO filter is on put the one mark that
             means "this filter is active" on a tile whose filter is not, above
             a list showing everything (TRA-475). Clearing stays reachable from
             the Filter menu, the overflow menu, and the lit preset tile. */
        />
        <KpiTile
          label={t('kpiFiles')}
          value={kpis.totalFiles}
          compact
          dense={dense}
          pending={metricsLoading}
          unavailable={metricsFailed}
          delta={delta((k) => k.totalFiles)}
          deltaCaption={deltaCaption}
          footnote={
            kpis.totalProjects > 0
              ? t('kpiPerProject', {
                  n: formatNumber(Math.round(kpis.totalFiles / kpis.totalProjects)),
                })
              : t('kpiNoProjectsYet')
          }
        />
        <KpiTile
          label={t('kpiSymbols')}
          value={kpis.totalSymbols}
          compact
          dense={dense}
          pending={metricsLoading}
          unavailable={metricsFailed}
          delta={delta((k) => k.totalSymbols)}
          deltaCaption={deltaCaption}
          footnote={
            kpis.totalFiles > 0
              ? t('kpiPerFile', { n: formatNumber(Math.round(kpis.totalSymbols / kpis.totalFiles)) })
              : t('kpiNothingIndexedYet')
          }
        />
        <KpiTile
          label={t('kpiHealthy')}
          value={kpis.healthy}
          tone="ok"
          dense={dense}
          pending={metricsLoading}
          unavailable={metricsFailed}
          footnote={
            kpis.totalProjects === 0 ? t('kpiNoProjectsYet') : t('kpiHealthyCriteria')
          }
          active={filter.preset === 'healthy'}
          onClick={() => togglePreset('healthy')}
        />
        <KpiTile
          label={t('kpiNeedsAttention')}
          value={kpis.needsAttention}
          tone="warn"
          dense={dense}
          pending={metricsLoading}
          unavailable={metricsFailed}
          footnote={
            kpis.totalProjects === 0 ? t('kpiNoProjectsYet') : t('kpiNeedsAttentionCriteria')
          }
          active={filter.preset === 'needs_attention'}
          onClick={() => togglePreset('needs_attention')}
        />
        <KpiTile
          label={t('kpiIndexing')}
          value={kpis.indexing}
          tone="busy"
          dense={dense}
          pending={listLoading}
          unavailable={listFailed}
          footnote={
            kpis.indexing === 0
              ? t('kpiNothingRunning')
              : share(kpis.indexing, kpis.totalProjects)
          }
          active={filter.preset === 'indexing'}
          onClick={() => togglePreset('indexing')}
        />
      </div>

      {filterMenu.at && (
        <Menu x={filterMenu.at.x} y={filterMenu.at.y} align="end" onClose={filterMenu.close}>
          <MenuSection>{t('filterStatus')}</MenuSection>
          {statusChips().map((s) => (
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
          <MenuSection>{t('filterGrade')}</MenuSection>
          {GRADE_CHIPS.map((g) => (
            <MenuItem
              key={g}
              showCheckSlot
              checked={filter.grades?.includes(g) ?? false}
              onClick={() => onFilterChange({ ...filter, grades: toggleInList(filter.grades, g) })}
            >
              {t('filterGradeItem', { grade: g })}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuSection>{t('filterFindings')}</MenuSection>
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
            {t('filterHasSecurityFindings')}
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
            {t('filterHasDeadExports')}
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
                {t('clearFilters')}
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
            {refreshing ? t('refreshingMetrics') : t('refreshMetrics')}
          </MenuItem>
          <MenuItem
            icon="close"
            disabled={isDefaultFilter(filter)}
            onClick={() => {
              onFilterChange(EMPTY_FILTER);
              overflowMenu.close();
            }}
          >
            {t('clearFilters')}
          </MenuItem>
        </Menu>
      )}
    </div>
  );
}
