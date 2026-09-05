/**
 * TRA-834: shutdown must unsubscribe the file watcher before it waits on the
 * initial index.
 *
 * Field evidence (daemon.log, 2026-09-03..04): every "File change handler
 * failed / The database connection is not open" landed AFTER "Daemon shutting
 * down" for the same pid — one project logged five of them spread over 27
 * seconds. Cause: `stopProject` awaited `initialIndexPromise` first, and the
 * still-subscribed watcher kept scheduling indexing runs against stores that
 * were being closed.
 *
 * Mocks IndexingPipeline + FileWatcher + createServer like
 * project-manager-ephemeral-sweep.test.ts, so only the teardown ordering is
 * under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Ordered log of teardown-relevant events, shared with the mocks below. */
const events: string[] = [];
/** Resolves the fake initial index — held open until the test releases it. */
let releaseIndex: () => void = () => {};

vi.mock('../../indexer/pipeline.js', () => {
  class FakeIndexingPipeline {
    async indexAll() {
      events.push('index-start');
      await new Promise<void>((resolve) => {
        releaseIndex = () => {
          events.push('index-done');
          resolve();
        };
      });
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    async indexFiles() {
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    deleteFiles() {}
    async dispose() {}
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
  releaseIndex = () => {};
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-shutdown-order-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('ProjectManager.shutdown teardown order (TRA-834)', () => {
  it('stops the watcher before waiting for the in-flight initial index', async () => {
    const { ProjectManager } = await import('../project-manager.js');

    const root = join(tmpHome, 'proj');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');

    const pm = new ProjectManager();
    await pm.addProject(root);

    const shutdown = pm.shutdown();
    // Give shutdown a few turns to reach its first await, then release the
    // index. With the old ordering, `watcher-stop` could only appear after
    // `index-done`.
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseIndex();
    await shutdown;

    expect(events).toContain('watcher-stop');
    expect(events).toContain('index-done');
    expect(events.indexOf('watcher-stop')).toBeLessThan(events.indexOf('index-done'));
  }, 30_000);
});
