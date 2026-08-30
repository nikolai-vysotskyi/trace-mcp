/**
 * Workspace — top-level shell for the unified Projects + Dashboard tab.
 *
 * Owns: filter, sort, view-mode, selection, daemon error UI.
 * Persists: view-mode + filter to localStorage so the user's preferences
 * survive across sessions.
 *
 * Renders:
 *   WorkspaceHeader (KPI cards · toolbar)
 *   ─ inline banner (recoverable metric failures) ─
 *   ─ active view (Table | Compact), or the skeleton / empty / error pane ─
 *   BulkActionsBar (floating, only when selection > 0)
 *
 * Every state keeps the chrome: a failed request never collapses the screen to
 * two centred lines. The KPI strip and the toolbar stay where they were, and
 * the pane below explains what happened next to the one action that fixes it.
 *
 * The surface also has to survive the smallest window the app allows
 * (640×420 — `main/tray.ts`). It watches its own pane rather than the window,
 * because the sidebar is resizable: below `TABLE_MIN_PANE_W` the table gives
 * way to Compact, and below `DENSE_PANE_H` the KPI tiles collapse to one line.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { t } from '../i18n';
import { formatNumber } from '../i18n/format';
import { Button, EmptyState } from '../lattice/ui';
import { addRecentProject, removeRecentProject } from '../recent-projects';
import { AddProjectControl } from './AddProjectControl';
import { BulkActionsBar } from './BulkActionsBar';
import { WorkspaceCompactView } from './WorkspaceCompactView';
import { WorkspaceHeader } from './WorkspaceHeader';
import { ROW_H, WorkspaceTableView } from './WorkspaceTableView';
import { SkeletonTableRows } from './components/Skeleton';
import {
  EMPTY_FILTER,
  type SortDir,
  type SortKey,
  type ViewMode,
  type WorkspaceFilter,
  applyFilter,
  compareViewModels,
  deriveKpis,
} from './types';
import { useSelection } from './useSelection';
import { useWorkspaceProjects } from './useWorkspaceProjects';

// ── LocalStorage persistence ──────────────────────────────────────────────

const LS_VIEW_KEY = 'trace-mcp.workspace.view';
const LS_FILTER_KEY = 'trace-mcp.workspace.filter';

function loadView(): ViewMode {
  try {
    const raw = localStorage.getItem(LS_VIEW_KEY);
    if (raw === 'table' || raw === 'compact' || raw === 'cards') return raw;
  } catch {
    // SSR / sandboxed renderer — ignore
  }
  return 'table';
}

function loadFilter(): WorkspaceFilter {
  try {
    const raw = localStorage.getItem(LS_FILTER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WorkspaceFilter>;
      return { ...EMPTY_FILTER, ...parsed };
    }
  } catch {
    // Corrupted JSON — fall back to defaults
  }
  return EMPTY_FILTER;
}

// ── Responding to the pane, not to the window ─────────────────────────────
//
// The sidebar is user-resizable (180–320px) and collapsible, so window width
// tells you very little about how much room this surface actually has. Both
// thresholds are read off the pane itself.

// Pane and strip geometry, all read off the rendered surface rather than guessed.
const TILE_MIN_W = 132; // KpiTile's flex basis
const TILE_GAP = 16; // gap-4
// A full-height tile: 16 + 13 + 4 + 32 + 4 + 26 + 16 + hairlines. The comparison
// line reserves two 13px lines rather than one, because at 132–214px of tile a
// criterion or a long translation wraps and a one-line constant would then
// under-report the strip by 13px a row (TRA-459).
const TILE_H = 112;
const STRIP_PAD = 28; // pt-4 + pb-3
const TOOLBAR_H = 52;
const PANE_PAD = 32; // px-4, both sides
const KPI_COUNT = 6;

/** Table columns that are pinned and never scroll: checkbox, Project, Actions. */
const FROZEN_COLS_W = 32 + 240 + 100;
/** Narrower than this and the scroll window shows less than one whole column. */
const MIN_SCROLL_WINDOW = 160;

/**
 * Below this pane width the table has nowhere to live. Its frozen columns never
 * scroll, so what is left is the entire window onto 1025px of table. At a 420px
 * pane that window is 15px wide and the pinned Actions cell paints over the
 * Status dot, leaving status as half a coloured dot with no word.
 */
export const TABLE_MIN_PANE_W = PANE_PAD + FROZEN_COLS_W + MIN_SCROLL_WINDOW;

/**
 * How many tiles go in a row at this pane width — always a divisor of
 * `KPI_COUNT`, so every row is full.
 *
 * The strip used to be a wrapping flexbox of `flex: 1 1 132px` tiles, which
 * packs as many as fit and then stretches whatever landed in the last row
 * across the leftover width. Measured in the Electron window at a 1000px window:
 * five tiles at 137px and the sixth at 748px, carrying the same three lines of
 * content (TRA-467). A dashboard card is one size; only the column count
 * responds to width. Restricting the count to a divisor of six is what removes
 * the ragged last row that the stretching existed to hide.
 *
 * `0` is an unmeasured pane on first paint. It falls through to one column —
 * the same six-row answer the old `Math.max(1, …)` gave — so the first frame is
 * unchanged.
 */
export function kpiColumns(paneW: number): number {
  const inner = Math.max(0, paneW - PANE_PAD);
  const fits = (n: number) => n * TILE_MIN_W + (n - 1) * TILE_GAP <= inner;
  return [6, 3, 2].find(fits) ?? 1;
}

/**
 * How tall the full-height KPI strip would be in a pane this wide. Width decides
 * the column count and so how many rows of 112px there are — at the app's 640px
 * minimum window that is three rows, 396px.
 *
 * This reads `kpiColumns()` rather than repeating the packing rule: a layout
 * number written twice is how the top band ended up 3px out of true (DESIGN.md,
 * "The top band").
 */
export function kpiStripHeight(paneW: number): number {
  const rows = KPI_COUNT / kpiColumns(paneW);
  return rows * TILE_H + (rows - 1) * TILE_GAP + STRIP_PAD;
}

/** A pane too narrow for the table. `0` means "not measured yet" — assume wide. */
export function isNarrowPane(width: number): boolean {
  return width > 0 && width < TABLE_MIN_PANE_W;
}

/**
 * True when full-height tiles would leave less than two project rows. The strip
 * is the only part of this surface that can give height back, and it has to,
 * because nothing here scrolls: at 640×420 the strip was 357px of a 376px pane,
 * which put the toolbar 33px past the window bottom and the list at 1px tall
 * with no scroll container anywhere to recover either (TRA-325).
 */
export function isDensePane(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return height - TOOLBAR_H - kpiStripHeight(width) < 2 * ROW_H;
}

// ── Open handler (cross-window IPC) ───────────────────────────────────────

function openProjectWindow(root: string): void {
  addRecentProject(root);
  window.electronAPI?.openProjectTab(root).catch(() => {
    /* ignore — Menu window will still navigate via internal state if any */
  });
}

// ── Panes ────────────────────────────────────────────────────────────────

/**
 * The one line for "the daemon is busy" (TRA-397).
 *
 * Two halves, each decided by something the reader can see for themselves.
 * The first says what the daemon is doing: with the feed up we know, and with
 * it down we say "busy" rather than guessing at indexing. The second describes
 * the numbers next to it, so it has to follow whether there are any — telling
 * someone they are looking at the last indexed numbers over a row of em dashes
 * is the same lie the old copy told, in the other direction.
 */
export function busyMessage(o: {
  connected: boolean;
  indexing: number;
  total: number;
  haveNumbers: boolean;
}): string {
  /* Four whole sentences in the catalogue rather than a lead and a tail glued
     together here: the halves inflect together in the languages that inflect. */
  if (o.connected && o.indexing > 0) {
    const key = o.haveNumbers ? 'workspace:busyIndexingStale' : 'workspace:busyIndexingFresh';
    return t(key, {
      count: o.total,
      indexing: formatNumber(o.indexing),
      total: formatNumber(o.total),
    });
  }
  return t(o.haveNumbers ? 'workspace:busyStale' : 'workspace:busyFresh');
}

/** The pane shown when the daemon is not answering at all. */
function DaemonDownPane({ restarting, onRestart }: { restarting: boolean; onRestart: () => void }) {
  const { t } = useTranslation('workspace');
  return (
    <EmptyState
      icon="cable"
      iconSize={32}
      title={t('daemonDownTitle')}
      subtitle={t('daemonDownSubtitle')}
      action={
        <Button variant="prominent" size="large" onClick={onRestart} disabled={restarting}>
          {restarting ? t('startingDaemon') : t('startDaemon')}
        </Button>
      }
    />
  );
}

// ── Main ──────────────────────────────────────────────────────────────────

export function Workspace() {
  const { t } = useTranslation('workspace');
  const data = useWorkspaceProjects();

  // ── UI state ─────────────────────────────────────────────────────────
  const [view, setView] = useState<ViewMode>(() => loadView());
  const [filter, setFilter] = useState<WorkspaceFilter>(() => loadFilter());
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(LS_VIEW_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_FILTER_KEY, JSON.stringify(filter));
    } catch {
      /* ignore */
    }
  }, [filter]);

  // ── Derived ──────────────────────────────────────────────────────────
  const filtered = useMemo(() => applyFilter(data.projects, filter), [data.projects, filter]);
  // Sort here, not inside a view: every view then renders the same order, and
  // switching Table ↔ Compact can't silently reshuffle the list.
  const visible = useMemo(
    () => [...filtered].sort((a, b) => compareViewModels(a, b, sortKey, sortDir)),
    [filtered, sortKey, sortDir],
  );
  const kpis = useMemo(() => deriveKpis(data.projects), [data.projects]);

  // ── Selection ────────────────────────────────────────────────────────
  const getId = useCallback((p: { root: string }) => p.root, []);
  const selection = useSelection<{ root: string }>(getId);

  // Drop selection for projects that disappeared from the merged list.
  useEffect(() => {
    if (selection.count === 0) return;
    const present = new Set(data.projects.map((p) => p.root));
    let dirty = false;
    selection.selected.forEach((root) => {
      if (!present.has(root)) {
        selection.set(root, false);
        dirty = true;
      }
    });
    void dirty; // exhaustive-deps placeholder; we intentionally only re-run on data.projects change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.projects]);

  const handleSort = useCallback(
    (k: SortKey) => {
      if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setSortKey(k);
        setSortDir('asc');
      }
    },
    [sortKey],
  );

  const handleScroll = useCallback((top: number) => setScrolled(top > 0), []);

  // ── Pane size ────────────────────────────────────────────────────────
  const paneRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ w: 0, h: 0 });
  /* Measured before the browser paints, not after. A ResizeObserver first
     reports on the frame AFTER the initial commit, so the first frame would be
     laid out at `pane.w = 0` — and now that the KPI strip's column count is
     read off the pane, zero means one column. Sampled every rAF in the Electron
     window at 1000×800: the first painted frame was 1 column of 748px tiles in
     a 780px strip, settling to 3 × 239px in a 268px strip ~5ms later. That is
     the exact geometry TRA-467 removed, plus a 512px jump that starts the
     project list below the window edge, on every launch. */
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const w = Math.round(box.width);
    const h = Math.round(box.height);
    setPane((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);
  useEffect(() => {
    const el = paneRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const w = Math.round(box.width);
      const h = Math.round(box.height);
      setPane((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = isNarrowPane(pane.w);
  const dense = isDensePane(pane.w, pane.h);
  const kpiCols = kpiColumns(pane.w);
  // The stored preference is never rewritten: widening the window has to bring
  // the user's own choice back, not whatever the narrow layout fell back to.
  const effectiveView: ViewMode = narrow ? 'compact' : view;

  // ── Render ───────────────────────────────────────────────────────────
  // Two states, not four. `unreachable` takes the pane and offers the process
  // to start; `stale` keeps every number where it is and says once that they
  // are a snapshot. A slow daemon is never allowed to reach the first branch.
  const daemonDown = data.daemonState === 'unreachable';
  const showEmpty = !data.loading && !daemonDown && data.projects.length === 0;
  const selectedProjects = visible.filter((p) => selection.selected.has(p.root));
  // One diagnosis at a time. When DaemonDownPane has taken over the pane it
  // already says what happened and offers the fix, so the banner stays out of
  // the way — two sentences about the same daemon is what this looked like
  // before (TRA-397).
  const banner = daemonDown
    ? null
    : // A mutation that failed said something specific and actionable; that
      // outranks "the numbers are a moment old".
      data.error
      ? { message: data.error }
      : data.daemonState === 'stale'
        ? {
            message: busyMessage({
              connected: data.connected,
              indexing: kpis.indexing,
              total: kpis.totalProjects,
              haveNumbers: !data.metricsLoading,
            }),
          }
        : null;

  const viewProps = {
    projects: visible,
    selected: selection.selected,
    canMutate: data.connected,
    onSelectChange: selection.set,
    onOpen: openProjectWindow,
    onReindex: (r: string) => void data.reindexProject(r),
    onRemove: (r: string) => {
      removeRecentProject(r);
      void data.removeProject(r);
    },
    onScroll: handleScroll,
  };

  return (
    <div ref={paneRef} className="flex flex-col h-full overflow-hidden relative">
      <WorkspaceHeader
        kpis={kpis}
        metricsLoading={data.metricsLoading && data.errorKind === null}
        listLoading={data.loading}
        // Em dashes are for a number nobody has, not for a number that is a
        // few minutes old: `metricsLoading` is already false whenever a
        // snapshot was restored, so this only fires on a cold, failed start.
        metricsFailed={data.metricsLoading && data.errorKind !== null}
        listFailed={daemonDown}
        filter={filter}
        onFilterChange={setFilter}
        view={view}
        onViewChange={setView}
        onRefresh={() => void data.refresh()}
        refreshing={data.refreshing}
        scrolled={scrolled}
        dense={dense}
        kpiColumns={kpiCols}
        hideViewToggle={narrow}
        rightExtra={<AddProjectControl onAdd={(root) => data.addProject(root)} />}
        // Above the tiles, not below them: the line that says these numbers
        // are a snapshot has to be read before the numbers are.
        banner={
          banner && (
            <div
              role="status"
              className="mx-4 mt-3 px-3 py-2 rounded-lg text-[13px] flex items-center gap-2"
              style={{
                background: 'color-mix(in srgb, var(--status-orange) 9%, transparent)',
                color: 'var(--label)',
                border: '0.5px solid color-mix(in srgb, var(--status-orange) 30%, transparent)',
              }}
            >
              <span>{banner.message}</span>
              {/* The action belongs next to the sentence that needs it, not
                  1400px away at the far right of the window. Restarting the
                  daemon is not offered here — a busy daemon does not need
                  restarting, and one that is actually down has its own pane. */}
              <Button size="small" onClick={() => void data.refresh()} disabled={data.refreshing}>
                {data.refreshing ? t('retrying') : t('tryAgain')}
              </Button>
            </div>
          )
        }
      />

      <div className="flex-1 min-h-0 flex flex-col px-4 pb-4 pt-3">
        {daemonDown ? (
          <DaemonDownPane restarting={data.restarting} onRestart={() => void data.restartDaemon()} />
        ) : data.loading ? (
          // Skeletons at the final row geometry — nothing moves when data lands.
          <div
            className="flex-1 overflow-hidden"
            style={{ borderRadius: 12, border: '0.5px solid var(--separator)', background: 'var(--surface)' }}
          >
            <SkeletonTableRows rows={12} rowHeight={ROW_H} />
          </div>
        ) : showEmpty ? (
          <div className="flex-1 overflow-auto">
            <AddProjectControl variant="empty-state" onAdd={(root) => data.addProject(root)} />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="search"
            iconSize={32}
            title={t('noMatchTitle')}
            subtitle={t('noMatchSubtitle')}
            action={
              <Button variant="prominent" size="large" onClick={() => setFilter(EMPTY_FILTER)}>
                {t('clearFilters')}
              </Button>
            }
          />
        ) : effectiveView === 'compact' ? (
          <WorkspaceCompactView {...viewProps} />
        ) : (
          <WorkspaceTableView
            {...viewProps}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            onSelectAll={(next) => {
              if (next) selection.selectAll(visible);
              else selection.clear();
            }}
          />
        )}
      </div>

      <BulkActionsBar
        projects={selectedProjects}
        onReindex={(roots) => data.reindexMany(roots)}
        onRemove={async (roots) => {
          for (const r of roots) removeRecentProject(r);
          await data.removeMany(roots);
          selection.clear();
        }}
        onClear={() => selection.clear()}
      />
    </div>
  );
}
