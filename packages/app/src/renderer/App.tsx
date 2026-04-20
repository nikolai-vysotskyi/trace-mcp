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
// Settings lives in the sidebar footer (always-visible bottom row), not the top
// nav. Keep it in the type union so existing routing/state code keeps working.
const GLOBAL_TABS: { id: GlobalTab; label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'clients', label: 'MCP Clients' },
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

// ── Theme override ────────────────────────────────────────────
// Default = follow system (`prefers-color-scheme`). One click stores an
// explicit preference in localStorage and sets [data-theme] on <html>; the
// CSS in app.css gives that attribute higher specificity than the @media
// rule, so the override wins. Cross-window: when the menu and a project
// window are both open, a `storage` event syncs them automatically.
const THEME_KEY = 'trace-mcp-theme';
type Theme = 'light' | 'dark';

function readStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function useTheme() {
  const [override, setOverride] = useState<Theme | null>(() => readStoredTheme());
  const [system, setSystem] = useState<Theme>(() => systemTheme());

  // Apply / remove the data-theme attribute on every change.
  useEffect(() => {
    const html = document.documentElement;
    if (override) html.setAttribute('data-theme', override);
    else html.removeAttribute('data-theme');
  }, [override]);

  // Track system theme for the "no override" case.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Cross-window sync: another window stored a new value → reflect it here.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY) return;
      setOverride(e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : null);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const effective: Theme = override ?? system;
  const toggle = useCallback(() => {
    const next: Theme = effective === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    setOverride(next);
  }, [effective]);

  return { theme: effective, toggle };
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  // Show the icon for the destination, not the current state — matches the
  // user's mental model ("click moon → it gets dark").
  const goingTo: Theme = theme === 'dark' ? 'light' : 'dark';
  const label = goingTo === 'dark' ? 'Switch to dark mode' : 'Switch to light mode';
  return (
    <button
      type="button"
      onClick={toggle}
      className="icon-button"
      aria-label={label}
      title={label}
    >
      {goingTo === 'dark' ? (
        // Moon (crescent) — currently light, click to go dark.
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13.2 9.6A5.6 5.6 0 1 1 6.4 2.8a4.6 4.6 0 0 0 6.8 6.8z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        // Sun (circle + rays) — currently dark, click to go light.
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="2.8" stroke="currentColor" strokeWidth="1.4" />
          <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <line x1="8" y1="1.6" x2="8" y2="3.2" />
            <line x1="8" y1="12.8" x2="8" y2="14.4" />
            <line x1="1.6" y1="8" x2="3.2" y2="8" />
            <line x1="12.8" y1="8" x2="14.4" y2="8" />
            <line x1="3.5" y1="3.5" x2="4.6" y2="4.6" />
            <line x1="11.4" y1="11.4" x2="12.5" y2="12.5" />
            <line x1="3.5" y1="12.5" x2="4.6" y2="11.4" />
            <line x1="11.4" y1="4.6" x2="12.5" y2="3.5" />
          </g>
        </svg>
      )}
    </button>
  );
}

// ── Sidebar footer ───────────────────────────────────────────
// Always-visible row at the bottom of the sidebar with Settings on the left
// and the theme toggle on the right. In project windows, Settings opens the
// menu window via IPC instead of in-place navigation.
function SidebarFooter({
  active,
  onOpenSettingsInPlace,
}: {
  active: boolean;
  onOpenSettingsInPlace?: () => void;
}) {
  const handleSettings = () => {
    if (onOpenSettingsInPlace) {
      onOpenSettingsInPlace();
    } else {
      const api = (window as any).electronAPI;
      api?.openSettings?.();
    }
  };
  return (
    <div className="sidebar-footer">
      <button
        type="button"
        className={`nav-button${active ? ' active' : ''}`}
        onClick={handleSettings}
      >
        Settings
      </button>
      <ThemeToggle />
    </div>
  );
}

// ── Update banner ────────────────────────────────────────────
// Always rendered at the bottom of the sidebar. Polls every 10min — the main
// process checks the npm registry (no rate limit) with GitHub Releases as a
// fallback. Surfaces three states: up-to-date (with last-checked timestamp),
// update available, and update downloaded but pending restart.
type UpdateState = {
  available: boolean;
  current?: string;
  latest?: string;
  lastChecked?: number;
  error?: string;
};

function formatAgo(ts?: number, now: number = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ available: false });
  const [updating, setUpdating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const cancelledRef = useRef(false);

  const runCheck = async () => {
    const api = (window as any).electronAPI;
    if (!api?.checkForUpdate) return;
    setChecking(true);
    try {
      const [upd, pend] = await Promise.all([
        api.checkForUpdate(),
        api.checkPendingUpdate ? api.checkPendingUpdate() : Promise.resolve({ pending: false }),
      ]);
      if (cancelledRef.current) return;
      if (upd) setState(upd);
      if (pend?.pending) setPendingVersion(pend.version || (upd?.latest ?? null));
      else setPendingVersion(null);
    } catch (err) {
      if (!cancelledRef.current) setState((s) => ({ ...s, error: (err as Error).message }));
    } finally {
      if (!cancelledRef.current) setChecking(false);
    }
  };

  useEffect(() => {
    cancelledRef.current = false;
    runCheck();
    const poll = setInterval(runCheck, 600_000);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => { cancelledRef.current = true; clearInterval(poll); clearInterval(tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUpdate = async () => {
    const api = (window as any).electronAPI;
    if (!api) return;
    setUpdating(true);
    setState((s) => ({ ...s, error: undefined }));
    try {
      const result = await api.applyUpdate();
      if (result?.ok && api.checkPendingUpdate) {
        const pend = await api.checkPendingUpdate();
        if (pend?.pending) setPendingVersion(pend.version || state.latest || null);
      }
      if (!result?.ok) setState((s) => ({ ...s, error: result?.error || 'update failed' }));
    } finally {
      setUpdating(false);
    }
  };

  const handleRestart = () => {
    const api = (window as any).electronAPI;
    api?.restartApp();
  };

  // Pending swap takes precedence — the user's next click should restart, not redownload.
  if (pendingVersion) {
    return (
      <div className="update-card" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="title">
          <span className="ready-icon" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 6.2l2.4 2.4 4.6-4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          v{pendingVersion} ready
        </div>
        <div className="subtitle">Restart to install · v{state.current}</div>
        <button className="btn-prominent success" onClick={handleRestart}>
          Restart to install
        </button>
      </div>
    );
  }

  const refreshButton = (
    <button
      type="button"
      className={`update-refresh${checking ? ' spinning' : ''}`}
      onClick={runCheck}
      disabled={checking}
      title="Check for updates"
      aria-label="Check for updates"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M10 2.5v2.6H7.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2 9.5V6.9h2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9.3 5.1A3.7 3.7 0 003 4.6M2.7 6.9a3.7 3.7 0 006.3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  if (state.available) {
    return (
      <div className="update-card" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="title">
          <span>v{state.latest} available</span>
          {refreshButton}
        </div>
        <div className="subtitle">
          Currently v{state.current} · checked {formatAgo(state.lastChecked, now)}
        </div>
        {state.error && (
          <div className="subtitle error" title={state.error}>{state.error}</div>
        )}
        <button className="btn-prominent" onClick={handleUpdate} disabled={updating}>
          {updating ? 'Updating…' : 'Update'}
        </button>
      </div>
    );
  }

  // Idle: minimal status row. No card chrome — stays out of the way.
  const isError = !!state.error;
  return (
    <div className={`update-idle${isError ? ' error' : ''}`} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <span className="dot" aria-hidden="true" />
      <span className="label" title={isError ? state.error : undefined}>
        {isError
          ? state.error
          : `Up to date · v${state.current ?? '—'}`}
      </span>
      {refreshButton}
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

          {/* Spacer to push footer to bottom */}
          <div style={{ flex: 1 }} />
          <UpdateBanner />
          <SidebarFooter
            active={!isProject && globalTab === 'settings'}
            onOpenSettingsInPlace={isProject ? undefined : () => setGlobalTab('settings')}
          />
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
