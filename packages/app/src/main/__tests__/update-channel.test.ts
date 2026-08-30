import { describe, expect, it } from 'vitest';
import { updateChannelFor } from '../update-channel';

describe('updateChannelFor', () => {
  it('gives both packaged platforms electron-updater', () => {
    expect(updateChannelFor('darwin')).toBe('electron-updater');
    expect(updateChannelFor('win32')).toBe('electron-updater');
  });

  it('leaves every other platform without an update mechanism', () => {
    for (const p of ['linux', 'freebsd', 'aix'] as NodeJS.Platform[]) {
      expect(updateChannelFor(p)).toBe('none');
    }
  });

  /* TRA-437 deleted the second mechanism. The type is the guard now: a channel
     that could stage a bundle swap no longer exists, so a platform cannot be
     given one by accident. Asserted as a value check because the type is
     erased at runtime and this file is what a future edit would have to break. */
  it('has no bundle-swapping channel left to return', () => {
    const platforms: NodeJS.Platform[] = ['darwin', 'win32', 'linux', 'freebsd', 'openbsd'];
    for (const p of platforms) {
      expect(['electron-updater', 'none']).toContain(updateChannelFor(p));
    }
  });
});
