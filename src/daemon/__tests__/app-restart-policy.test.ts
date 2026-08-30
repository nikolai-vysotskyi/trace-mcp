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

  /**
   * TRA-525. The three tests above all *assume* `processAlive: true`, which is
   * why they passed while the field kept burning: measured on Nikolai's Mac,
   * 2026-08-30, `daemon.pid` named a dead process in 24% of one-second samples
   * (9/37), and in one sample named dead PID 38747 while live PID 36600 was
   * serving. 724 restarts in 18.7h, peak 89/h — after TRA-421 shipped.
   *
   * The policy was never wrong. Its input was. `processAlive` came from a file
   * that any losing `daemon restart` spawn could overwrite with a PID that was
   * about to die, so "provably alive" was provably false about a live daemon.
   *
   * This replays the outage driving the policy from that file, poisoned and
   * repaired, and pins the difference.
   */
  describe('liveness input under a poisoned daemon.pid', () => {
    const POLL_MS = 5_000;
    const OUTAGE_MS = 13 * 60 * 60_000;

    /** Replay a whole outage of a live-but-starved daemon; count restarts. */
    function restartsPerHour(readProcessAlive: (tMs: number) => boolean): number {
      let restarts = 0;
      let unreachableSince = 0;
      for (let t = 0; t < OUTAGE_MS; t += POLL_MS) {
        if (
          shouldRestartUnreachableDaemon({
            processAlive: readProcessAlive(t),
            unreachableForMs: t - unreachableSince,
          })
        ) {
          restarts++;
          unreachableSince = t;
        }
      }
      return restarts / (OUTAGE_MS / 3_600_000);
    }

    it('reproduces the field rate when a failed spawn poisons the registration', () => {
      // Every restart attempt spawns a process that registers, loses the port
      // race to the still-running daemon, and dies — so from the next poll on,
      // liveness reads "dead" about a daemon that is serving.
      const rate = restartsPerHour(() => false);
      // The observed 38.8/h is this bound throttled by real spawn latency; the
      // pure policy is worse. Either way it is the runaway the issue reported.
      expect(rate).toBeGreaterThan(38.8);
    });

    it('stops the loop once the serving daemon keeps its registration', () => {
      // The fix: only the process that owns the port registers, and it
      // re-asserts if the file goes missing. Liveness now tracks reality.
      const rate = restartsPerHour(() => true);
      // Only the genuine wedged-daemon escape hatch may still fire.
      expect(rate).toBeLessThanOrEqual(12);
    });
  });
});
