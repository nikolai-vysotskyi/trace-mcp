/**
 * TRA-1553: daemon stop races in-flight index transactions.
 *
 * Field evidence (2026-09-16, overlapping postinstall respawns): a fresh
 * daemon instance was SIGTERM'd ~20 s after boot while indexing, and logged
 * `Unhandled promise rejection — "The database connection is not open"` from
 * `_IndexingPipeline.deleteFiles`. `stopProject()` closes the project DB
 * without draining or gating the single-file reindex paths (HTTP
 * `handleReindexFile`, MCP `register_edit`), which are not part of
 * `initialIndexPromise` and are never awaited by the teardown.
 *
 * The fix has three parts, each covered below:
 *  1. `stopProject` marks the project stopping (synchronously, before the
 *     first await) and both reindex entry points answer 503/busy instead of
 *     starting new pipeline work against a closing DB.
 *  2. `stopProject` drains in-flight reindexes, bounded, before `db.close()`.
 *  3. `deleteFiles` no-ops (with a warn) on an already-closed DB instead of
 *     throwing from inside an async continuation as an unhandled rejection.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../registry.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    listProjects: vi.fn(() => []),
    unregisterProject: vi.fn(),
  };
});

vi.mock('../../progress.js', () => ({
  ProgressState: vi.fn(),
  clearServerPid: vi.fn(),
  writeServerPid: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import type { IndexingResult } from '../../indexer/pipeline.js';
import type { withLock } from '../../utils/pid-lock.js';
import { ProjectManager } from '../project-manager.js';
import {
  beginReindex,
  clearProjectStopping,
  handleReindexFile,
  isProjectStopping,
  markProjectStopping,
  waitForReindexDrain,
} from '../reindex-file-handler.js';

const PROJECT = '/tmp/reindex-stop-race-proj';

/** Run the body through the lock instead of the real PID lock files. */
const directLock = (async (_opts: unknown, fn: () => Promise<IndexingResult>) =>
  fn()) as typeof withLock;

afterEach(() => {
  clearProjectStopping(PROJECT);
});

describe('project stopping marks (TRA-1553)', () => {
  it('is not stopping by default, marks and clears', () => {
    expect(isProjectStopping(PROJECT)).toBe(false);
    markProjectStopping(PROJECT);
    expect(isProjectStopping(PROJECT)).toBe(true);
    clearProjectStopping(PROJECT);
    expect(isProjectStopping(PROJECT)).toBe(false);
  });

  it('normalizes the key so beginReindex and the stop path meet', () => {
    const end = beginReindex(`${PROJECT}/`);
    try {
      // No wait — the drain must see work begun under a differently-spelled
      // but identical path.
      expect(isProjectStopping(PROJECT)).toBe(false);
      markProjectStopping(PROJECT);
      expect(isProjectStopping(`${PROJECT}/`)).toBe(true);
    } finally {
      end();
    }
  });
});

describe('handleReindexFile stopping gate (TRA-1553)', () => {
  it('answers 503 and never touches the pipeline while the project is stopping', async () => {
    const indexFiles = vi.fn(async () => ({
      totalFiles: 1,
      indexed: 1,
      skipped: 0,
      errors: 0,
      durationMs: 1,
    }));
    markProjectStopping(PROJECT);
    const result = await handleReindexFile(
      { project: PROJECT, path: 'a.ts' },
      {
        getProject: () => ({ pipeline: { indexFiles }, status: 'ready' as const }),
        lock: directLock,
      },
    );
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: 'project is stopping',
      retryAfterSec: 5,
    });
    expect(indexFiles).not.toHaveBeenCalled();
  });

  it('still serves a ready project that is not stopping', async () => {
    const indexFiles = vi.fn(async () => ({
      totalFiles: 1,
      indexed: 1,
      skipped: 0,
      errors: 0,
      durationMs: 1,
    }));
    const result = await handleReindexFile(
      { project: PROJECT, path: 'a.ts' },
      {
        getProject: () => ({ pipeline: { indexFiles }, status: 'ready' as const }),
        lock: directLock,
      },
    );
    expect(result).toEqual({ ok: true, relPath: 'a.ts' });
    expect(indexFiles).toHaveBeenCalledTimes(1);
  });
});

describe('waitForReindexDrain (TRA-1553)', () => {
  it('resolves true immediately when nothing is in flight', async () => {
    await expect(waitForReindexDrain(PROJECT, 50)).resolves.toBe(true);
  });

  it('resolves true once the in-flight reindex ends', async () => {
    const end = beginReindex(PROJECT);
    let drained: boolean | undefined;
    const waiting = waitForReindexDrain(PROJECT, 2_000).then((v) => {
      drained = v;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(drained).toBeUndefined();
    end();
    await waiting;
    expect(drained).toBe(true);
  });

  it('resolves false on timeout instead of hanging shutdown', async () => {
    const end = beginReindex(PROJECT);
    try {
      await expect(waitForReindexDrain(PROJECT, 50)).resolves.toBe(false);
    } finally {
      end();
    }
  });
});

interface FakeManaged {
  root: string;
  config: unknown;
  db: { close: ReturnType<typeof vi.fn> };
  store: unknown;
  registry: unknown;
  progress: unknown;
  pipeline: { dispose: ReturnType<typeof vi.fn> };
  watcher: { stop: ReturnType<typeof vi.fn> };
  server: { close: ReturnType<typeof vi.fn> };
  serverHandle: { dispose: ReturnType<typeof vi.fn> };
  status: 'ready';
}

function injectProject(pm: ProjectManager, root: string, events: string[]): FakeManaged {
  const fake: FakeManaged = {
    root,
    config: {},
    db: {
      close: vi.fn(() => {
        events.push('db-close');
      }),
    },
    store: {},
    registry: {},
    progress: {},
    pipeline: { dispose: vi.fn(async () => undefined) },
    watcher: {
      stop: vi.fn(async () => {
        events.push('watcher-stop');
      }),
    },
    server: { close: vi.fn(async () => undefined) },
    serverHandle: { dispose: vi.fn() },
    status: 'ready',
  };
  // biome-ignore lint/suspicious/noExplicitAny: bypassing private state for behavioural test
  (pm as unknown as { projects: Map<string, FakeManaged> }).projects.set(root, fake);
  return fake;
}

describe('ProjectManager.shutdown reindex drain (TRA-1553)', () => {
  it('marks stopping before the watcher stops and drains in-flight reindexes before db.close', async () => {
    const events: string[] = [];
    const pm = new ProjectManager();
    const fake = injectProject(pm, PROJECT, events);
    fake.watcher.stop = vi.fn(async () => {
      events.push('watcher-stop');
      // The gate must already be up while teardown is still early.
      expect(isProjectStopping(PROJECT)).toBe(true);
    });

    const end = beginReindex(PROJECT);
    const shutdown = pm.shutdown();
    // Let shutdown reach the drain, then release the reindex the way a
    // finishing register_edit/register-file run would.
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.db.close).not.toHaveBeenCalled();
    events.push('reindex-end');
    end();
    await shutdown;

    expect(fake.db.close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['watcher-stop', 'reindex-end', 'db-close']);
    // The mark is cleared with the project — a later re-add is servable.
    expect(isProjectStopping(PROJECT)).toBe(false);
  });

  it('still shuts down when a reindex never ends (drain is bounded)', async () => {
    const events: string[] = [];
    const pm = new ProjectManager();
    injectProject(pm, PROJECT, events);
    const end = beginReindex(PROJECT);
    try {
      await pm.shutdown();
    } finally {
      end();
    }
    expect(events).toEqual(['watcher-stop', 'db-close']);
  }, 15_000);
});

describe('IndexingPipeline.deleteFiles on a closed DB (TRA-1553)', () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('no-ops instead of throwing "database connection is not open"', async () => {
    const { TraceMcpConfigSchema } = await import('../../config.js');
    const { initializeDatabase } = await import('../../db/schema.js');
    const { Store } = await import('../../db/store.js');
    const { PluginRegistry } = await import('../../plugin-api/registry.js');
    const { IndexingPipeline } = await import('../../indexer/pipeline.js');

    workDir = mkdtempSync(join(tmpdir(), 'deletefiles-closed-db-'));
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'src/a.ts'), 'export const a = 1;\n');
    const db = initializeDatabase(join(workDir, 'index.db'));
    const store = new Store(db);
    const pipeline = new IndexingPipeline(
      store,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({ root: workDir }),
      workDir,
    );
    await pipeline.indexAll();
    db.close();

    expect(() => pipeline.deleteFiles(['src/a.ts'])).not.toThrow();
    await pipeline.dispose?.();
  });
});
