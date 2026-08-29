import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GuardOnboarding, isOnboardingDone } from './components/GuardOnboarding';
import { QuickOpen, type QuickOpenItem } from './components/QuickOpen';
import { WindowTabBar } from './components/WindowTabBar';
import { fileKind, FileTypeGlyph, Icon } from './lattice/icons';
import { Menu, MenuItem, MenuSeparator, PopUpButton } from './lattice/ui';
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
  onContextMenu,
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
  onContextMenu?: (e: React.MouseEvent) => void;
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
      onContextMenu={onContextMenu}
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

// ── Sidebar footer ───────────────────────────────────────────
// ONE row pinned below the scroll region, in the SAME row system as the nav
// above it (.ws-sb-row: 28px, 16px leading glyph at x=14, 13px label at x=38).
//
// TRA-305 put the footer on that row system, which was right, but it also
// parked Appearance in a second static row — 70.5px of footer under a 38px
// update banner, and the bottom of the sidebar read as heavy (TRA-306).
// Appearance is a preference, not a navigation destination, and no macOS app
// pins an appearance switcher to its sidebar: it moved to the Settings screen,
// where Auto / Light / Dark are still all three one click away. In project
// windows, Settings opens the menu window via IPC instead of navigating.
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
      const api = window.electronAPI;
      api?.openSettings?.();
    }
  };
  return (
    <div className="ws-sb-footer">
      <SidebarRow
        icon="settings"
        label="Settings"
        selected={active}
        aria-current={active ? 'page' : undefined}
        onClick={handleSettings}
      />
    </div>
  );
}

// ── Update banner ────────────────────────────────────────────
// Always rendered at the bottom of the sidebar. Polls every 10min — the main
// process checks the npm registry (no rate limit) with GitHub Releases as a
// fallback. Surfaces three states: up-to-date (with last-checked timestamp),
// update available, and update downloaded but pending restart.
// Where the compiled bundles live — same repo the postinstall downloads from
// (scripts/app-dist-repo.mjs). Used by the "manual install" card below.
const RELEASES_URL = 'https://github.com/nikolai-vysotskyi/trace-mcp/releases/latest';

type UpdateState = {
  available: boolean;
  current?: string;
  latest?: string;
  lastChecked?: number;
  error?: string;
  stuck?: boolean;
  staleRoots?: { root: string; version: string }[];
};

/**
 * `npm install -g` only ever writes into the global root its own npm owns. On a
 * machine with several (nvm + Herd + a bundled runtime) the rest keep an old
 * version, and every other signal here still reads "Up to date" — so a client
 * wired to a stale root runs old code with nothing saying so (TRA-364). We
 * cannot safely write into a root the user never pointed us at, so we say it
 * out loud instead: the status row goes to the warning treatment and its
 * tooltip names each stale root and the command that fixes it.
 */
function describeStaleRoots(staleRoots: { root: string; version: string }[]): {
  label: string;
  title: string;
} {
  const label =
    staleRoots.length === 1
      ? `Another npm install is on v${staleRoots[0].version}`
      : `${staleRoots.length} other npm installs are out of date`;
  const lines = staleRoots.map((r) => `v${r.version} — ${r.root}/trace-mcp`);
  return {
    label,
    title: `${label}. This app updated the root it resolves to; these were not touched:\n${lines.join('\n')}\n\nFix each with its own npm: <root>/../../bin/npm install -g trace-mcp@latest`,
  };
}

function formatAgo(ts?: number, now: number = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function UpdateBanner() {
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
    // "Check for updates…" in the application menu (TRA-297). App.tsx receives
    // the IPC command and re-broadcasts it here so the banner stays the single
    // owner of update state.
    const onMenuCheck = () => runCheck();
    window.addEventListener('trace-mcp:check-update', onMenuCheck);
    return () => {
      cancelledRef.current = true;
      clearInterval(poll);
      clearInterval(tick);
      window.removeEventListener('trace-mcp:check-update', onMenuCheck);
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
        // marker, so this call returns { available: false, stuck: true } and
        // the card switches to "needs a manual install" instead of looping the
        // user through the same prompt on the next poll.
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
        <div className="title">
          <span>v{state.latest} needs a manual install</span>
          {refreshButton}
        </div>
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
  // A stale sibling root is not an error, but it must not read as healthy
  // either — it borrows the same warning treatment when nothing worse is up.
  const stale = !isError && state.staleRoots?.length ? describeStaleRoots(state.staleRoots) : null;
  return (
    <div
      className={`update-idle${isError || stale ? ' error' : ''}`}
      // The only place the app reports update health. It changes without the
      // user asking, so assistive tech has to hear it (TRA-297).
      role="status"
      aria-live="polite"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <span className="dot" aria-hidden="true" />
      <span className="label" title={isError ? state.error : (stale?.title ?? undefined)}>
        {isError ? state.error : (stale?.label ?? `Up to date · v${state.current ?? '—'}`)}
      </span>
      {refreshButton}
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

  const [globalTab, setGlobalTab] = useState<GlobalTab>(normalizeGlobalTab(tab));
  const [projectTab, setProjectTab] = useState<ProjectTab>('overview');
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [_isFullscreen, setIsFullscreen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickFiles, setQuickFiles] = useState<string[]>([]);
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
          window.dispatchEvent(new CustomEvent('trace-mcp:check-update'));
          break;
      }
    });
  }, [toggleSidebar, selectSection, focusSearch, openSettings, pickProject]);

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

  return (
    <div
      className="ws-stage flex flex-col h-screen"
      data-mode={theme}
      data-platform={isMacPlatform() ? 'mac' : 'other'}
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
        </main>
      </div>
    </div>
  );
}
