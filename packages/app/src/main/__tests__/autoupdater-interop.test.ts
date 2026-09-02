import type { AppUpdater } from 'electron-updater';
import { describe, expect, it } from 'vitest';
import { resolveAutoUpdaterExport } from '../autoupdater-interop';

describe('resolveAutoUpdaterExport', () => {
  it('reads autoUpdater off the module namespace', () => {
    const autoUpdater = {} as AppUpdater;
    expect(resolveAutoUpdaterExport({ autoUpdater })).toBe(autoUpdater);
  });

  it('falls back to the default namespace when interop lands it there', () => {
    const autoUpdater = {} as AppUpdater;
    expect(resolveAutoUpdaterExport({ default: { autoUpdater } })).toBe(autoUpdater);
  });

  // TRA-687: builds <=3.10.0 called `.autoDownload` on `undefined` here
  // instead of failing loudly — this pins the throw so a future interop
  // shift breaks a test, not a shipped menu.
  it('throws instead of silently returning undefined', () => {
    expect(() => resolveAutoUpdaterExport({})).toThrow('electron-updater did not export autoUpdater');
    expect(() => resolveAutoUpdaterExport({ default: {} })).toThrow(
      'electron-updater did not export autoUpdater',
    );
  });
});
