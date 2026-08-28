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
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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

// ── Open handler (cross-window IPC) ───────────────────────────────────────

function openProjectWindow(root: string): void {
  addRecentProject(root);
  window.electronAPI?.openProjectTab(root).catch(() => {
    /* ignore — Menu window will still navigate via internal state if any */
  });
}

// ── Panes ────────────────────────────────────────────────────────────────

/** The pane shown when the daemon is not answering at all. */
function DaemonDownPane({ restarting, onRestart }: { restarting: boolean; onRestart: () => void }) {
  return (
    <EmptyState
      icon="cable"
      iconSize={32}
      title="The daemon isn't running"
      subtitle="trace-mcp indexes your projects in a local background service. Start it to see them again — nothing was lost."
      action={
        <Button variant="prominent" size="large" onClick={onRestart} disabled={restarting}>
          {restarting ? 'Starting…' : 'Start daemon'}
        </Button>
      }
    />
  );
}

// ── Main ──────────────────────────────────────────────────────────────────

export function Workspace() {
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

  // ── Render ───────────────────────────────────────────────────────────
  // The live feed being down does not mean there is nothing to show: the
  // metrics cache usually still has every project. Only take over the pane
  // when we genuinely have nothing to render.
  const disconnected = !data.connected && !data.loading;
  const daemonDown = disconnected && data.projects.length === 0;
  const showEmpty = !data.loading && !disconnected && data.projects.length === 0;
  const selectedProjects = visible.filter((p) => selection.selected.has(p.root));
  const banner = disconnected && !daemonDown
    ? {
        message: 'Live updates are off — the daemon stopped answering. These numbers are the last indexed snapshot.',
        action: 'restart' as const,
      }
    : data.error
      ? {
          // A busy daemon is not a broken one — say which, and offer the
          // action that matches. Retrying a timeout is right; restarting isn't.
          message: data.error,
          action: 'retry' as const,
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
    <div className="flex flex-col h-full overflow-hidden relative">
      <WorkspaceHeader
        kpis={kpis}
        metricsLoading={data.metricsLoading}
        filter={filter}
        onFilterChange={setFilter}
        view={view}
        onViewChange={setView}
        onRefresh={() => void data.refresh()}
        refreshing={data.refreshing}
        scrolled={scrolled}
        rightExtra={<AddProjectControl onAdd={(root) => data.addProject(root)} />}
      />

      {banner && (
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
          {/* The action belongs next to the sentence that needs it, not 1400px
              away at the far right of the window. */}
          {banner.action === 'restart' ? (
            <Button
              size="small"
              onClick={() => void data.restartDaemon()}
              disabled={data.restarting}
            >
              {data.restarting ? 'Starting…' : 'Start daemon'}
            </Button>
          ) : (
            <Button size="small" onClick={() => void data.refresh()} disabled={data.refreshing}>
              {data.refreshing ? 'Retrying…' : 'Try again'}
            </Button>
          )}
        </div>
      )}

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
            title="No projects match this filter"
            subtitle="Clear the filter to see all of your projects again."
            action={
              <Button variant="prominent" size="large" onClick={() => setFilter(EMPTY_FILTER)}>
                Clear filters
              </Button>
            }
          />
        ) : view === 'compact' ? (
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
