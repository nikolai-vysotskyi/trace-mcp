import { useState, useEffect, useRef, useCallback } from 'react';
import { Indexes } from './tabs/Indexes';
import { Clients } from './tabs/Clients';
import { Settings } from './tabs/Settings';
import { ProjectOverview } from './tabs/ProjectOverview';
import { GraphExplorer } from './tabs/GraphExplorer';

// ── URL params determine window type ──────────────────────────
// ?view=menu&tab=projects  → Menu window (sidebar + Projects/Clients/Settings)
// ?view=project&root=/path → Project window (sidebar + Overview/Graph)

type GlobalTab = 'projects' | 'clients' | 'settings';
const GLOBAL_TABS: { id: GlobalTab; label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'clients', label: 'MCP Clients' },
  { id: 'settings', label: 'Settings' },
];

type ProjectTab = 'overview' | 'graph';
const PROJECT_TABS: { id: ProjectTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
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

// ── Menu content ──────────────────────────────────────────────
function MenuContent({ tab }: { tab: GlobalTab }) {
  const openProject = (root: string) => {
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
function ProjectContent({ root, tab }: { root: string; tab: ProjectTab }) {
  return (
    <>
      {tab === 'overview' && <ProjectOverview root={root} />}
      {tab === 'graph' && <GraphExplorer root={root} />}
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

  return (
    <div className="flex h-screen" style={{ padding: 8, gap: 0, background: 'var(--bg-primary)' }}>
      {/* Left sidebar — macOS floating panel */}
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
          }}
        >
          {isProject ? (
            <>
              {/* Project name */}
              <div
                className="px-2.5 py-1 text-[10px] font-semibold truncate mb-1"
                style={{ color: 'var(--text-primary)' }}
                title={root!}
              >
                {root!.split('/').filter(Boolean).pop()}
              </div>
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
            </>
          ) : (
            GLOBAL_TABS.map((t) => (
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
            ))
          )}
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
        className={`flex-1 flex flex-col min-h-0 ${isGraph ? 'p-1 pt-2' : 'p-4 overflow-y-auto'}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div
          className={isGraph ? 'flex-1 min-h-0 flex flex-col' : 'flex-1 flex flex-col min-h-0'}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {isProject ? (
            <ProjectContent root={root!} tab={projectTab} />
          ) : (
            <MenuContent tab={globalTab} />
          )}
        </div>
      </main>
    </div>
  );
}
