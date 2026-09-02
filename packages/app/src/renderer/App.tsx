import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppMenu } from './components/AppMenu';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GuardOnboarding, isOnboardingDone } from './components/GuardOnboarding';
import { QuickOpen, type QuickOpenItem } from './components/QuickOpen';
import { SidebarRow } from './components/SidebarRow';
import { WindowTabBar } from './components/WindowTabBar';
import { DAEMON_FETCH_TIMEOUT_MS } from './hooks/useDaemon';
import { t } from './i18n';
import { formatNumber } from './i18n/format';
import { fileKind, FileTypeGlyph, Icon } from './lattice/icons';
import {
  Button,
  Card,
  HeaderSlotProvider,
  Menu,
  MenuItem,
  MenuSeparator,
  PopUpButton,
} from './lattice/ui';
import {
  formatAgo,
  type UpdateCheck,
  useUpdateCheck,
} from './update-check.js';
import {
  clampSidebarWidth,
  parentDir,
  readSidebarCollapsed,
  readSidebarWidth,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  splitPath,
  writeSidebarCollapsed,
  writeSidebarWidth,
} from './sidebar-prefs.js';
import { Clients } from './tabs/Clients';
import {
  DEFAULT_GRAPH_GPU_SETTINGS,
  GraphExplorerGPU,
  type GraphExplorerGPUHandle,
  type GraphGPUSettings,
} from './tabs/GraphExplorerGPU';
import { ProjectOverview } from './tabs/ProjectOverview';
import { Settings } from './tabs/Settings';
import { type Appearance, useTheme } from './theme.js';
import { useWholeLocation } from './whole-location.js';
import { Workspace } from './workspace/Workspace';

// Secondary project tabs are code-split behind React.lazy so their component trees and
// tool feeds are not loaded during window cold start.
const Activity = lazy(() => import('./tabs/Activity').then((m) => ({ default: m.Activity })));
const AskTab = lazy(() => import('./tabs/AskTab').then((m) => ({ default: m.AskTab })));
const Insights = lazy(() => import('./tabs/Insights').then((m) => ({ default: m.Insights })));
const MemoryExplorer = lazy(() =>
  import('./tabs/MemoryExplorer').then((m) => ({ default: m.MemoryExplorer })),
);
const Notebook = lazy(() => import('./tabs/Notebook').then((m) => ({ default: m.Notebook })));

// ── URL params determine window type ──────────────────────────
// ?view=menu&tab=workspace → Menu window (sidebar + Workspace/Clients/Settings)
// ?view=project&root=/path → Project window (sidebar + Overview/Graph)

type GlobalTab = 'workspace' | 'clients' | 'settings';
// Settings lives in the sidebar footer (always-visible bottom row), not the top
// nav. Keep it in the type union so existing routing/state code keeps working.
// Built per render, not frozen at module scope: switching the language has to
// relabel the sidebar, quick open AND the native menu these are published to.
const globalTabs = (): { id: GlobalTab; label: string; icon: string }[] => [
  { id: 'workspace', label: t('shell:navWorkspace'), icon: 'grid_view' },
  { id: 'clients', label: t('shell:navClients'), icon: 'cable' },
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
const projectTabs = (): { id: ProjectTab; label: string; icon: string }[] => [
  { id: 'overview', label: t('shell:navOverview'), icon: 'grid_view' },
  /* Not a speech bubble (DESIGN.md §5): Ask queries the indexed graph and hands
     back an answer — a search phrased in words, not a conversation with a
     person. `manage_search` was the first choice and lost on the render: its
     two answer lines sit 3 units apart on the 24 grid, which is 2.2px at the
     18px sidebar size, and they smudge into the magnifier's handle. */
  { id: 'ask', label: t('shell:navAsk'), icon: 'search' },
  { id: 'graph', label: t('shell:navGraph'), icon: 'hub' },
  { id: 'activity', label: t('shell:navActivity'), icon: 'timeline' },
  { id: 'memory', label: t('shell:navMemory'), icon: 'neurology' },
  { id: 'notebook', label: t('shell:navNotebook'), icon: 'add_note' },
  { id: 'insights', label: t('shell:navInsights'), icon: 'monitoring' },
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
  const { t } = useTranslation('shell');
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
        <span>{t('noProjectsOpened')}</span>
        <button type="button" className="act" onClick={pickProject}>
          {t('openAProject')}
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
            {t('openProject')}
          </MenuItem>
          <MenuItem
            icon="content_copy"
            onClick={() => {
              setCtx(null);
              void navigator.clipboard?.writeText(ctx.root);
            }}
          >
            {t('copyPath')}
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
            {t('removeFromRecent')}
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
              title={t('removeFromRecentTitle')}
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

const fileSortOptions = (): { id: FileSort; label: string }[] => [
  { id: 'symbols', label: t('shell:sortMostSymbols') },
  { id: 'edges', label: t('shell:sortMostConnected') },
  { id: 'isolated', label: t('shell:sortDeadCode') },
  { id: 'recent', label: t('shell:sortRecentlyChanged') },
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
  const { t } = useTranslation('shell');
  const [sort, setSort] = useState<FileSort>('symbols');
  const [files, setFiles] = useState<FileEntry[]>([]);
  /* One state, three terminal facts, written only by the request that owns it.
     It was two booleans — `loading`, cleared in a `.finally` any cancelled run
     could skip, and `answered`, because an empty list and no list at all are
     different facts (TRA-471). A skeleton then outranked both, so a request
     that never settled pulsed six rows forever (TRA-478). `unavailable`
     outranks `pending` here for the same reason it does in `KpiTile`: a fetch
     that finished and failed is not still loading. */
  const [status, setStatus] = useState<'loading' | 'answered' | 'failed'>('loading');
  const [selected, setSelected] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // A row drops its location rather than shrink it to a sliver (TRA-504). The
  // sidebar is drag-resizable, so this re-measures on every width change too.
  useWholeLocation(listRef);
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
    setStatus('loading');
    const params = new URLSearchParams({ project: root, sort, limit: String(LIMIT) });
    // Pass scope to API if it's a custom path filter (not 'project' or empty)
    const effectiveScope = debouncedScope?.trim();
    if (effectiveScope && effectiveScope !== 'project') {
      params.set('scope', effectiveScope);
    }
    /* The deadline every other daemon fetch already carries (`useDaemon`), and
       the one this list was missing. A daemon that is down is not always a
       refused socket: a wedged process still holds :3741 open, so the connect
       sits in SYN_SENT and `fetch` neither resolves nor rejects — which is how
       the skeletons outlived the request (TRA-478). Without a deadline there is
       no terminal state to render. */
    fetch(`${BASE}/api/projects/files?${params}`, {
      signal: AbortSignal.timeout(DAEMON_FETCH_TIMEOUT_MS),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (cancelled) return;
        setFiles(data.files ?? []);
        setStatus('answered');
      })
      .catch(() => {
        if (cancelled) return;
        setFiles([]);
        setStatus('failed');
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
            {t('revealInGraph')}
          </MenuItem>
          <MenuItem
            icon="edit"
            onClick={() => {
              setCtx(null);
              void window.electronAPI?.openInEditor(ctx.path);
            }}
          >
            {t('openInEditor')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="content_copy"
            onClick={() => {
              setCtx(null);
              void navigator.clipboard?.writeText(ctx.path);
            }}
          >
            {t('copyPath')}
          </MenuItem>
        </Menu>
      )}
      <div className="ws-sb-group">{t('files')}</div>
      {/* Sort — the shared pop-up button primitive (TRA-290). */}
      <PopUpButton
        block
        className="ws-sb-popup"
        options={fileSortOptions().map((o) => ({ value: o.id, label: o.label }))}
        value={sort}
        onChange={(v) => setSort(v as FileSort)}
        aria-label={t('sortFilesBy')}
      />

      {status === 'loading' ? (
        // Skeletons at the final 28px geometry — nothing shifts on load.
        <div aria-busy="true" aria-label={t('loadingFiles')}>
          {Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list, no identity
            <div key={i} className="ws-sb-skeleton" />
          ))}
        </div>
      ) : files.length === 0 ? (
        /* Only a list that came back empty can be blamed on the scope. With the
           daemon down nothing was ever fetched, and the content pane already
           carries that diagnosis and its Start daemon button — the sidebar does
           not name a cause it cannot know, and does not say the same thing twice
           (DESIGN.md §5). The sort pop-up above stays: changing it re-fetches,
           which is the sidebar's own way back once the daemon answers again. */
        status === 'answered' ? (
          <div className="ws-sb-empty">
            <Icon name="description" size={20} className="gi" />
            <span>{t('noFilesMatchScope')}</span>
          </div>
        ) : null
      ) : (
        <div role="tree" aria-label={t('projectFiles')} ref={listRef}>
          {files.map((f, i) => {
            const display = shortPath(f.path);
            const { name } = splitPath(display);
            const parent = parentDir(display);
            return (
              <SidebarRow
                key={f.path}
                role="treeitem"
                aria-selected={selected === f.path}
                selected={selected === f.path}
                glyph={<FileTypeGlyph ftype={fileKind(f.path).ftype} size={16} />}
                label={
                  /* Filename first, location after it — the row is 180–320px
                     wide and only one of the two can survive that (TRA-503). */
                  <span className="ws-sb-path">
                    <span className="name">{name}</span>
                    {parent && <span className="dir">{parent}</span>}
                  </span>
                }
                count={sort === 'edges' ? f.edges : f.symbols}
                title={t('fileTitle', {
                  path: display,
                  symbols: formatNumber(f.symbols),
                  edges: formatNumber(f.edges),
                })}
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

// ── Update card ──────────────────────────────────────────────
// Only the states you can DO something about: an update available, one
// downloaded and waiting on a restart, and a bundle that could not replace
// itself. "Up to date" used to be a permanent 28px strip above the footer whose
// whole job was to say nothing was wrong; it says that in the app menu's
// header now, next to Check for updates (TRA-363). Its four parts — title,
// caption, command line, shell — are below; `UpdateCard` itself follows them.

/** Card title — 13/16/590, the window's Body semibold, not a 12px one-off. */
function CardTitle({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return (
    <div
      className="flex items-center gap-1.5 text-[13px] leading-4 font-[590] tracking-[-0.005em]"
      style={{ color: tone === 'warn' ? 'var(--status-orange)' : 'var(--label)' }}
    >
      {children}
    </div>
  );
}

/** Caption line — 11/13, --label-secondary. The old 10.5px was off the scale.
    Each utility is its own literal: Tailwind's scanner does not extract a class
    that a `${…}` interpolation runs straight into, and the missing one is
    silent — measured on the built CSS. */
function CardSubtitle({ children, error }: { children: React.ReactNode; error?: string }) {
  return (
    <div
      className={['text-[11px]', 'leading-[13px]', error ? 'truncate' : ''].join(' ')}
      style={{ color: error ? 'var(--status-orange)' : 'var(--label-secondary)' }}
      title={error}
    >
      {children}
    </div>
  );
}

/* The card's shell. Material, radius and hairline come from Lattice `Card` —
   the same opaque --surface tile at --radius-card the rest of the window is
   built from. It used to hand-roll --fill-tertiary at an 8px radius, which is
   why it read as a flat grey rectangle next to tiles it sat 200px away from
   (TRA-429). `.update-card` survives only as the animation + margin hook. */
function CardShell({
  children,
  warn = false,
  live = false,
}: {
  children: React.ReactNode;
  warn?: boolean;
  live?: boolean;
}) {
  return (
    <Card
      className="update-card"
      style={
        {
          WebkitAppRegion: 'no-drag',
          ...(warn ? { borderColor: 'var(--status-orange)' } : null),
        } as React.CSSProperties
      }
    >
      {/* The live region is the body, not the Card: `Card` owns the material
          and takes no ARIA. It appears without the user asking, so assistive
          tech has to hear it. */}
      <div
        className="flex flex-col gap-2 p-3"
        {...(live ? ({ role: 'status', 'aria-live': 'polite' } as const) : null)}
      >
        {children}
      </div>
    </Card>
  );
}

/** A command the user has to run themselves: selectable, and copyable in one
    click — a command you cannot copy is a screenshot, not an instruction.
    `.lx-sheet-command` is the app's command field (surface-sunken well,
    hairline, --radius-input, mono at the caption size) and the copy control is
    the icon `Button`; the card had grown its own 5px-radius box with a 10px
    mono and a hand-rolled button, which is the geometry this card was on
    before TRA-429. */
function CommandLine({ command, label }: { command: string; label: string }) {
  return (
    <div className="lx-sheet-command">
      <code>{command}</code>
      <Button
        variant="icon"
        size="small"
        icon="content_copy"
        iconSize={13}
        onClick={() => void navigator.clipboard?.writeText(command)}
        aria-label={label}
        title={label}
      />
    </div>
  );
}

export function UpdateCard({ update }: { update: UpdateCheck }) {
  const { t } = useTranslation('update');
  const { state, pendingVersion, updating, progress } = update;

  // Pending swap takes precedence — the user's next click should restart, not redownload.
  if (pendingVersion) {
    return (
      <CardShell>
        <CardTitle>
          <span className="flex" style={{ color: 'var(--status-green)' }} aria-hidden="true">
            <Icon name="check" size={13} />
          </span>
          {t('cardReadyTitle', { version: pendingVersion })}
        </CardTitle>
        <CardSubtitle>{t('cardReadySubtitle', { current: state.current })}</CardSubtitle>
        {/* Accent, not green: macOS paints the one default action in the accent
            colour, and the green here is the state (the check above), not the
            button. The old `.btn-prominent.success` was the only green button
            in the app. */}
        <Button variant="prominent" className="w-full" onClick={update.restart}>
          {t('cardRestart')}
        </Button>
      </CardShell>
    );
  }

  if (!state.available) return null;

  return (
    <CardShell live>
      <CardTitle>{t('cardAvailableTitle', { version: state.latest })}</CardTitle>
      <CardSubtitle>
        {t('cardAvailableSubtitle', {
          current: state.current,
          when: formatAgo(state.lastChecked),
        })}
      </CardSubtitle>
      {state.error && <CardSubtitle error={state.error}>{state.error}</CardSubtitle>}
      {/* `is-status`, not a plain disabled button: the download takes minutes,
          and 0.4 opacity on the one thing that says it is running reads as a
          hung app. The capsule keeps its accent fill and its label; the bar
          below is what carries "still going" (TRA-429). */}
      <Button
        variant="prominent"
        className={['w-full', updating ? 'is-status' : ''].join(' ')}
        onClick={update.apply}
        disabled={updating}
      >
        {updating ? t('cardUpdating') : t('cardUpdate')}
      </Button>
      {/* electron-updater reports real bytes, so the bar is determinate: it
          fills, and a stalled download stops moving instead of animating
          forever. Before the first `download-progress` event `progress` is 0,
          which is an honest empty bar rather than a fake position. */}
      {updating && (
        <div
          className="update-progress"
          role="progressbar"
          aria-label={t('cardUpdating')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress ?? 0)}
          style={{ '--update-progress': `${progress ?? 0}%` } as React.CSSProperties}
        />
      )}
    </CardShell>
  );
}

// ── Menu content ──────────────────────────────────────────────
function MenuContent({
  tab,
  appearance,
  onAppearanceChange,
  onOpenSetupWizard,
}: {
  tab: GlobalTab;
  appearance: Appearance;
  onAppearanceChange: (next: Appearance) => void;
  onOpenSetupWizard?: () => void;
}) {
  return (
    <>
      {tab === 'workspace' && <Workspace />}
      {tab === 'clients' && <Clients />}
      {tab === 'settings' && (
        <Settings
          appearance={appearance}
          onAppearanceChange={onAppearanceChange}
          onOpenSetupWizard={onOpenSetupWizard}
        />
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
    <Suspense fallback={null}>
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
    </Suspense>
  );
}

// ── Main App ──────────────────────────────────────────────────
export function App() {
  const { t } = useTranslation('shell');
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

  const sections = isProject ? projectTabs() : globalTabs();
  /* Identity-stable across renders while the language holds still: the memoised
     callbacks below take it as a dependency, and a fresh array each render
     would re-publish the window's section list to the main process forever. */
  const sectionKey = sections.map((s) => `${s.id}:${s.label}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sectionList = useMemo(() => sections, [sectionKey]);

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
      group: t('quickOpenGroupGoTo'),
      icon: section.icon,
      run: () => selectSection(i + 1),
    }));
    for (const projectRoot of getRecentProjects()) {
      items.push({
        id: `project:${projectRoot}`,
        label: projectRoot.split(/[/\\]/).filter(Boolean).pop() ?? projectRoot,
        detail: projectRoot,
        group: t('quickOpenGroupRecent'),
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
        group: t('quickOpenGroupFiles'),
        icon: 'description',
        run: () => openFileInGraph(filePath),
      });
    }
    return items;
  }, [sectionList, selectSection, quickFiles, root, openFileInGraph, t]);

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
      aria-label={sidebarCollapsed ? t('showSidebar') : t('hideSidebar')}
      aria-expanded={!sidebarCollapsed}
      title={sidebarCollapsed ? t('showSidebarTitle') : t('hideSidebarTitle')}
    >
      <Icon name="dock_to_right" size={16} />
    </button>
  );
  const toggleLivesInSidebar = !sidebarCollapsed && hasInsetTitleBar();

  const [tabCount, setTabCount] = useState<number>(0);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onTabListChanged) return;
    return api.onTabListChanged((tabs) => setTabCount(tabs.length));
  }, []);

  return (
    <div
      className="ws-stage flex flex-col h-screen"
      data-mode={theme}
      data-platform={hasInsetTitleBar() ? 'mac' : 'other'}
      data-tabbar={tabCount > 1 ? 'on' : 'off'}
    >
      {showOnboarding && <GuardOnboarding onClose={() => setShowOnboarding(false)} />}
      {quickOpen && <QuickOpen items={quickOpenItems()} onClose={() => setQuickOpen(false)} />}
      <WindowTabBar />

      <div className={`ws-shell${sidebarCollapsed ? ' is-collapsed' : ''}`}>
        {!sidebarCollapsed && (
          <aside
            className="ws-sidebar"
            aria-label={t('sidebar')}
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

            <nav className="ws-sidebar-scroll" aria-label={t('sections')}>
              {isProject ? (
                <>
                  {(sectionList as { id: ProjectTab; label: string; icon: string }[]).map((s) => (
                    <SidebarRow
                      key={s.id}
                      icon={s.icon}
                      label={s.label}
                      selected={projectTab === s.id}
                      aria-current={projectTab === s.id ? 'page' : undefined}
                      onClick={() => setProjectTab(s.id)}
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
                  {(sectionList as { id: GlobalTab; label: string; icon: string }[]).map((s) => (
                    <SidebarRow
                      key={s.id}
                      icon={s.icon}
                      label={s.label}
                      selected={globalTab === s.id}
                      aria-current={globalTab === s.id ? 'page' : undefined}
                      onClick={() => setGlobalTab(s.id)}
                    />
                  ))}
                  <div className="ws-sb-group">{t('recent')}</div>
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
            aria-label={t('resizeSidebar')}
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
              <ErrorBoundary
                key={`project:${projectTab}`}
                label={t('tabLabel', {
                  tab: sectionList.find((s) => s.id === projectTab)?.label ?? projectTab,
                })}
              >
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
              <ErrorBoundary
                key={`menu:${globalTab}`}
                label={t('tabLabel', {
                  tab: sectionList.find((s) => s.id === globalTab)?.label ?? globalTab,
                })}
              >
                <MenuContent
                  tab={globalTab}
                  appearance={appearance}
                  onAppearanceChange={setAppearance}
                  onOpenSetupWizard={() => setShowOnboarding(true)}
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
