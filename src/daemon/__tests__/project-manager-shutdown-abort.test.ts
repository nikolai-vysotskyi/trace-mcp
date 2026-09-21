/**
 * TRA-1017: `stopProject()` must neither ride a minutes-long initial index to
 * completion nor wedge `shutdown()` past the daemon's 20s deadline.
 *
 * Field evidence (daemon.log, 2026-09-04..06): 25 of 36 forced exits never
 * logged `Projects stopped` — `stopProject()` awaited `initialIndexPromise`
 * with no way to cancel the indexing pipeline (a 2187-file index measured
 * 188s against a 20s budget).
 *
 * Mocks IndexingPipeline + FileWatcher + createServer like
 * project-manager-shutdown-order.test.ts. The fake index observes the abort
 * signal `addProject()` now passes it, so both halves are pinned here:
 *  1. a cooperative index settles promptly via `IndexAbortedError` (fast),
 *  2. an index that ignores the abort still cannot hold shutdown past
 *     `STOP_PROJECT_INDEX_WAIT_MS` (bounded).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexAbortedError } from '../../indexer/index-abort.js';

/** Ordered log of teardown-relevant events, shared with the mocks below. */
const events: string[] = [];
/** Signal the fake index was started with (asserted aborted after shutdown). */
let capturedSignal: AbortSignal | undefined;
/** When true the fake index ignores the abort and never settles. */
let hangForever = false;

vi.mock('../../indexer/pipeline.js', () => {
  class FakeIndexingPipeline {
    async indexAll(_force?: boolean, opts?: { signal?: AbortSignal }) {
      events.push('index-start');
      capturedSignal = opts?.signal;
      if (hangForever) {
        // An index wedged where it cannot observe the abort (e.g. inside a
        // synchronous edge-resolution pass): never settles.
        await new Promise<void>(() => {});
        return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
      }
      await new Promise<void>((resolve, reject) => {
        const signal = opts?.signal;
        if (!signal) {
          resolve();
          return;
        }
        if (signal.aborted) {
          reject(new IndexAbortedError('test'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            events.push('index-aborted');
            reject(new IndexAbortedError('test'));
          },
          { once: true },
        );
      });
      events.push('index-done');
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    async indexFiles() {
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    deleteFiles() {}
    async dispose() {
      events.push('dispose');
    }
  }
  return { IndexingPipeline: FakeIndexingPipeline };
});

vi.mock('../../indexer/watcher.js', () => {
  class FakeWatcher {
    async start() {}
    async restartWithExcludes() {}
    async stop() {
      events.push('watcher-stop');
    }
  }
  return { FileWatcher: FakeWatcher };
});

vi.mock('../../server/server.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    createServer: () => ({
      server: { close: async () => undefined },
      dispose: () => undefined,
    }),
  };
});

let tmpHome: string;

beforeEach(() => {
  events.length = 0;
  capturedSignal = undefined;
  hangForever = false;
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-shutdown-abort-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
});

async function addOneProject(): Promise<{ root: string; pm: { shutdown(): Promise<void> } }> {
  const { ProjectManager } = await import('../project-manager.js');
  const root = join(tmpHome, 'proj');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  const pm = new ProjectManager();
  await pm.addProject(root);
  return { root, pm };
}

describe('ProjectManager.stopProject aborts the initial index (TRA-1017)', () => {
  it('aborts a cooperative index and completes teardown without recording an error', async () => {
    const { pm } = await addOneProject();
    expect(capturedSignal).toBeDefined();

    await pm.shutdown();

    // The stop aborted the run, and teardown continued past it.
    expect(capturedSignal!.aborted).toBe(true);
    expect(events).toContain('index-aborted');
    expect(events).toContain('dispose');
    expect(events.indexOf('index-aborted')).toBeLessThan(events.indexOf('dispose'));
  }, 30_000);

  it('bounds the wait when the index ignores the abort', async () => {
    hangForever = true;
    const { STOP_PROJECT_INDEX_WAIT_MS } = await import('../project-manager.js');
    const { pm } = await addOneProject();

    const startedAt = Date.now();
    await pm.shutdown();
    const elapsedMs = Date.now() - startedAt;

    // The full budget was honored (we wait — not skip), but shutdown cannot
    // outlast it: pre-fix this awaited forever and the daemon died to the
    // 20s forced exit instead.
    expect(elapsedMs).toBeGreaterThanOrEqual(STOP_PROJECT_INDEX_WAIT_MS);
    expect(elapsedMs).toBeLessThan(STOP_PROJECT_INDEX_WAIT_MS + 10_000);
    expect(capturedSignal!.aborted).toBe(true);
    expect(events).toContain('dispose');
  }, 30_000);
});
