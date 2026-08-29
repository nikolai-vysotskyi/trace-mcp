import { useCallback, useEffect, useRef, useState } from 'react';
import { AppMenu } from './components/AppMenu';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GuardOnboarding, isOnboardingDone } from './components/GuardOnboarding';
import { QuickOpen, type QuickOpenItem } from './components/QuickOpen';
import { SidebarRow } from './components/SidebarRow';
import { WindowTabBar } from './components/WindowTabBar';
import { fileKind, FileTypeGlyph, Icon } from './lattice/icons';
import { HeaderSlotProvider, Menu, MenuItem, MenuSeparator, PopUpButton } from './lattice/ui';
import { formatAgo, type UpdateCheck, useUpdateCheck } from './update-check.js';
import {
  clampSidebarWidth,
  readSidebarCollapsed,
  readSidebarWidth,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  splitPath,
  writeSidebarCollapsed,
  writeSidebarWidth,
} from './sidebar-prefs.js';
import { Activity } from './tabs/Activity';
import { AskTab } from './tabs/AskTab';
import { Clients } from './tabs/Clients';
import {
  DEFAULT_GRAPH_GPU_SETTINGS,
  GraphExplorerGPU,
  type GraphExplorerGPUHandle,
  type GraphGPUSettings,
} from './tabs/GraphExplorerGPU';
import { Insights } from './tabs/Insights';
import { MemoryExplorer } from './tabs/MemoryExplorer';
import { Notebook } from './tabs/Notebook';
import { ProjectOverview } from './tabs/ProjectOverview';
import { Settings } from './tabs/Settings';
import { type Appearance, useTheme } from './theme.js';
import { Workspace } from './workspace/Workspace';

// ── URL params determine window type ──────────────────────────
// ?view=menu&tab=workspace → Menu window (sidebar + Workspace/Clients/Settings)
// ?view=project&root=/path → Project window (sidebar + Overview/Graph)

type GlobalTab = 'workspace' | 'clients' | 'settings';
// Settings lives in the sidebar footer (always-visible bottom row), not the top
// nav. Keep it in the type union so existing routing/state code keeps working.
const GLOBAL_TABS: { id: GlobalTab; label: string; icon: string }[] = [
  { id: 'workspace', label: 'Workspace', icon: 'grid_view' },
  { id: 'clients', label: 'MCP Clients', icon: 'cable' },
];

/**
 * Migrate legacy `?tab=projects` / `?tab=dashboard` query values + any value
 * persisted by older builds. Both pre-merge tabs collapse to `workspace`.
 */
function normalizeGlobalTab(value: string | null | undefined): GlobalTab {
  if (value === 'clients' || value === 'settings' || value === 'workspace') return value;
  // 'projects' / 'dashboard' / anything else → workspace (the new home).
  return 'workspace';
}

type ProjectTab = 'overview' | 'ask' | 'graph' | 'activity' | 'memory' | 'notebook' | 'insights';
const PROJECT_TABS: { id: ProjectTab; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'grid_view' },
  /* Not a speech bubble (DESIGN.md §5): Ask queries the indexed graph and hands
     back an answer — a search phrased in words, not a conversation with a
     person. `manage_search` was the first choice and lost on the render: its
     two answer lines sit 3 units apart on the 24 grid, which is 2.2px at the
     18px sidebar size, and they smudge into the magnifier's handle. */
  { id: 'ask', label: 'Ask', icon: 'search' },
  { id: 'graph', label: 'Graph', icon: 'hub' },
  { id: 'activity', label: 'Activity', icon: 'timeline' },
  { id: 'memory', label: 'Memory', icon: 'neurology' },
  { id: 'notebook', label: 'Notebook', icon: 'add_note' },
  { id: 'insights', label: 'Insights', icon: 'monitoring' },
];

/** Does this window have inset traffic lights to leave room for?
 *
 *  The main process decides that (`titleBarStyle: 'hiddenInset'` in
 *  main/tray.ts) and preload reports it synchronously, because the answer gates
 *  first paint. It must NOT be inferred from `navigator.userAgent`: that says
 *  "Mac" in a browser on macOS too, so `vite dev` used to reserve a 44px strip
 *  for traffic lights that were never there — every design review run against
 *  localhost was measuring a window the app does not have. */
function hasInsetTitleBar(): boolean {
  return window.electronChrome?.insetTitleBar === true;
}

function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    view: params.get('view') || 'menu',
    tab: params.get('tab'),
    root: params.get('root'),
  };
}

const BASE = 'http://127.0.0.1:3741';

// ── Recent projects (localStorage) ──────────────────────────
// Helpers live in ./recent-projects.ts so the Workspace tab can import
// `removeRecentProject` without pulling in App.tsx (import cycle).
import {
  addRecentProject,
  getRecentProjects,
  removeRecentProject,
} from './recent-projects.js';

export { removeRecentProject };

function RecentProjects() {
  const [recent, setRecent] = useState<string[]>(getRecentProjects);
  // Right-click target — the same actions the row's click and ⌫ already offer,
  // reachable the way a Mac user reaches for them (TRA-297).
  const [ctx, setCtx] = useState<{ x: number; y: number; root: string } | null>(null);

  // Re-read on focus (other tab might have opened a project)
  useEffect(() => {
    const onFocus = () => setRecent(getRecentProjects());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const openProject = (root: string) => {
    addRecentProject(root);
    const api = window.electronAPI;
    api?.openProjectTab(root);
  };

  const pickProject = async () => {
    const api = window.electronAPI;
    const picked = await api?.selectFolder?.();
    if (picked) openProject(picked);
  };

  if (recent.length === 0) {
    return (
      <div className="ws-sb-empty">
        <Icon name="folder" size={20} className="gi" />
        <span>No projects opened yet.</span>
        <button type="button" className="act" onClick={pickProject}>
          Open a project…
        </button>
      </div>
    );
  }

  const forget = (root: string) => {
    removeRecentProject(root);
    setRecent(getRecentProjects());
  };

  return (
    <>
      {ctx && (
        <Menu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)}>
          <MenuItem
            icon="folder_open"
            onClick={() => {
              setCtx(null);
              openProject(ctx.root);
            }}
          >
            Open project
          </MenuItem>
          <MenuItem
            icon="content_copy"
            onClick={() => {
              setCtx(null);
              void navigator.clipboard?.writeText(ctx.root);
            }}
          >
            Copy path
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            icon="close"
            shortcut="⌫"
            onClick={() => {
              setCtx(null);
              forget(ctx.root);
            }}
          >
            Remove from recent
          </MenuItem>
        </Menu>
      )}
      {recent.map((root) => (
        <SidebarRow
          key={root}
          icon="folder"
          label={root.split(/[/\\]/).filter(Boolean).pop() ?? root}
          title={root}
          onClick={() => openProject(root)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtx({ x: e.clientX, y: e.clientY, root });
          }}
          // Keyboard route for the remove affordance — the row is itself a
          // button, so the ✕ can't be one too (nested interactive content).
          onKeyDown={(e) => {
            if (e.key !== 'Delete' && e.key !== 'Backspace') return;
            e.preventDefault();
            forget(root);
          }}
          trailing={
            <span
              className="ws-sb-trailing"
              aria-hidden="true"
              title="Remove from recent (⌫)"
              onClick={(e) => {
                e.stopPropagation();
                forget(root);
              }}
            >
              <Icon name="close" size={12} />
            </span>
          }
        />
      ))}
    </>
  );
}

// ── Project file explorer (sidebar) ─────────────────────────

type FileSort = 'symbols' | 'edges' | 'isolated' | 'recent';

const FILE_SORT_OPTIONS: { id: FileSort; label: string }[] = [
  { id: 'symbols', label: 'Most Symbols' },
  { id: 'edges', label: 'Most Connected' },
  { id: 'isolated', label: 'Dead Code' },
  { id: 'recent', label: 'Recently Changed' },
];

interface FileEntry {
  path: string;
  symbols: number;
  edges: number;
}

function ProjectFileExplorer({
  root,
  scope,
  onFileClick,
}: {
  root: string;
  scope?: string;
  onFileClick: (filePath: string) => void;
}) {
  const [sort, setSort] = useState<FileSort>('symbols');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const LIMIT = 30;

  // Debounce scope to avoid fetching on every keystroke
  const [debouncedScope, setDebouncedScope] = useState(scope);
  const scopeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(scopeTimerRef.current);
    scopeTimerRef.current = setTimeout(() => setDebouncedScope(scope), 400);
    return () => clearTimeout(scopeTimerRef.current);
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ project: root, sort, limit: String(LIMIT) });
    // Pass scope to API if it's a custom path filter (not 'project' or empty)
    const effectiveScope = debouncedScope?.trim();
    if (effectiveScope && effectiveScope !== 'project') {
      params.set('scope', effectiveScope);
    }
    fetch(`${BASE}/api/projects/files?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (!cancelled) setFiles(data.files ?? []);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, sort, debouncedScope]);

  // Short display path: strip project root prefix
  const shortPath = (p: string) => {
    if (p.startsWith(root)) return p.slice(root.length).replace(/^[/\\]/, '');
    return p;
  };

  // ↑/↓ move the selection, ⏎ opens — standard macOS list keyboard model.
  const onRowKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? index + 1 : index - 1;
    if (next < 0 || next >= files.length) return;
    setSelected(files[next].path);
    listRef.current
      ?.querySelectorAll<HTMLButtonElement>('.ws-sb-row')
      [next]?.focus();
  };

  return (
    <>
      {ctx && (
        <Menu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)}>
          <MenuItem
            icon="hub"
            onClick={() => {
              setCtx(null);
              setSelected(ctx.path);
              onFileClick(ctx.path);
            }}
          >
            Reveal in graph
          </MenuItem>
          <MenuItem
            icon="edit"
            onClick={() => {
              setCtx(null);
              void window.electronAPI?.openInEditor(ctx.path);
            }}
          >
            Open in editor
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="content_copy"
            onClick={() => {
              setCtx(null);
              void navigator.clipboard?.writeText(ctx.path);
            }}
          >
            Copy path
          </MenuItem>
        </Menu>
      )}
      <div className="ws-sb-group">Files</div>
      {/* Sort — the shared pop-up button primitive (TRA-290). */}
      <PopUpButton
        block
        className="ws-sb-popup"
        options={FILE_SORT_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
        value={sort}
        onChange={(v) => setSort(v as FileSort)}
        aria-label="Sort files by"
      />

      {loading ? (
        // Skeletons at the final 28px geometry — nothing shifts on load.
        <div aria-busy="true" aria-label="Loading files">
          {Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list, no identity
            <div key={i} className="ws-sb-skeleton" />
          ))}
        </div>
      ) : files.length === 0 ? (
        <div className="ws-sb-empty">
          <Icon name="description" size={20} className="gi" />
          <span>No indexed files match this scope.</span>
        </div>
      ) : (
        <div role="tree" aria-label="Project files" ref={listRef}>
          {files.map((f, i) => {
            const display = shortPath(f.path);
            const { dir, name } = splitPath(display);
            return (
              <SidebarRow
                key={f.path}
                role="treeitem"
                aria-selected={selected === f.path}
                selected={selected === f.path}
                glyph={<FileTypeGlyph ftype={fileKind(f.path).ftype} size={16} />}
                label={
                  <span className="ws-sb-path">
                    {dir && <span className="dir">{dir}</span>}
                    <span className="name">{name}</span>
                  </span>
                }
                count={sort === 'edges' ? f.edges : f.symbols}
                title={`${display} — ${f.symbols} symbols, ${f.edges} edges`}
                onClick={() => {
                  setSelected(f.path);
                  onFileClick(f.path);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected(f.path);
                  setCtx({ x: e.clientX, y: e.clientY, path: f.path });
                }}
                onKeyDown={(e) => onRowKeyDown(e, i)}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

// Where the compiled bundles live — same repo the postinstall downloads from
// (scripts/app-dist-repo.mjs). Used by the "manual install" card below.
const RELEASES_URL = 'https://github.com/nikolai-vysotskyi/trace-mcp/releases/latest';

// ── Update card ──────────────────────────────────────────────
// Only the states you can DO something about: an update available, one
// downloaded and waiting on a restart, and a bundle that could not replace
// itself. "Up to date" used to be a permanent 28px strip above the footer whose
// whole job was to say nothing was wrong; it says that in the app menu's
// header now, next to Check for updates (TRA-363).
export function UpdateCard({ update }: { update: UpdateCheck }) {
  const { state, pendingVersion, updating } = update;

  // Pending swap takes precedence — the user's next click should restart, not redownload.
  if (pendingVersion) {
    return (
      <div className="update-card" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="title">
          <span className="ready-icon" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M2.5 6.2l2.4 2.4 4.6-4.6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          v{pendingVersion} ready
        </div>
        <div className="subtitle">Restart to install · v{state.current}</div>
        <button type="button" className="btn-prominent success" onClick={update.restart}>
          Restart to install
        </button>
      </div>
    );
  }

  // The CLI updated, the .app bundle did not, and clicking Update again would
  // repeat exactly that. Suppressing the "update available" card is correct;
  // showing a green "Up to date" in its place is what left a user three major
  // versions behind believing they were current (TRA-357). This state gets its
  // own honest card with the one action that does work: download the release.
  if (state.stuck && state.latest) {
    return (
      <div
        className="update-card stuck"
        role="status"
        aria-live="polite"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div className="title">v{state.latest} needs a manual install</div>
        <div className="subtitle">
          The command line tool updated, but the app itself is still v{state.current} — it could not
          replace its own bundle. Download the release and drag it into Applications.
        </div>
        <button
          type="button"
          className="btn-prominent"
          onClick={() => void window.electronAPI?.openExternal?.(RELEASES_URL)}
        >
          Download v{state.latest}
        </button>
      </div>
    );
  }

  if (!state.available) return null;

  return (
    <div
      className="update-card"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      // It appears without the user asking, so assistive tech has to hear it.
      role="status"
      aria-live="polite"
    >
      <div className="title">v{state.latest} available</div>
      <div className="subtitle">
        Currently v{state.current} · checked {formatAgo(state.lastChecked)}
      </div>
      {state.error && (
        <div className="subtitle error" title={state.error}>
          {state.error}
        </div>
      )}
      <button type="button" className="btn-prominent" onClick={update.apply} disabled={updating}>
        {updating ? 'Updating…' : 'Update'}
      </button>
    </div>
  );
}

// ── Menu content ──────────────────────────────────────────────
function MenuContent({
  tab,
  appearance,
  onAppearanceChange,
}: {
  tab: GlobalTab;
  appearance: Appearance;
  onAppearanceChange: (next: Appearance) => void;
}) {
  return (
    <>
      {tab === 'workspace' && <Workspace />}
      {tab === 'clients' && <Clients />}
      {tab === 'settings' && (
        <Settings appearance={appearance} onAppearanceChange={onAppearanceChange} />
      )}
    </>
  );
}

// ── Project content ───────────────────────────────────────────
function ProjectContent({
  root,
  tab,
  graphRef,
  graphGpuSettings,
  onGraphGpuSettingsChange,
  onNavigateToService,
  onOpenFileInGraph,
}: {
  root: string;
  tab: ProjectTab;
  graphRef: React.RefObject<GraphExplorerGPUHandle | null>;
  graphGpuSettings: GraphGPUSettings;
  onGraphGpuSettingsChange: (patch: Partial<GraphGPUSettings>) => void;
  onNavigateToService: (serviceName: string) => void;
  onOpenFileInGraph: (filePath: string) => void;
}) {
  return (
    <>
      {/* Overview — mount/unmount normally */}
      {tab === 'overview' && (
        <ProjectOverview root={root} onNavigateToService={onNavigateToService} />
      )}
      {/* Ask — chat interface, needs flex layout */}
      {tab === 'ask' && <AskTab root={root} />}
      {/* Activity — live MCP tool-call feed for this project */}
      {tab === 'activity' && <Activity root={root} onOpenFileInGraph={onOpenFileInGraph} />}
      {/* Memory — decisions / corpora / sessions explorer */}
      {tab === 'memory' && <MemoryExplorer root={root} />}
      {/* Notebook — ad-hoc trace-mcp tool runner (read-only) */}
      {tab === 'notebook' && <Notebook root={root} />}
      {/* Insights — high-signal project reports (drift, pagerank, hotspots) */}
      {tab === 'insights' && <Insights root={root} />}
      {/* Graph — GPU-accelerated (cosmos.gl), edge-to-edge */}
      {tab === 'graph' && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <GraphExplorerGPU
            ref={graphRef}
            root={root}
            settings={graphGpuSettings}
            onSettingsChange={onGraphGpuSettingsChange}
          />
        </div>
      )}
    </>
  );
}

// ── Main App ──────────────────────────────────────────────────
export function App() {
  const { view, tab, root } = getUrlParams();
  const isProject = view === 'project' && root !== null;
  const { theme, appearance, setAppearance } = useTheme();
  /* One owner of update state for the whole window: the app menu's header
     reports it, the card acts on it, and "Check for updates…" — from the
     application menu or from the app menu — drives the same check (TRA-363). */
  const update = useUpdateCheck();

  const [globalTab, setGlobalTab] = useState<GlobalTab>(normalizeGlobalTab(tab));
  const [projectTab, setProjectTab] = useState<ProjectTab>('overview');
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [_isFullscreen, setIsFullscreen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickFiles, setQuickFiles] = useState<string[]>([]);
  /* The element surfaces portal their toolbar into. Callback ref rather than
     useRef: the provider has to re-render once the node exists, or the first
     surface mounts with nowhere to render. */
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const dragging = useRef(false);
  const graphRef = useRef<GraphExplorerGPUHandle | null>(null);
  const [graphGpuSettings, setGraphGpuSettings] = useState<GraphGPUSettings>(
    DEFAULT_GRAPH_GPU_SETTINGS,
  );

  // Onboarding wizard — show once on first launch in the menu (project list)
  // window. Project sub-windows skip it; the wizard belongs in the place
  // where the user manages projects.
  const [showOnboarding, setShowOnboarding] = useState(
    !isProject && view === 'menu' && !isOnboardingDone(),
  );

  const onGraphGpuSettingsChange = useCallback((patch: Partial<GraphGPUSettings>) => {
    setGraphGpuSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  // Focus a file/symbol in the graph (invoked from the file explorer / project overview).
  // Switches to the Graph tab and asks GraphExplorerGPU to zoom to that node.
  const openFileInGraph = useCallback(
    (filePath: string) => {
      if (projectTab !== 'graph') setProjectTab('graph');
      // Defer until the GPU graph has mounted (one tick is enough).
      setTimeout(() => graphRef.current?.focusNode(filePath), 0);
    },
    [projectTab],
  );

  // Navigate to graph tab scoped to a service.
  const navigateToService = useCallback(
    (serviceName: string) => {
      onGraphGpuSettingsChange({ scope: `subproject:${serviceName}` });
      setProjectTab('graph');
    },
    [onGraphGpuSettingsChange],
  );

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username -- CSS `userSelect` property name matched the "username" secret heuristic; no credential involved.
  }, []);

  // One place that owns a width change: state → localStorage → other windows.
  const applySidebarWidth = useCallback((width: number) => {
    const clamped = clampSidebarWidth(width);
    setSidebarWidth(clamped);
    writeSidebarWidth(clamped);
    window.electronAPI?.syncSidebarWidth(clamped);
    return clamped;
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      writeSidebarCollapsed(!prev);
      return !prev;
    });
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      applySidebarWidth(e.clientX);
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [applySidebarWidth]);

  // Receive sidebar width from other tabs
  useEffect(() => {
    const api = window.electronAPI;
    if (api?.onSidebarWidthChanged) {
      return api.onSidebarWidthChanged((w: number) => setSidebarWidth(clampSidebarWidth(w)));
    }
  }, []);

  // Cross-window sync of the persisted prefs (same-process tabs).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'trace-mcp-sidebar-width' && e.newValue !== null) {
        setSidebarWidth(clampSidebarWidth(Number(e.newValue)));
      } else if (e.key === 'trace-mcp-sidebar-collapsed') {
        setSidebarCollapsed(e.newValue === '1');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const sectionList = isProject ? PROJECT_TABS : GLOBAL_TABS;

  /** ⌘1…⌘9 and quick-open both land here: n is 1-based, matching the menu. */
  const selectSection = useCallback(
    (n: number) => {
      const section = sectionList[n - 1];
      if (!section) return;
      if (isProject) setProjectTab(section.id as ProjectTab);
      else setGlobalTab(section.id as GlobalTab);
    },
    [isProject, sectionList],
  );

  /* ⌘F. Every surface's search is the same Lattice SearchField, so "the search
     field of the surface in front of me" is literally the first one in the
     content pane — no per-surface registry to keep in sync. */
  const focusSearch = useCallback(() => {
    const field = document.querySelector<HTMLInputElement>(
      '.ws-content-body .lx-search input, .ws-content-body input[type="search"]',
    );
    if (!field) return;
    field.focus();
    field.select();
  }, []);

  const pickProject = useCallback(async () => {
    const api = window.electronAPI;
    const picked = await api?.selectFolder?.();
    if (!picked) return;
    addRecentProject(picked);
    api?.openProjectTab(picked);
  }, []);

  const openSettings = useCallback(() => {
    if (isProject) window.electronAPI?.openSettings?.();
    else setGlobalTab('settings');
  }, [isProject]);

  /* The application menu owns every accelerator now (main/menu.ts) and sends
     one `app-command` per item to the focused window. Keeping a duplicate
     window-level keydown for the same keys would double-fire the toggles, so
     this is the single renderer-side handler — ⌘P below is the one exception,
     because Electron allows a menu item only one accelerator. */
  useEffect(() => {
    const api = window.electronAPI;
    api?.setWindowSections?.(sectionList.map((t) => ({ id: t.id, label: t.label })));
  }, [sectionList]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onAppCommand) return;
    return api.onAppCommand((command, arg) => {
      switch (command) {
        case 'toggle-sidebar':
          toggleSidebar();
          break;
        case 'select-section':
          selectSection(Number(arg));
          break;
        case 'find':
          focusSearch();
          break;
        case 'quick-open':
          setQuickOpen(true);
          break;
        case 'settings':
          openSettings();
          break;
        case 'open-project':
          void pickProject();
          break;
        case 'check-for-update':
          update.check();
          break;
      }
    });
  }, [toggleSidebar, selectSection, focusSearch, openSettings, pickProject, update.check]);

  // ⌘P — the second quick-open key. Not in the menu (one accelerator per item).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key !== 'p' && e.key !== 'P') return;
      e.preventDefault();
      setQuickOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /* Quick-open's file list. Fetched when the panel opens rather than on mount:
     it is a bigger page than the sidebar's 30 rows and nobody pays for it
     until they ask. Failures leave sections and projects, which still work. */
  useEffect(() => {
    if (!quickOpen || !isProject || !root || quickFiles.length > 0) return;
    let cancelled = false;
    const params = new URLSearchParams({ project: root, sort: 'symbols', limit: '400' });
    fetch(`${BASE}/api/projects/files?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { files?: { path: string }[] }) => {
        if (!cancelled) setQuickFiles((data.files ?? []).map((f) => f.path));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [quickOpen, isProject, root, quickFiles.length]);

  const quickOpenItems = useCallback((): QuickOpenItem[] => {
    const items: QuickOpenItem[] = sectionList.map((section, i) => ({
      id: `section:${section.id}`,
      label: section.label,
      detail: `⌘${i + 1}`,
      group: 'Go to',
      icon: section.icon,
      run: () => selectSection(i + 1),
    }));
    for (const projectRoot of getRecentProjects()) {
      items.push({
        id: `project:${projectRoot}`,
        label: projectRoot.split(/[/\\]/).filter(Boolean).pop() ?? projectRoot,
        detail: projectRoot,
        group: 'Recent projects',
        icon: 'folder',
        run: () => {
          addRecentProject(projectRoot);
          window.electronAPI?.openProjectTab(projectRoot);
        },
      });
    }
    for (const filePath of quickFiles) {
      const display = root && filePath.startsWith(root)
        ? filePath.slice(root.length).replace(/^[/\\]/, '')
        : filePath;
      const { dir, name } = splitPath(display);
      items.push({
        id: `file:${filePath}`,
        label: name,
        detail: dir,
        group: 'Files',
        icon: 'description',
        run: () => openFileInGraph(filePath),
      });
    }
    return items;
  }, [sectionList, selectSection, quickFiles, root, openFileInGraph]);

  // Track fullscreen state
  useEffect(() => {
    const api = window.electronAPI;
    if (api?.onFullscreenChanged) {
      return api.onFullscreenChanged((fs: boolean) => setIsFullscreen(fs));
    }
  }, []);

  const isGraph = isProject && projectTab === 'graph';
  const needsFlexLayout = isProject && (projectTab === 'graph' || projectTab === 'ask');
  /* Surfaces that draw their own toolbar own the whole pane: a 16px inset turns
     a flush 52px toolbar into a floating white band with the sunken background
     showing down both sides (TRA-293). The Workspace dashboard has drawn its
     own 52px toolbar and its own 16px gutters since TRA-292, so the pane's
     `p-4` was doubling every inset on it — the KPI row started at x=32 and the
     first card at y=76 (TRA-306). MCP clients and Settings drew their own
     toolbars in TRA-295 and joined them; Activity and Memory in TRA-294. */
  const ownsToolbar = isProject
    ? projectTab === 'overview' || projectTab === 'activity' || projectTab === 'memory'
    : globalTab === 'workspace' || globalTab === 'clients' || globalTab === 'settings';
  const isGraphGpu = isGraph; // alias — the Graph tab *is* the GPU graph now

  /* One control, two possible homes: the sidebar's title strip while the
     sidebar is open, the content band when it is collapsed (or when the window
     has no inset title bar to draw a strip for). */
  const sidebarToggle = (
    <button
      type="button"
      className="ws-chrome-toggle"
      onClick={toggleSidebar}
      aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      aria-expanded={!sidebarCollapsed}
      title={`${sidebarCollapsed ? 'Show' : 'Hide'} sidebar (⌘⌥S)`}
    >
      <Icon name="dock_to_right" size={16} />
    </button>
  );
  const toggleLivesInSidebar = !sidebarCollapsed && hasInsetTitleBar();

  return (
    <div
      className="ws-stage flex flex-col h-screen"
      data-mode={theme}
      data-platform={hasInsetTitleBar() ? 'mac' : 'other'}
    >
      {showOnboarding && <GuardOnboarding onClose={() => setShowOnboarding(false)} />}
      {quickOpen && <QuickOpen items={quickOpenItems()} onClose={() => setQuickOpen(false)} />}
      {/* Windows custom tab bar (hidden on macOS — native tabs handle it) */}
      <WindowTabBar />

      <div className={`ws-shell${sidebarCollapsed ? ' is-collapsed' : ''}`}>
        {!sidebarCollapsed && (
          <aside
            className="ws-sidebar"
            aria-label="Sidebar"
            style={{ width: sidebarWidth } as React.CSSProperties}
          >
            {/* 44px strip the traffic lights live in — and the only draggable
                part of the sidebar. Only where the window actually has inset
                lights: in a browser there are none, so the strip would be an
                empty band the real app never shows.

                The sidebar toggle sits here, past the lights, the way Finder
                and Mail place it: it belongs to the sidebar, not to the
                surface. It also keeps the content band's full width for the
                surface's own controls — carrying the toggle there cost 46px and
                wrapped Memory's toolbar onto a second line at 960px. */}
            {toggleLivesInSidebar && (
              <div className="ws-sidebar-titlebar">{sidebarToggle}</div>
            )}

            <nav className="ws-sidebar-scroll" aria-label="Sections">
              {isProject ? (
                <>
                  {PROJECT_TABS.map((t) => (
                    <SidebarRow
                      key={t.id}
                      icon={t.icon}
                      label={t.label}
                      selected={projectTab === t.id}
                      aria-current={projectTab === t.id ? 'page' : undefined}
                      onClick={() => setProjectTab(t.id)}
                    />
                  ))}
                  <ProjectFileExplorer
                    root={root!}
                    scope={graphGpuSettings.scope}
                    onFileClick={openFileInGraph}
                  />
                </>
              ) : (
                <>
                  {GLOBAL_TABS.map((t) => (
                    <SidebarRow
                      key={t.id}
                      icon={t.icon}
                      label={t.label}
                      selected={globalTab === t.id}
                      aria-current={globalTab === t.id ? 'page' : undefined}
                      onClick={() => setGlobalTab(t.id)}
                    />
                  ))}
                  <div className="ws-sb-group">Recent</div>
                  <RecentProjects />
                </>
              )}
            </nav>

            <UpdateCard update={update} />
            <AppMenu
              update={update.state}
              checking={update.checking}
              onCheckForUpdate={update.check}
              appearance={appearance}
              onAppearanceChange={setAppearance}
              onSettings={openSettings}
            />
          </aside>
        )}

        {/* Resize handle — draggable AND keyboard-operable, so the ARIA
            separator role is honest. */}
        {!sidebarCollapsed && (
          <div
            className="ws-sb-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            tabIndex={0}
            onMouseDown={onMouseDown}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 40 : 10;
              if (e.key === 'ArrowLeft') applySidebarWidth(sidebarWidth - step);
              else if (e.key === 'ArrowRight') applySidebarWidth(sidebarWidth + step);
              else if (e.key === 'Home') applySidebarWidth(SIDEBAR_MIN);
              else if (e.key === 'End') applySidebarWidth(SIDEBAR_MAX);
              else return;
              e.preventDefault();
            }}
          />
        )}

        {/* Main content */}
        <main className="ws-content">
          {/* The window's one top band: whatever the surface on screen puts on
              that line, rendered into `.ws-content-head-slot` via <Toolbar>, so
              a surface never stacks a control row under an otherwise-empty
              strip (DESIGN.md §6). The sidebar toggle only lands here when
              there is no sidebar strip to hold it. */}
          <div className="ws-content-head">
            {!toggleLivesInSidebar && sidebarToggle}
            <div className="ws-content-head-slot" ref={setHeaderSlot} />
          </div>
          <HeaderSlotProvider value={headerSlot}>
          <div
            className={`ws-content-body ${isGraphGpu ? 'p-2' : needsFlexLayout ? 'p-1 pt-2' : ownsToolbar ? '' : 'p-4 overflow-y-auto'}`}
          >
            {isProject ? (
              <ErrorBoundary key={`project:${projectTab}`} label={`${projectTab} tab`}>
                <ProjectContent
                  root={root!}
                  tab={projectTab}
                  graphRef={graphRef}
                  graphGpuSettings={graphGpuSettings}
                  onGraphGpuSettingsChange={onGraphGpuSettingsChange}
                  onNavigateToService={navigateToService}
                  onOpenFileInGraph={openFileInGraph}
                />
              </ErrorBoundary>
            ) : (
              <ErrorBoundary key={`menu:${globalTab}`} label={`${globalTab} tab`}>
                <MenuContent
                  tab={globalTab}
                  appearance={appearance}
                  onAppearanceChange={setAppearance}
                />
              </ErrorBoundary>
            )}
          </div>
          </HeaderSlotProvider>
        </main>
      </div>
    </div>
  );
}
