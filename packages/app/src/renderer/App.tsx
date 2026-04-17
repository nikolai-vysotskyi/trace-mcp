import { useState, useEffect, useRef, useCallback } from 'react';
import { Indexes } from './tabs/Indexes';
import { Clients } from './tabs/Clients';
import { Settings } from './tabs/Settings';
import { ProjectOverview } from './tabs/ProjectOverview';
import { AskTab } from './tabs/AskTab';
import { GraphExplorerGPU, GraphExplorerGPUHandle, GraphGPUSettings, DEFAULT_GRAPH_GPU_SETTINGS } from './tabs/GraphExplorerGPU';
import { WindowTabBar } from './components/WindowTabBar';

// ── URL params determine window type ──────────────────────────
// ?view=menu&tab=projects  → Menu window (sidebar + Projects/Clients/Settings)
// ?view=project&root=/path → Project window (sidebar + Overview/Graph)

type GlobalTab = 'projects' | 'clients' | 'settings';
const GLOBAL_TABS: { id: GlobalTab; label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'clients', label: 'MCP Clients' },
  { id: 'settings', label: 'Settings' },
];

type ProjectTab = 'overview' | 'ask' | 'graph';
const PROJECT_TABS: { id: ProjectTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'ask', label: 'Ask' },
  { id: 'graph', label: 'Graph' },
];

function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    view: params.get('view') || 'menu',
    tab: params.get('tab'),
    root: params.get('root'),
  };
}

const SIDEBAR_MIN = 100;
const SIDEBAR_MAX = 360;
const SIDEBAR_DEFAULT = 180;

const BASE = 'http://127.0.0.1:3741';

// ── Recent projects (localStorage) ──────────────────────────
const RECENT_KEY = 'trace-mcp:recent-projects';
const MAX_RECENT = 8;

function getRecentProjects(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

function addRecentProject(root: string): void {
  const recent = getRecentProjects().filter((r) => r !== root);
  recent.unshift(root);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

export function removeRecentProject(root: string): void {
  const recent = getRecentProjects().filter((r) => r !== root);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}

function RecentProjects() {
  const [recent, setRecent] = useState<string[]>(getRecentProjects);

  // Re-read on focus (other tab might have opened a project)
  useEffect(() => {
    const onFocus = () => setRecent(getRecentProjects());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (recent.length === 0) {
    return (
      <div className="px-2.5 py-1 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        No recent projects
      </div>
    );
  }

  const openProject = (root: string) => {
    addRecentProject(root);
    const api = (window as any).electronAPI;
    api?.openProjectTab(root);
  };

  return (
    <div className="flex flex-col gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <div
        className="px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-tertiary)' }}
      >
        Recent
      </div>
      {recent.map((root) => (
        <div
          key={root}
          className="group flex items-center rounded-md transition-colors hover:bg-[var(--bg-active)]"
        >
          <button
            onClick={() => openProject(root)}
            className="text-left flex-1 min-w-0 px-2.5 py-1 text-[11px] truncate"
            style={{ color: 'var(--text-secondary)' }}
            title={root}
          >
            {root.split(/[/\\]/).filter(Boolean).pop()}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              removeRecentProject(root);
              setRecent(getRecentProjects());
            }}
            className="shrink-0 mr-1.5 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--bg-secondary)]"
            style={{ color: 'var(--text-tertiary)' }}
            title="Remove from recent"
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M1 1l6 6M7 1l-6 6" />
            </svg>
          </button>
        </div>
      ))}
    </div>
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

function ProjectFileExplorer({ root, scope, onFileClick }: { root: string; scope?: string; onFileClick: (filePath: string) => void }) {
  const [sort, setSort] = useState<FileSort>('symbols');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
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
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data) => { if (!cancelled) setFiles(data.files ?? []); })
      .catch(() => { if (!cancelled) setFiles([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [root, sort, debouncedScope]);

  // Short display path: strip project root prefix
  const shortPath = (p: string) => {
    if (p.startsWith(root)) return p.slice(root.length).replace(/^[/\\]/, '');
    return p;
  };

  return (
    <div
      className="flex flex-col gap-0.5 min-h-0 flex-1"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Sort picker */}
      <div className="px-1.5 mb-0.5 relative">
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <path d="M2 4h12M4 8h8M6 12h4" />
        </svg>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as FileSort)}
          className="w-full text-[10px] pl-5 pr-1.5 py-1 rounded-md appearance-none"
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text-secondary)',
            border: '0.5px solid var(--border)',
            outline: 'none',
          }}
        >
          {FILE_SORT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {loading ? (
          <div className="px-2.5 py-2 text-[10px] text-center" style={{ color: 'var(--text-tertiary)' }}>
            Loading…
          </div>
        ) : files.length === 0 ? (
          <div className="px-2.5 py-2 text-[10px] text-center" style={{ color: 'var(--text-tertiary)' }}>
            No files
          </div>
        ) : (
          files.map((f) => (
            <button
              key={f.path}
              onClick={() => onFileClick(f.path)}
              className="w-full text-left px-2.5 py-1 text-[10px] truncate rounded-md transition-colors hover:bg-[var(--bg-active)] flex items-center gap-1"
              style={{ color: 'var(--text-secondary)' }}
              title={`${shortPath(f.path)} — ${f.symbols} symbols, ${f.edges} edges`}
            >
              <span className="truncate flex-1" style={{ direction: 'rtl', textAlign: 'left' }}>{shortPath(f.path)}</span>
              <span
                className="shrink-0 text-[9px] tabular-nums"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {sort === 'edges' ? f.edges : f.symbols}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── Update banner ────────────────────────────────────────────
function UpdateBanner() {
  const [update, setUpdate] = useState<{ available: boolean; latest?: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.checkForUpdate) return;

    const check = () => api.checkForUpdate().then((r: any) => { if (r?.available) setUpdate(r); });
    // Check on mount + every 4 hours
    check();
    const timer = setInterval(check, 4 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  if (!update?.available) return null;

  const handleUpdate = async () => {
    const api = (window as any).electronAPI;
    if (!api) return;
    setUpdating(true);
    const result = await api.applyUpdate();
    if (result?.ok) {
      setDone(true);
    } else {
      setUpdating(false);
    }
  };

  const handleRestart = () => {
    const api = (window as any).electronAPI;
    api?.restartApp();
  };

  return (
    <div
      style={{
        padding: '8px 10px',
        borderTop: '1px solid var(--border-row)',
        fontSize: 11,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <div style={{ color: 'var(--text-secondary)', lineHeight: 1.3 }}>
        v{update.latest} available
      </div>
      {done ? (
        <button
          onClick={handleRestart}
          style={{
            background: 'var(--success)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '4px 0',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            width: '100%',
          }}
        >
          Restart
        </button>
      ) : (
        <button
          onClick={handleUpdate}
          disabled={updating}
          style={{
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '4px 0',
            fontSize: 11,
            fontWeight: 600,
            cursor: updating ? 'wait' : 'pointer',
            opacity: updating ? 0.7 : 1,
            width: '100%',
          }}
        >
          {updating ? 'Updating...' : 'Update'}
        </button>
      )}
    </div>
  );
}

// ── Menu content ──────────────────────────────────────────────
function MenuContent({ tab }: { tab: GlobalTab }) {
  const openProject = (root: string) => {
    addRecentProject(root);
    const api = (window as any).electronAPI;
    api?.openProjectTab(root);
  };

  return (
    <>
      {tab === 'projects' && <Indexes onOpenProject={openProject} />}
      {tab === 'clients' && <Clients />}
      {tab === 'settings' && <Settings />}
    </>
  );
}

// ── Project content ───────────────────────────────────────────
function ProjectContent({ root, tab, graphRef, graphGpuSettings, onGraphGpuSettingsChange, onNavigateToService }: {
  root: string;
  tab: ProjectTab;
  graphRef: React.RefObject<GraphExplorerGPUHandle | null>;
  graphGpuSettings: GraphGPUSettings;
  onGraphGpuSettingsChange: (patch: Partial<GraphGPUSettings>) => void;
  onNavigateToService: (serviceName: string) => void;
}) {
  return (
    <>
      {/* Overview — mount/unmount normally */}
      {tab === 'overview' && <ProjectOverview root={root} onNavigateToService={onNavigateToService} />}
      {/* Ask — chat interface, needs flex layout */}
      {tab === 'ask' && <AskTab root={root} />}
      {/* Graph — GPU-accelerated (cosmos.gl), edge-to-edge */}
      {tab === 'graph' && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <GraphExplorerGPU ref={graphRef} root={root} settings={graphGpuSettings} onSettingsChange={onGraphGpuSettingsChange} />
        </div>
      )}
    </>
  );
}

// ── Main App ──────────────────────────────────────────────────
export function App() {
  const { view, tab, root } = getUrlParams();
  const isProject = view === 'project' && root !== null;

  const [globalTab, setGlobalTab] = useState<GlobalTab>(
    (tab === 'projects' || tab === 'clients' || tab === 'settings') ? tab : 'projects'
  );
  const [projectTab, setProjectTab] = useState<ProjectTab>('overview');
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const dragging = useRef(false);
  const graphRef = useRef<GraphExplorerGPUHandle | null>(null);
  const [graphGpuSettings, setGraphGpuSettings] = useState<GraphGPUSettings>(DEFAULT_GRAPH_GPU_SETTINGS);

  const onGraphGpuSettingsChange = useCallback((patch: Partial<GraphGPUSettings>) => {
    setGraphGpuSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  // Focus a file/symbol in the graph (invoked from the file explorer / project overview).
  // Switches to the Graph tab and asks GraphExplorerGPU to zoom to that node.
  const openFileInGraph = useCallback((filePath: string) => {
    if (projectTab !== 'graph') setProjectTab('graph');
    // Defer until the GPU graph has mounted (one tick is enough).
    setTimeout(() => graphRef.current?.focusNode(filePath), 0);
  }, [projectTab]);

  // Navigate to graph tab scoped to a service.
  const navigateToService = useCallback((serviceName: string) => {
    onGraphGpuSettingsChange({ scope: `subproject:${serviceName}` });
    setProjectTab('graph');
  }, [onGraphGpuSettingsChange]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX));
      setSidebarWidth(newWidth);
      // Sync to other tabs
      const api = (window as any).electronAPI;
      api?.syncSidebarWidth(newWidth);
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
  }, []);

  // Receive sidebar width from other tabs
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (api?.onSidebarWidthChanged) {
      return api.onSidebarWidthChanged((w: number) => setSidebarWidth(w));
    }
  }, []);

  // Track fullscreen state
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (api?.onFullscreenChanged) {
      return api.onFullscreenChanged((fs: boolean) => setIsFullscreen(fs));
    }
  }, []);


  const isGraph = isProject && projectTab === 'graph';
  const needsFlexLayout = isProject && (projectTab === 'graph' || projectTab === 'ask');
  const isGraphGpu = isGraph; // alias — the Graph tab *is* the GPU graph now

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* Windows custom tab bar (hidden on macOS — native tabs handle it) */}
      <WindowTabBar />

      <div className="flex flex-1 min-h-0" style={{ padding: 8, gap: 0 }}>
      {/* Left sidebar */}
      <div
        className="shrink-0 relative"
        style={{
          width: sidebarWidth,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      >
        <aside
          className="flex flex-col pt-3 pb-3 px-1.5 gap-0.5 h-full"
          style={{
            border: '1px solid var(--sidebar-border)',
            borderRadius: 12,
            background: 'var(--sidebar-bg)',
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
        >
          {isProject ? (
            <>
              {PROJECT_TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setProjectTab(t.id)}
                  className="text-left px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors"
                  style={{
                    color: projectTab === t.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                    background: projectTab === t.id ? 'var(--bg-active)' : 'transparent',
                    WebkitAppRegion: 'no-drag',
                  } as React.CSSProperties}
                >
                  {t.label}
                </button>
              ))}

              {/* Divider + File explorer */}
              <div style={{ borderTop: '1px solid var(--border-row)', margin: '6px 8px' }} />
              <ProjectFileExplorer root={root!} scope={graphGpuSettings.scope} onFileClick={openFileInGraph} />
            </>
          ) : (
            <>
              {GLOBAL_TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setGlobalTab(t.id)}
                  className="text-left px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors"
                  style={{
                    color: globalTab === t.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                    background: globalTab === t.id ? 'var(--bg-active)' : 'transparent',
                    WebkitAppRegion: 'no-drag',
                  } as React.CSSProperties}
                >
                  {t.label}
                </button>
              ))}

              {/* Divider + Recent projects */}
              <div style={{ borderTop: '1px solid var(--border-row)', margin: '6px 8px' }} />
              <RecentProjects />
            </>
          )}

          {/* Spacer to push update banner to bottom */}
          <div style={{ flex: 1 }} />
          <UpdateBanner />
        </aside>

        {/* Resize handle */}
        <div
          onMouseDown={onMouseDown}
          style={{
            position: 'absolute',
            top: 0,
            right: -3,
            width: 6,
            height: '100%',
            cursor: 'col-resize',
            zIndex: 50,
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
        />
      </div>

      {/* Main content */}
      <main
        className={`flex-1 flex flex-col min-h-0 ${isGraphGpu ? 'p-2' : needsFlexLayout ? 'p-1 pt-2' : 'p-4 overflow-y-auto'}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div
          className={needsFlexLayout ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'flex-1 flex flex-col min-h-0'}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {isProject ? (
            <ProjectContent root={root!} tab={projectTab} graphRef={graphRef} graphGpuSettings={graphGpuSettings} onGraphGpuSettingsChange={onGraphGpuSettingsChange} onNavigateToService={navigateToService} />
          ) : (
            <MenuContent tab={globalTab} />
          )}
        </div>
      </main>
      </div>
    </div>
  );
}
