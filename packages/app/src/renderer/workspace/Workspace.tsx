/**
 * Workspace — top-level shell for the unified Projects + Dashboard tab.
 *
 * Owns: filter, sort, view-mode, selection, daemon error UI.
 * Persists: view-mode + filter to localStorage so the user's preferences
 * survive across sessions.
 *
 * Renders:
 *   WorkspaceHeader (KPI strip · search · filter chips · view toggle · refresh · Add)
 *   ─ active view (Table | Compact) ─
 *   BulkActionsBar (floating, only when selection > 0)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AddProjectControl } from './AddProjectControl';
import { BulkActionsBar } from './BulkActionsBar';
import { WorkspaceCompactView } from './WorkspaceCompactView';
import { WorkspaceHeader } from './WorkspaceHeader';
import { WorkspaceTableView } from './WorkspaceTableView';
import {
  EMPTY_FILTER,
  type SortDir,
  type SortKey,
  type ViewMode,
  type WorkspaceFilter,
  applyFilter,
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
  window.electronAPI?.openProjectTab(root).catch(() => {
    /* ignore — Menu window will still navigate via internal state if any */
  });
}

// ── Disconnected banner ──────────────────────────────────────────────────

function DisconnectedBanner({ restarting, onRestart }: { restarting: boolean; onRestart: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
        Daemon not reachable
      </div>
      <button
        type="button"
        onClick={onRestart}
        disabled={restarting}
        className="text-[11px] px-4 py-1.5 rounded-lg font-medium transition-all"
        style={{
          background: 'var(--fill-control)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          color: 'var(--accent)',
          border: '0.5px solid var(--border)',
          boxShadow: 'var(--shadow-control)',
          cursor: restarting ? 'default' : 'pointer',
          opacity: restarting ? 0.6 : 1,
        }}
      >
        {restarting ? 'Starting…' : 'Restart Daemon'}
      </button>
    </div>
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

  // ── Render ───────────────────────────────────────────────────────────
  if (!data.connected && !data.loading) {
    return <DisconnectedBanner restarting={data.restarting} onRestart={() => void data.restartDaemon()} />;
  }

  const showEmpty = !data.loading && data.projects.length === 0;
  const selectedProjects = filtered.filter((p) => selection.selected.has(p.root));

  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      <WorkspaceHeader
        kpis={kpis}
        filter={filter}
        onFilterChange={setFilter}
        view={view}
        onViewChange={setView}
        onRefresh={() => void data.refresh()}
        refreshing={data.refreshing}
        rightExtra={<AddProjectControl onAdd={(root) => data.addProject(root)} />}
      />

      {data.error && (
        <div
          className="mx-3 mb-2 px-3 py-1.5 rounded-md text-[11px]"
          style={{ background: '#ff3b3018', color: '#ff3b30', border: '0.5px solid #ff3b3040' }}
        >
          {data.error}
        </div>
      )}

      {data.loading ? (
        <div className="flex items-center justify-center flex-1">
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            Loading…
          </span>
        </div>
      ) : showEmpty ? (
        <div className="flex-1 overflow-auto">
          <AddProjectControl variant="empty-state" onAdd={(root) => data.addProject(root)} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-1">
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            No projects match the current filter.
          </span>
          <button
            type="button"
            onClick={() => setFilter(EMPTY_FILTER)}
            className="text-[11px] px-2 py-0.5 rounded font-medium hover:bg-[var(--bg-active)]"
            style={{ color: 'var(--accent)' }}
          >
            Clear filters
          </button>
        </div>
      ) : view === 'compact' ? (
        <WorkspaceCompactView
          projects={filtered}
          selected={selection.selected}
          canMutate={data.connected}
          onSelectChange={selection.set}
          onOpen={openProjectWindow}
          onReindex={(r) => void data.reindexProject(r)}
          onRemove={(r) => void data.removeProject(r)}
        />
      ) : (
        <WorkspaceTableView
          projects={filtered}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          selected={selection.selected}
          canMutate={data.connected}
          onSelectChange={selection.set}
          onSelectAll={(next) => {
            if (next) selection.selectAll(filtered);
            else selection.clear();
          }}
          onOpen={openProjectWindow}
          onReindex={(r) => void data.reindexProject(r)}
          onRemove={(r) => void data.removeProject(r)}
        />
      )}

      <BulkActionsBar
        projects={selectedProjects}
        onReindex={(roots) => data.reindexMany(roots)}
        onRemove={async (roots) => {
          await data.removeMany(roots);
          selection.clear();
        }}
        onClear={() => selection.clear()}
      />
    </div>
  );
}
