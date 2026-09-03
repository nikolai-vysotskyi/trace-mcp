/**
 * Custom tab bar for every platform, macOS included (the native AppKit tabs
 * were removed in PR 708).
 *
 * Displays a horizontal strip of tabs at the top of the window — the menu tab
 * plus one per open project. The tab list is owned by the app shell
 * (App.tsx); this component is a plain controlled view over it. Clicking a
 * tab switches the mounted view in place — no IPC round trip to main, since
 * there is only one window to begin with (TRA-698/TRA-700).
 *
 * On macOS this strip is the topmost band, so the system traffic lights are
 * drawn INSIDE it. Its height is therefore TOP_BAND_H — the same number the
 * main process derives `trafficLightPosition.y` from — and never a literal of
 * its own. A 36px strip centres at 18 while the lights centre at 22, which is
 * exactly the drift chrome-metrics.ts exists to prevent (TRA-370).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TOP_BAND_H } from '../../shared/chrome-metrics.js';

export interface TabInfo {
  id: string;
  kind: 'menu' | 'project';
  /** Present for `kind === 'project'`; equals `id`. */
  root?: string;
  title: string;
  active: boolean;
}

interface WindowTabBarProps {
  tabs: TabInfo[];
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

export function WindowTabBar({ tabs, onSelect, onClose }: WindowTabBarProps) {
  const { t } = useTranslation('shell');
  const [platform, setPlatform] = useState<string>('');

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getPlatform) return;
    api.getPlatform().then((p: string) => setPlatform(p));
  }, []);

  // Don't render if only 1 tab (no strip needed)
  if (tabs.length <= 1) return null;

  const handleCloseTab = (e: React.MouseEvent | React.KeyboardEvent, tabId: string) => {
    e.stopPropagation();
    // Only project tabs are closable — the menu tab is always available.
    if (tabId === 'menu') return;
    onClose(tabId);
  };

  return (
    <div
      style={
        {
          display: 'flex',
          alignItems: 'center',
          height: TOP_BAND_H,
          background: 'var(--surface-sunken)',
          borderBottom: '0.5px solid var(--separator)',
          WebkitAppRegion: 'drag',
          paddingLeft: platform === 'darwin' ? 78 : 4,
          paddingRight: 4,
          gap: 1,
          flexShrink: 0,
          overflow: 'hidden',
        } as React.CSSProperties
      }
    >
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          style={
            {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              padding: '0 12px',
              fontSize: 11,
              fontWeight: tab.active ? 600 : 400,
              color: tab.active ? 'var(--label)' : 'var(--label-secondary)',
              background: tab.active ? 'var(--fill-tertiary)' : 'transparent',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              maxWidth: 180,
              minWidth: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              WebkitAppRegion: 'no-drag',
              transition: 'background 0.15s, color 0.15s',
            } as React.CSSProperties
          }
          title={tab.id === 'menu' ? t('menuWindow') : tab.id}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.title}</span>
          {tab.kind === 'project' && (
            <span
              role="button"
              tabIndex={0}
              aria-label={t('closeTab', { title: tab.title })}
              onClick={(e) => handleCloseTab(e, tab.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  handleCloseTab(e, tab.id);
                }
              }}
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
                color: 'var(--label-secondary)',
                opacity: 0.6,
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.opacity = '1';
                (e.target as HTMLElement).style.background = 'var(--fill-quaternary)';
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
