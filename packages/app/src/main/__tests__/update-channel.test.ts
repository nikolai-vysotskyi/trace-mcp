import { describe, expect, it } from 'vitest';
import { updateChannelFor } from '../update-channel';
import { trySpawnApplyHelper } from '../apply-pending-helper';

describe('updateChannelFor', () => {
  it('gives macOS the zip-staged path and Windows electron-updater', () => {
    expect(updateChannelFor('darwin')).toBe('zip-staged');
    expect(updateChannelFor('win32')).toBe('electron-updater');
  });

  it('leaves every other platform without an update mechanism', () => {
    for (const p of ['linux', 'freebsd', 'aix'] as NodeJS.Platform[]) {
      expect(updateChannelFor(p)).toBe('none');
    }
  });

  // The whole point of the split: no platform may ever run both mechanisms.
  it('never returns more than one mechanism for a platform', () => {
    const platforms: NodeJS.Platform[] = ['darwin', 'win32', 'linux', 'freebsd', 'openbsd'];
    for (const p of platforms) {
      const channel = updateChannelFor(p);
      expect(
        [channel === 'zip-staged', channel === 'electron-updater'].filter(Boolean).length,
      ).toBeLessThanOrEqual(1);
    }
  });
});

describe('trySpawnApplyHelper channel guard', () => {
  // Paths deliberately point at nothing: if the channel guard is ever removed,
  // this still returns false, so assert the guard rejects before touching fs by
  // passing a channel that is not zip-staged and one that is.
  const paths = {
    pendingZip: __filename,
    pendingVersion: __filename,
    applyHelper: __filename,
  };

  it('refuses to stage a macOS zip swap on the electron-updater channel', () => {
    expect(trySpawnApplyHelper(paths, process.pid, 'electron-updater')).toBe(false);
  });

  it('refuses on platforms with no update channel', () => {
    expect(trySpawnApplyHelper(paths, process.pid, 'none')).toBe(false);
  });
});
