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
  MAX_VERSION_MISMATCH_RESTARTS,
  nextVersionMismatchAction,
  shouldRestartUnreachableDaemon,
  type VersionMismatchState,
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

  /**
   * TRA-525. Every simulation above passes `processAlive: true` — and that is
   * exactly why they stayed green while the field burned. `processAlive` is read
   * from `daemon.pid`, and until TRA-525 any losing `daemon restart` spawn could
   * overwrite that file with its own PID before losing the bind race and dying.
   * Measured on Nikolai's Mac 2026-08-30: the file named a dead process in 24%
   * of one-second samples (9/37), once naming dead PID 38747 while live PID
   * 36600 was serving.
   *
   * TRA-543's escalation bounds the loop but does not repair the input, and the
   * two branches are not interchangeable: a poisoned reading sends a healthy
   * daemon down the *dead* branch, whose base threshold is 30x tighter. So the
   * bound asserted above ("<= 4 restarts in the first hour") is a guarantee
   * about a truthful pid file, and holds only once TRA-525 keeps it truthful.
   */
  it('a poisoned daemon.pid escalates a healthy daemon down the dead-process branch', () => {
    const POLL_MS = 5_000;
    const OUTAGE_MS = 13 * 60 * 60_000;

    /** Replay a whole outage of a live-but-starved daemon; count the kills. */
    function replay(readProcessAlive: () => boolean) {
      let restarts = 0;
      let restartsInFirstHour = 0;
      let unreachableSince = 0;
      for (let t = 0; t < OUTAGE_MS; t += POLL_MS) {
        if (
          shouldRestartUnreachableDaemon({
            processAlive: readProcessAlive(),
            unreachableForMs: t - unreachableSince,
            restartsThisOutage: restarts,
          })
        ) {
          restarts++;
          if (t < 3_600_000) restartsInFirstHour++;
          unreachableSince = t;
        }
      }
      return { restarts, restartsInFirstHour };
    }

    // Poisoned: a failed spawn registered and died, so liveness reads "dead"
    // about the daemon that is actually serving.
    const poisoned = replay(() => false);
    // Repaired (TRA-525): only the process that owns the port registers, and it
    // re-asserts if the stale-file sweep removes the entry.
    const repaired = replay(() => true);

    // The dead branch starts at DEAD_DAEMON_MS, not WEDGED_DAEMON_MS, so the
    // healthy daemon is killed twice as often before the escalation catches up —
    // and past the <= 4/hour bound the test above claims.
    expect(poisoned.restartsInFirstHour).toBe(8);
    expect(repaired.restartsInFirstHour).toBe(3);
    expect(poisoned.restarts).toBeGreaterThan(repaired.restarts);
  });
});

/**
 * TRA-543, the dominant half. 716 of the 809 restart requests in the sample had
 * a 60.4 s median gap — exactly `VERSION_MISMATCH_RESTART_COOLDOWN_MS`. The
 * watchdog was not the one firing them: the version-mismatch branch on
 * checkHealth's *success* path was, once a minute, for as long as the app ran,
 * because a restart cannot change which binary is on disk.
 */
describe('nextVersionMismatchAction', () => {
  const fresh: VersionMismatchState = { seenVersion: '', restarts: 0 };

  it('restarts once when the daemon reports an older version than the app', () => {
    expect(nextVersionMismatchAction('3.5.1', '3.6.0', fresh).action).toBe('restart');
  });

  it('does nothing when the versions agree, and clears the budget', () => {
    const spent: VersionMismatchState = { seenVersion: '3.5.1', restarts: 2 };
    expect(nextVersionMismatchAction('3.6.0', '3.6.0', spent)).toEqual({
      action: 'none',
      state: { seenVersion: '', restarts: 0 },
    });
  });

  it('ignores a dev build and a daemon that reports no version', () => {
    expect(nextVersionMismatchAction('0.0.0-dev', '3.6.0', fresh).action).toBe('none');
    expect(nextVersionMismatchAction(undefined, '3.6.0', fresh).action).toBe('none');
  });

  it('gives up once the same mismatched version survives its restart budget', () => {
    let state = fresh;
    const actions: string[] = [];
    // Every minute for two hours the daemon comes back reporting the same
    // version. The old code restarted on all 120 of them.
    for (let i = 0; i < 120; i++) {
      const d = nextVersionMismatchAction('3.5.1', '3.6.0', state);
      actions.push(d.action);
      state = d.state;
    }
    expect(actions.filter((a) => a === 'restart')).toHaveLength(MAX_VERSION_MISMATCH_RESTARTS);
    expect(actions.at(-1)).toBe('give-up');
  });

  it('gives a genuinely new mismatched version its own budget', () => {
    let state = fresh;
    for (let i = 0; i < 5; i++) state = nextVersionMismatchAction('3.5.1', '3.6.0', state).state;
    // The restart did move the daemon, just not all the way: 3.5.5 is new, so
    // it is worth acting on rather than lumping in with the exhausted budget.
    const d = nextVersionMismatchAction('3.5.5', '3.6.0', state);
    expect(d.action).toBe('restart');
    expect(d.state).toEqual({ seenVersion: '3.5.5', restarts: 1 });
  });
});
