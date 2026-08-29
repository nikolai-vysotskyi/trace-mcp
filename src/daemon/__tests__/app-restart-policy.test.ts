/**
 * TRA-421 regression guard: the desktop health watchdog must not restart a
 * daemon that is provably running.
 *
 * Field evidence (2026-08-29, Nikolai's Mac): 626 daemon restarts in 13 hours,
 * median uptime 22 s, every graceful shutdown logged `reason: SIGTERM`, and
 * every one correlated with a launcher exec of `daemon restart` (222 such execs
 * inside 6-second windows around shutdowns, against ~1.4 expected by chance).
 * /health timed out while the daemon warmed O(40) registered projects; the
 * watchdog read that as death and killed it; the replacement repeated the same
 * slow warm-up.
 *
 * The policy under test lives in the Electron main bundle (which compiles
 * standalone and cannot import from src/), but the test lives here so the root
 * suite — the one CI actually runs — enforces it. The module imports only Node
 * builtins, so there is no Electron dependency to satisfy.
 */
import { describe, expect, it } from 'vitest';
import {
  shouldRestartUnreachableDaemon,
  WEDGED_DAEMON_MS,
} from '../../../packages/app/src/main/daemon-lifecycle.js';

describe('shouldRestartUnreachableDaemon', () => {
  it('does not restart a live daemon that is merely slow to answer /health', () => {
    expect(shouldRestartUnreachableDaemon({ processAlive: true, unreachableForMs: 30_000 })).toBe(
      false,
    );
  });

  it('restarts when the daemon process is actually gone', () => {
    expect(shouldRestartUnreachableDaemon({ processAlive: false, unreachableForMs: 0 })).toBe(true);
  });

  it('restarts a live daemon that has been mute past the wedged threshold', () => {
    expect(
      shouldRestartUnreachableDaemon({
        processAlive: true,
        unreachableForMs: WEDGED_DAEMON_MS + 1,
      }),
    ).toBe(true);
  });

  /**
   * The bound the issue asks for, expressed as the thing that actually caused
   * it: replay a 13-hour outage at the tray's 5 s poll cadence and count
   * restarts. The old policy fired one every ~60-75 s (the startup grace window
   * only spaced them out, it never broke the cycle).
   */
  it('caps restarts over a 13-hour outage of a live-but-busy daemon', () => {
    const POLL_MS = 5_000;
    const OUTAGE_MS = 13 * 60 * 60_000;
    let restarts = 0;
    let unreachableSince = 0;
    for (let t = 0; t < OUTAGE_MS; t += POLL_MS) {
      const unreachableForMs = t - unreachableSince;
      if (shouldRestartUnreachableDaemon({ processAlive: true, unreachableForMs })) {
        restarts++;
        unreachableSince = t; // a restart resets the outage clock
      }
    }
    const hours = OUTAGE_MS / 3_600_000;
    expect(restarts / hours).toBeLessThanOrEqual(12);
    expect(restarts).toBeLessThan(626);
  });
});
