/**
 * TRA-1957 — the same-thread lag monitor cannot fire while the event loop is
 * parked inside one synchronous span, so hard-stall detection lives on a
 * worker thread. These tests drive StallWatchdog with millisecond thresholds
 * against a real Worker and assert on the alert file it appends.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
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

  it('fatal path (prod default) SIGKILLs a wedged child and leaves a fatal line', async () => {
    // The prod default (fatalExit: true) never runs in-process here — a real
    // fatal would kill the test runner. Spawn the fixture child instead: it
    // runs the real StallWatchdog, wedges its own main thread, and must die
    // by signal with a `fatal` breadcrumb in the alert file.
    const childDir = mkdtempSync(join(tmpdir(), 'stall-fatal-'));
    try {
      const alertFile = join(childDir, 'stall-alerts.jsonl');
      const fixture = join(
        dirname(fileURLToPath(import.meta.url)),
        'fixtures',
        'stall-fatal-child.ts',
      );
      // Run through the tsx CLI entry (same loader the repo's own scripts
      // use) with the current node — no .bin/shell shims in between, so the
      // death below is observed first-hand. (Spawning node_modules/.bin/tsx
      // reaps through a wrapper that masks the signal as exit 137.)
      const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const child = spawn(process.execPath, [tsxCli, fixture, alertFile, '80', '250'], {
        cwd: process.cwd(),
        stdio: 'ignore',
      });
      const result = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('fatal-path child survived 20 s — watchdog did not kill it'));
          }, 20_000);
          child.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
          child.on('exit', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal });
          });
        },
      );
      // Survival would exit 42; a kill never reaches the exitCode line.
      // (With the old process.exit()-in-worker bug the child survives to 42
      // with no fatal line — that is exactly what this guards.)
      expect(result.code).not.toBe(42);
      // The kill surfaces as a signal when observed directly, or as 137
      // (128+SIGKILL) when a supervisor/shim reaps it first; Windows has no
      // signals and surfaces TerminateProcess as a nonzero code.
      const killed =
        result.signal === 'SIGKILL' ||
        result.code === 137 ||
        (process.platform === 'win32' && result.code !== 0 && result.code !== null);
      expect(killed).toBe(true);
      const kinds = readLines(alertFile).map((l) => l.kind);
      expect(kinds).toContain('stalled');
      expect(kinds).toContain('fatal');
    } finally {
      rmSync(childDir, { recursive: true, force: true });
    }
  }, 30_000);
});
