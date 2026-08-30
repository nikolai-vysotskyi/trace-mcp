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
  DEAD_DAEMON_MS,
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
    expect(
      shouldRestartUnreachableDaemon({ processAlive: false, unreachableForMs: DEAD_DAEMON_MS }),
    ).toBe(true);
  });

  /**
   * TRA-543: launchd needs ThrottleInterval (5s) to respawn, and the
   * replacement registers its PID a moment later. A gone daemon is restarted,
   * but not again within that window — 111 of 809 sampled restart requests
   * landed under 10s after the previous one.
   */
  it('does not fire a second restart into the respawn window', () => {
    expect(shouldRestartUnreachableDaemon({ processAlive: false, unreachableForMs: 0 })).toBe(
      false,
    );
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

  /**
   * TRA-543. The simulation above modelled a restart as resetting the outage
   * clock; `tray.ts` did not do that, and its success path never cleared
   * `firstUnreachableAt` either — so in the field the wedged threshold was
   * cleared by every poll after the first slow start and the guard never fired.
   * Measured on Nikolai's machine over 22.8 h of `daemon.log`: 809 restart
   * requests, all `trace-mcp daemon restart` from the desktop app, median gap
   * 176 s, 2 s median daemon lifetime, and no daemon ever finishing its cold
   * index of 66 projects.
   *
   * Both halves of the fix are exercised here: the clock resets per restart
   * (tray.ts) and the threshold doubles per restart (this policy). A daemon
   * that can never warm up inside one window must cost a bounded number of
   * restarts per day, not a constant rate.
   */
  it('bounds restarts of a daemon that never warms up, over a full day', () => {
    const POLL_MS = 5_000;
    const DAY_MS = 24 * 3_600_000;
    let restarts = 0;
    let restartsInFirstHour = 0;
    let unreachableSince = 0;
    for (let t = 0; t < DAY_MS; t += POLL_MS) {
      if (
        shouldRestartUnreachableDaemon({
          processAlive: true,
          unreachableForMs: t - unreachableSince,
          restartsThisOutage: restarts,
        })
      ) {
        restarts++;
        if (t < 3_600_000) restartsInFirstHour++;
        unreachableSince = t; // the replacement is a new process: new clock
      }
    }
    // Steps of 5, 10, 20, 40 minutes, then hourly at the cap.
    expect(restartsInFirstHour).toBeLessThanOrEqual(4); // was ~20/h in the field
    expect(restarts).toBeLessThanOrEqual(30); // was 809 over 22.8 h
  });

  it('still restarts promptly the first time a healthy daemon goes mute', () => {
    // Escalation must not blunt the first response: a fresh outage (counter at
    // zero) keeps the plain TRA-421 threshold.
    expect(
      shouldRestartUnreachableDaemon({
        processAlive: true,
        unreachableForMs: WEDGED_DAEMON_MS,
        restartsThisOutage: 0,
      }),
    ).toBe(true);
    expect(
      shouldRestartUnreachableDaemon({
        processAlive: true,
        unreachableForMs: WEDGED_DAEMON_MS,
        restartsThisOutage: 1,
      }),
    ).toBe(false);
  });
});
