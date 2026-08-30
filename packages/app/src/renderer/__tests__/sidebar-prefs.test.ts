// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampSidebarWidth,
  readSidebarCollapsed,
  readSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  splitPath,
  writeSidebarCollapsed,
  writeSidebarWidth,
} from '../sidebar-prefs';

beforeEach(() => {
  localStorage.clear();
});

describe('sidebar width', () => {
  it('clamps to the 180–320 resize range', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(240)).toBe(240);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT);
  });

  it('defaults to 220 and survives a round trip', () => {
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT);
    writeSidebarWidth(260);
    expect(readSidebarWidth()).toBe(260);
  });

  it('clamps values persisted by an older build', () => {
    // 180 was the old default and 100 the old minimum — both out of range now.
    localStorage.setItem('trace-mcp-sidebar-width', '100');
    expect(readSidebarWidth()).toBe(SIDEBAR_MIN);
  });

  it('persists the collapsed state', () => {
    expect(readSidebarCollapsed()).toBe(false);
    writeSidebarCollapsed(true);
    expect(readSidebarCollapsed()).toBe(true);
    writeSidebarCollapsed(false);
    expect(readSidebarCollapsed()).toBe(false);
  });
});

describe('splitPath', () => {
  // The `direction: rtl` truncation this replaces rendered these two as
  // `idea/workspace.xml.` and `…l__/_root/php.synthetic__`.
  it('keeps the filename intact and leaves only the directory truncatable', () => {
    expect(splitPath('.idea/workspace.xml')).toEqual({
      dir: '.idea/',
      name: 'workspace.xml',
    });
    expect(splitPath('__external__/_root/php.synthetic')).toEqual({
      dir: '__external__/_root/',
      name: 'php.synthetic',
    });
  });

  it('handles a bare filename and Windows separators', () => {
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' });
    expect(splitPath('src\\main\\tray.ts')).toEqual({ dir: 'src\\main\\', name: 'tray.ts' });
  });
});
