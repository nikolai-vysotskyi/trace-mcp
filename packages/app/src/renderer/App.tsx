import { useState, useEffect, useRef, useCallback } from 'react';
import { Indexes } from './tabs/Indexes';
import { Clients } from './tabs/Clients';
import { Settings } from './tabs/Settings';
import { ProjectOverview } from './tabs/ProjectOverview';
import { GraphExplorer } from './tabs/GraphExplorer';

// ── Top-level tabs (no project selected) ───────────────────────
type GlobalTab = 'indexes' | 'clients' | 'settings';
const GLOBAL_TABS: { id: GlobalTab; label: string }[] = [
  { id: 'indexes', label: 'Indexes' },
  { id: 'clients', label: 'Clients' },
  { id: 'settings', label: 'Settings' },
];

// ── Project-level tabs (project selected) ──────────────────────
type ProjectTab = 'overview' | 'graph';
const PROJECT_TABS: { id: ProjectTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'graph', label: 'Graph' },
];

function getInitialTab(): GlobalTab {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  if (tab === 'indexes' || tab === 'clients' || tab === 'settings') return tab;
  return 'indexes';
}

const SIDEBAR_MIN = 100;
const SIDEBAR_MAX = 360;
const SIDEBAR_DEFAULT = 140;

export function App() {
  const [globalTab, setGlobalTab] = useState<GlobalTab>(getInitialTab);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [projectTab, setProjectTab] = useState<ProjectTab>('overview');
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
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

  useEffect(() => {
    const onPopState = () => {
      setGlobalTab(getInitialTab());
      setSelectedProject(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const openProject = (root: string) => {
    setSelectedProject(root);
    setProjectTab('overview');
  };

  const closeProject = () => {
    setSelectedProject(null);
    setGlobalTab('indexes');
  };

  const isProjectMode = selectedProject !== null;

  return (
    <div className="flex h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* Left sidebar */}
      <aside
        className="shrink-0 flex flex-col pt-10 pb-3 px-1.5 gap-0.5 relative"
        style={{
          width: sidebarWidth,
          borderRight: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      >
        {isProjectMode ? (
          <>
            {/* Back to projects */}
            <button
              onClick={closeProject}
              className="text-left px-2.5 py-1 text-[10px] rounded-md mb-1"
              style={{
                color: 'var(--accent)',
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties}
            >
              ← Projects
            </button>

            {/* Project name */}
            <div
              className="px-2.5 py-1 text-[10px] font-semibold truncate mb-1"
              style={{ color: 'var(--text-primary)' }}
              title={selectedProject}
            >
              {selectedProject.split('/').filter(Boolean).pop()}
            </div>

            {/* Project tabs */}
            {PROJECT_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setProjectTab(tab.id)}
                className="text-left px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors"
                style={{
                  color: projectTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: projectTab === tab.id ? 'var(--bg-active)' : 'transparent',
                  WebkitAppRegion: 'no-drag',
                } as React.CSSProperties}
              >
                {tab.label}
              </button>
            ))}
          </>
        ) : (
          <>
            {GLOBAL_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setGlobalTab(tab.id)}
                className="text-left px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors"
                style={{
                  color: globalTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: globalTab === tab.id ? 'var(--bg-active)' : 'transparent',
                  WebkitAppRegion: 'no-drag',
                } as React.CSSProperties}
              >
                {tab.label}
              </button>
            ))}
          </>
        )}

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
      </aside>

      {/* Main content */}
      {(() => {
        const isGraph = isProjectMode && projectTab === 'graph';
        return (
          <main
            className={`flex-1 flex flex-col min-h-0 ${isGraph ? 'p-1 pt-2' : 'p-4 overflow-y-auto'}`}
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          >
            <div className={`${isGraph ? 'flex-1 min-h-0 flex flex-col' : ''}`} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              {isProjectMode ? (
                <>
                  {projectTab === 'overview' && <ProjectOverview root={selectedProject} />}
                  {projectTab === 'graph' && <GraphExplorer root={selectedProject} />}
                </>
              ) : (
                <>
                  {globalTab === 'indexes' && <Indexes onOpenProject={openProject} />}
                  {globalTab === 'clients' && <Clients />}
                  {globalTab === 'settings' && <Settings />}
                </>
              )}
            </div>
          </main>
        );
      })()}
    </div>
  );
}
