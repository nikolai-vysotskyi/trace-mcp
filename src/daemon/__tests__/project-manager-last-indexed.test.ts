/**
 * TRA-59: daemon-driven indexing (ProjectManager.addProject) never called
 * `updateLastIndexed`, so a project the daemon fully indexed on startup/
 * reconnect still showed "Last indexed: never" in `trace-mcp list`/`doctor`
 * forever — the registry timestamp only got set by the `add`/`init`/`upgrade`
 * CLI paths, not the daemon's own indexAll() completion.
 *
 * Mocks IndexingPipeline + FileWatcher + createServer like
 * project-manager-ancestor-watcher.test.ts so only the registry-write wiring
 * is under test, not real indexing/watching/serving.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../indexer/pipeline.js', () => {
  class FakeIndexingPipeline {
    async indexAll() {
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
    async stop() {}
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
let projectDir: string;
let pmRef: { shutdown(): Promise<void> } | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-last-indexed-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
  projectDir = join(tmpHome, 'proj');
  mkdirSync(projectDir, { recursive: true });
  pmRef = undefined;
});

afterEach(async () => {
  if (pmRef) {
    try {
      await pmRef.shutdown();
    } catch {
      /* half-initialized manager may throw on shutdown; only care resources release */
    }
    pmRef = undefined;
  }
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
}, 30_000);

describe('ProjectManager stamps lastIndexed after daemon-driven indexAll (TRA-59)', () => {
  it('updates the registry lastIndexed once the initial indexAll completes', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const { getProject } = await import('../../registry.js');
    const pm = new ProjectManager();
    pmRef = pm;

    await pm.addProject(projectDir);

    await vi.waitFor(() => {
      expect(pm.getProject(projectDir)?.status).toBe('ready');
    });

    expect(getProject(projectDir)?.lastIndexed).not.toBeNull();
  }, 30_000);
});
