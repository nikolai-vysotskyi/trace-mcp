/**
 * TRA-2095: a watcher batch aborted mid-flight (project stopped/unloaded,
 * ephemeral root vanished) must not log one `error` line per file.
 *
 * Field evidence (daemon.log, 3.34.5 pid 27341): 290 `level: 50`
 * `reindex-file telemetry (error)` lines with `IndexAbortedError` for a
 * single vanished `/private/tmp/multica-task-*` root — one bulk pass, one
 * expected abort, 290 error lines drowning the error budget.
 *
 * Contract pinned here: abort → exactly one `warn` summary for the batch
 * and zero `error` lines; a genuine (non-abort) failure keeps the per-file
 * `error` lines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));

/** 'abort' → indexFiles rejects with IndexAbortedError; 'error' → generic Error. */
const mode = vi.hoisted(() => ({ current: 'abort' as 'abort' | 'error' }));

/** Watcher paths-callback captured from FileWatcher.start. */
const captured = vi.hoisted((): { cb?: (paths: string[]) => Promise<void> } => ({}));

vi.mock('../../logger.js', () => ({
  logger: loggerMocks,
}));

vi.mock('../../indexer/pipeline.js', async () => {
  const { IndexAbortedError } = await import('../../indexer/index-abort.js');
  class FakeIndexingPipeline {
    async indexAll() {
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    async indexFiles() {
      if (mode.current === 'abort') throw new IndexAbortedError('root vanished mid-batch');
      throw new Error('disk boom');
    }
    deleteFiles() {}
    async dispose() {}
  }
  return { IndexingPipeline: FakeIndexingPipeline, IndexAbortedError };
});

vi.mock('../../indexer/watcher.js', () => {
  class FakeWatcher {
    async start(_root: string, _config: unknown, cb: (paths: string[]) => Promise<void>) {
      captured.cb = cb;
    }
    async restartWithExcludes() {}
    async stop() {}
    async unsubscribe() {}
    async drain() {}
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
  mode.current = 'abort';
  captured.cb = undefined;
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-watcher-abort-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
});

async function addProjectWithWatcher(): Promise<{ root: string; files: string[] }> {
  const { ProjectManager } = await import('../project-manager.js');
  const root = join(tmpHome, 'proj');
  mkdirSync(root, { recursive: true });
  const files = ['a.ts', 'b.ts', 'c.ts'].map((f) => {
    const abs = join(root, f);
    writeFileSync(abs, 'export const x = 1;\n');
    return abs;
  });
  const pm = new ProjectManager();
  await pm.addProject(root);
  await pm.shutdown();
  expect(captured.cb).toBeDefined();
  return { root, files };
}

describe('ProjectManager watcher batch abort telemetry (TRA-2095)', () => {
  it('collapses an aborted batch into one warn line and zero error lines', async () => {
    mode.current = 'abort';
    const { root, files } = await addProjectWithWatcher();
    const { getReindexStats } = await import('../reindex-stats.js');
    const before = getReindexStats().summarize();
    vi.clearAllMocks();

    // The batch still rejects to the watcher after telemetry (existing
    // contract — project-manager.ts rethrows watchErr past the finally).
    await expect(captured.cb!(files)).rejects.toThrow('root vanished');

    expect(loggerMocks.error).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = loggerMocks.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload.event).toBe('reindex-file');
    expect(payload.project).toBe(root);
    expect(payload.fileCount).toBe(3);
    expect(String(msg).toLowerCase()).toContain('abort');
    expect(getReindexStats().summarize().errors - before.errors).toBe(0);
    // TRA-1854: 60s, not 30s — cold daemon-graph import on a loaded
    // windows-latest runner eats most of a smaller cap (same family as TRA-1839).
  }, 60_000);

  it('keeps per-file error lines for a genuine (non-abort) batch failure', async () => {
    mode.current = 'error';
    const { files } = await addProjectWithWatcher();
    const { getReindexStats } = await import('../reindex-stats.js');
    const before = getReindexStats().summarize();
    vi.clearAllMocks();

    await expect(captured.cb!(files)).rejects.toThrow('disk boom');

    expect(loggerMocks.error).toHaveBeenCalledTimes(3);
    expect(loggerMocks.warn).not.toHaveBeenCalled();
    expect(getReindexStats().summarize().errors - before.errors).toBe(3);
  }, 60_000);
});
