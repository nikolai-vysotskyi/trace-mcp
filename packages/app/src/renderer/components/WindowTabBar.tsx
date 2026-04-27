/**
 * Custom tab bar for Windows (and Linux).
 * On macOS, native tabs handle this — this component renders nothing.
 *
 * Displays a horizontal strip of tabs at the top of each window.
 * Each tab represents an open window (Menu + project windows).
 * Clicking a tab sends IPC to focus that window.
 */
import { useEffect, useState } from 'react';

interface TabInfo {
  id: string;
  title: string;
  type: string;
  active: boolean;
}

export function WindowTabBar() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [platform, setPlatform] = useState<string>('');

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.getPlatform) return;
    api.getPlatform().then((p: string) => setPlatform(p));
  }, []);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onTabListChanged) return;
    return api.onTabListChanged((newTabs: TabInfo[]) => setTabs(newTabs));
  }, []);

  // Don't render on macOS (native tabs) or if only 1 tab (no strip needed)
  if (platform === 'darwin' || tabs.length <= 1) return null;

  const handleTabClick = (tabId: string) => {
    const api = (window as any).electronAPI;
    api?.focusTab(tabId);
  };

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    // Closing a non-active tab: just tell main to close that window
    // For simplicity, we only allow closing project tabs (not the menu tab)
    if (tabId === 'menu') return;
    const api = (window as any).electronAPI;
    // Focus the tab first, then close it
    api?.focusTab(tabId).then(() => {
      api?.closeCurrentTab();
    });
  };

  return (
    <div
      style={
        {
          display: 'flex',
          alignItems: 'stretch',
          height: 36,
          background: 'var(--bg-primary)',
          borderBottom: '1px solid var(--sidebar-border)',
          WebkitAppRegion: 'drag',
          paddingLeft: 4,
          paddingRight: 4,
          gap: 1,
          flexShrink: 0,
          overflow: 'hidden',
        } as React.CSSProperties
      }
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => handleTabClick(tab.id)}
          style={
            {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 12px',
              fontSize: 11,
              fontWeight: tab.active ? 600 : 400,
              color: tab.active ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: tab.active ? 'var(--bg-active)' : 'transparent',
              border: 'none',
              borderRadius: '6px 6px 0 0',
              cursor: 'pointer',
              maxWidth: 180,
              minWidth: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              WebkitAppRegion: 'no-drag',
              marginTop: 4,
              transition: 'background 0.15s, color 0.15s',
            } as React.CSSProperties
          }
          title={tab.id === 'menu' ? 'Menu' : tab.id}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.title}</span>
          {tab.type === 'project' && (
            <span
              onClick={(e) => handleCloseTab(e, tab.id)}
              style={{
                flexShrink: 0,
                width: 14,
                height: 14,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 3,
                fontSize: 12,
                lineHeight: 1,
                color: 'var(--text-tertiary)',
                opacity: 0.6,
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.opacity = '1';
                (e.target as HTMLElement).style.background = 'var(--bg-secondary)';
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.opacity = '0.6';
                (e.target as HTMLElement).style.background = 'transparent';
              }}
            >
              ×
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
