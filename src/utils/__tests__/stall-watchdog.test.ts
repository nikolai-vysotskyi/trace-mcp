/**
 * TRA-1957 — the same-thread lag monitor cannot fire while the event loop is
 * parked inside one synchronous span, so hard-stall detection lives on a
 * worker thread. These tests drive StallWatchdog with millisecond thresholds
 * against a real Worker and assert on the alert file it appends.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StallWatchdog } from '../stall-watchdog.js';
import type { StallWatchdogOptions } from '../stall-watchdog.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readLines(alertFile: string): Array<Record<string, unknown>> {
  let text = '';
  try {
    text = readFileSync(alertFile, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('StallWatchdog (TRA-1957)', () => {
  let dir: string;
  let watchdogs: StallWatchdog[] = [];

  afterEach(async () => {
    for (const w of watchdogs) await w.stop();
    watchdogs = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function start(opts?: Partial<StallWatchdogOptions>): {
    watchdog: StallWatchdog;
    alertFile: string;
  } {
    dir = mkdtempSync(join(tmpdir(), 'stall-watchdog-'));
    const alertFile = join(dir, 'stall-alerts.jsonl');
    const watchdog = new StallWatchdog({
      alertFile,
      checkIntervalMs: 20,
      alertAfterMs: 80,
      fatalAfterMs: 200,
      fatalExit: false,
      ...opts,
    });
    watchdogs.push(watchdog);
    watchdog.start();
    return { watchdog, alertFile };
  }

  it('writes stalled then fatal then recovered as beats stop and resume', async () => {
    const { watchdog, alertFile } = start();
    expect(watchdog.running).toBe(true);

    // No beats after start's initial one — the worker must notice.
    await sleep(350);
    // Resume beating and keep it up — the worker must close the episode
    // and stay quiet afterwards.
    for (let i = 0; i < 8; i++) {
      watchdog.beat();
      await sleep(15);
    }

    const kinds = readLines(alertFile).map((l) => l.kind);
    expect(kinds).toContain('stalled');
    expect(kinds).toContain('fatal');
    expect(kinds[kinds.length - 1]).toBe('recovered');
    expect(kinds.indexOf('stalled')).toBeLessThan(kinds.indexOf('fatal'));
    expect(kinds.indexOf('fatal')).toBeLessThan(kinds.indexOf('recovered'));

    await watchdog.stop();
    expect(watchdog.running).toBe(false);
  }, 15_000);

  it('stays quiet while beats keep flowing', async () => {
    const { alertFile } = start();
    // Beat faster than the alert threshold for the whole window.
    const end = Date.now() + 300;
    while (Date.now() < end) {
      for (const w of watchdogs) w.beat();
      await sleep(10);
    }
    await sleep(60);
    expect(readLines(alertFile)).toEqual([]);
  }, 15_000);

  it('fires while the main thread is blocked synchronously', async () => {
    // The incident in miniature: a wedged sqlite3_step parks the event loop
    // inside one synchronous span, so no same-thread timer can fire — but
    // the worker thread keeps checking and must still report the stall.
    const { alertFile } = start({ fatalAfterMs: 10_000 });
    const end = Date.now() + 250;
    while (Date.now() < end) {
      // busy-wait: the point is that the main thread cannot beat or log here
    }
    await sleep(150);
    const kinds = readLines(alertFile).map((l) => l.kind);
    expect(kinds).toContain('stalled');
  }, 15_000);

  it('stop() before any stall leaves no trace and is idempotent', async () => {
    const { watchdog, alertFile } = start();
    await watchdog.stop();
    await watchdog.stop();
    expect(watchdog.running).toBe(false);
    await sleep(150);
    expect(readLines(alertFile)).toEqual([]);
  }, 15_000);
});
