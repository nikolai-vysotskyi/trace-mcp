import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GuardOnboarding, isOnboardingDone } from './components/GuardOnboarding';
import { WindowTabBar } from './components/WindowTabBar';
import { fileKind, FileTypeGlyph, Icon } from './lattice/icons';
import { Button, PopUpButton } from './lattice/ui';
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
  { id: 'ask', label: 'Ask', icon: 'forum' },
  { id: 'graph', label: 'Graph', icon: 'hub' },
  { id: 'activity', label: 'Activity', icon: 'timeline' },
  { id: 'memory', label: 'Memory', icon: 'neurology' },
  { id: 'notebook', label: 'Notebook', icon: 'add_note' },
  { id: 'insights', label: 'Insights', icon: 'monitoring' },
];

/** macOS-only chrome (inset traffic lights, native vibrancy). Synchronous —
 *  `getPlatform()` is an async IPC round-trip and this gates first paint. */
function isMacPlatform(): boolean {
  return /Mac/i.test(navigator.userAgent);
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

/** One 28px sidebar row: 16px leading glyph, 13px label, optional trailing. */
function SidebarRow({
  icon,
  glyph,
  label,
  selected = false,
  onClick,
  onKeyDown,
  title,
  count,
  trailing,
  rowRef,
  ...aria
}: {
  icon?: string;
  glyph?: React.ReactNode;
  label: React.ReactNode;
  selected?: boolean;
  onClick: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  title?: string;
  count?: React.ReactNode;
  trailing?: React.ReactNode;
  rowRef?: React.Ref<HTMLButtonElement>;
} & React.AriaAttributes & { role?: string; tabIndex?: number }) {
  return (
    <button
      type="button"
      ref={rowRef}
      className={`ws-sb-row${selected ? ' is-selected' : ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title={title}
      {...aria}
    >
      <span className="ws-sb-ico" aria-hidden="true">
        {glyph ?? (icon ? <Icon name={icon} size={16} /> : null)}
      </span>
      {typeof label === 'string' ? <span className="ws-sb-label">{label}</span> : label}
      {count !== undefined && <span className="ws-sb-count">{count}</span>}
      {trailing}
    </button>
  );
}

function RecentProjects() {
  const [recent, setRecent] = useState<string[]>(getRecentProjects);

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

  return (
    <>
      {recent.map((root) => (
        <SidebarRow
          key={root}
          icon="folder"
          label={root.split(/[/\\]/).filter(Boolean).pop() ?? root}
          title={root}
          onClick={() => openProject(root)}
          // Keyboard route for the remove affordance — the row is itself a
          // button, so the ✕ can't be one too (nested interactive content).
          onKeyDown={(e) => {
            if (e.key !== 'Delete' && e.key !== 'Backspace') return;
            e.preventDefault();
            removeRecentProject(root);
            setRecent(getRecentProjects());
          }}
          trailing={
            <span
              className="ws-sb-trailing"
              aria-hidden="true"
              title="Remove from recent (⌫)"
              onClick={(e) => {
                e.stopPropagation();
                removeRecentProject(root);
                setRecent(getRecentProjects());
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
                onKeyDown={(e) => onRowKeyDown(e, i)}
              />
            );
          })}
        </div>
      )}
    </>
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
  } catch {
    return null;
  }
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
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    setOverride(next);
  }, [effective]);

  return { theme: effective, toggle };
}

function ThemeToggle({ theme, toggle }: { theme: Theme; toggle: () => void }) {
  // Show the icon for the destination, not the current state — matches the
  // user's mental model ("click moon → it gets dark").
  const goingTo: Theme = theme === 'dark' ? 'light' : 'dark';
  const label = goingTo === 'dark' ? 'Switch to dark mode' : 'Switch to light mode';
  return (
    <Button variant="mini" onClick={toggle} aria-label={label} title={label}>
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
    </Button>
  );
}

// ── Sidebar footer ───────────────────────────────────────────
// Always-visible row at the bottom of the sidebar with Settings on the left
// and the theme toggle on the right. In project windows, Settings opens the
// menu window via IPC instead of in-place navigation.
function SidebarFooter({
  active,
  onOpenSettingsInPlace,
  theme,
  onToggleTheme,
}: {
  active: boolean;
  onOpenSettingsInPlace?: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const handleSettings = () => {
    if (onOpenSettingsInPlace) {
      onOpenSettingsInPlace();
    } else {
      const api = window.electronAPI;
      api?.openSettings?.();
    }
  };
  return (
    <div className="sidebar-footer">
      <Button variant="text" active={active} onClick={handleSettings}>
        Settings
      </Button>
      <ThemeToggle theme={theme} toggle={onToggleTheme} />
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
  stuck?: boolean;
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
    const api = window.electronAPI;
    if (!api?.checkForUpdate) return;
    setChecking(true);
    try {
      const [upd, pend] = await Promise.all([
        api.checkForUpdate(),
        api.checkPendingUpdate
          ? api.checkPendingUpdate()
          : Promise.resolve<{ pending: boolean; version?: string }>({ pending: false }),
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: runCheck is intentionally captured once on mount; adding it would tear down the polling interval on every state update inside runCheck (setState calls), defeating the 10-min cadence. The cancelledRef guards against state updates after unmount.
  useEffect(() => {
    cancelledRef.current = false;
    runCheck();
    const poll = setInterval(runCheck, 600_000);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      cancelledRef.current = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  const handleUpdate = async () => {
    const api = window.electronAPI;
    if (!api) return;
    setUpdating(true);
    setState((s) => ({ ...s, error: undefined }));
    try {
      const result = await api.applyUpdate();
      if (result?.ok && api.checkPendingUpdate) {
        const pend = await api.checkPendingUpdate();
        if (pend?.pending) setPendingVersion(pend.version || state.latest || null);
      }
      if (!result?.ok) {
        setState((s) => ({ ...s, error: result?.error || 'update failed' }));
      } else if (result.outcome === 'npm-only') {
        // The npm package moved but the .app bundle stayed put. Re-run the
        // availability check now — the main process just wrote the sticky
        // marker, so this call will return { available: false, stuck: true }
        // and the "Update available" card collapses to "Up to date" instead
        // of looping the user through the same prompt on the next poll.
        runCheck();
      }
    } finally {
      setUpdating(false);
    }
  };

  const handleRestart = () => {
    const api = window.electronAPI;
    api?.restartApp();
  };

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
        <button type="button" className="btn-prominent success" onClick={handleRestart}>
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
        <path
          d="M10 2.5v2.6H7.4"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M2 9.5V6.9h2.6"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9.3 5.1A3.7 3.7 0 003 4.6M2.7 6.9a3.7 3.7 0 006.3.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
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
          <div className="subtitle error" title={state.error}>
            {state.error}
          </div>
        )}
        <button type="button" className="btn-prominent" onClick={handleUpdate} disabled={updating}>
          {updating ? 'Updating…' : 'Update'}
        </button>
      </div>
    );
  }

  // Idle: minimal status row. No card chrome — stays out of the way.
  const isError = !!state.error;
  return (
    <div
      className={`update-idle${isError ? ' error' : ''}`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <span className="dot" aria-hidden="true" />
      <span className="label" title={isError ? state.error : undefined}>
        {isError ? state.error : `Up to date · v${state.current ?? '—'}`}
      </span>
      {refreshButton}
    </div>
  );
}

// ── Menu content ──────────────────────────────────────────────
function MenuContent({ tab }: { tab: GlobalTab }) {
  return (
    <>
      {tab === 'workspace' && <Workspace />}
      {tab === 'clients' && <Clients />}
      {tab === 'settings' && <Settings />}
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
  const { theme, toggle: toggleTheme } = useTheme();

  const [globalTab, setGlobalTab] = useState<GlobalTab>(normalizeGlobalTab(tab));
  const [projectTab, setProjectTab] = useState<ProjectTab>('overview');
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [_isFullscreen, setIsFullscreen] = useState(false);
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

  // ⌘⌥S toggles the sidebar; ⌘1…⌘9 select the nth primary section.
  useEffect(() => {
    const sections: string[] = isProject
      ? PROJECT_TABS.map((t) => t.id)
      : GLOBAL_TABS.map((t) => t.id);
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.altKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9 || n > sections.length) return;
      e.preventDefault();
      if (isProject) setProjectTab(sections[n - 1] as ProjectTab);
      else setGlobalTab(sections[n - 1] as GlobalTab);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isProject, toggleSidebar]);

  // Track fullscreen state
  useEffect(() => {
    const api = window.electronAPI;
    if (api?.onFullscreenChanged) {
      return api.onFullscreenChanged((fs: boolean) => setIsFullscreen(fs));
    }
  }, []);

  const isGraph = isProject && projectTab === 'graph';
  const needsFlexLayout = isProject && (projectTab === 'graph' || projectTab === 'ask');
  const isGraphGpu = isGraph; // alias — the Graph tab *is* the GPU graph now

  return (
    <div
      className="ws-stage flex flex-col h-screen"
      data-mode={theme}
      data-platform={isMacPlatform() ? 'mac' : 'other'}
    >
      {showOnboarding && <GuardOnboarding onClose={() => setShowOnboarding(false)} />}
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
                part of the sidebar. macOS only: elsewhere there are no inset
                lights to make room for. */}
            {isMacPlatform() && <div className="ws-sidebar-titlebar" />}

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

            <UpdateBanner />
            <SidebarFooter
              active={!isProject && globalTab === 'settings'}
              onOpenSettingsInPlace={isProject ? undefined : () => setGlobalTab('settings')}
              theme={theme}
              onToggleTheme={toggleTheme}
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
          <div className="ws-content-head">
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
          </div>
          <div
            className={`ws-content-body ${isGraphGpu ? 'p-2' : needsFlexLayout ? 'p-1 pt-2' : 'p-4 overflow-y-auto'}`}
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
                <MenuContent tab={globalTab} />
              </ErrorBoundary>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
