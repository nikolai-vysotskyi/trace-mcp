/**
 * TRA-3061 (Reviewer F follow-up on PR #1908): the per-file loop in
 * `indexEnvFilesUnsafe` checks `AbortSignal` between files, but `await
 * fg(...)` — the glob that produces that file list — is itself an await
 * boundary a project stop can land in. Landing there with an empty result
 * used to skip straight to `pruneStaleEnvFiles()` (and a non-empty result
 * straight into the loop) with no abort check in between, so an abort
 * firing while the glob was still pending reached the store again after
 * `stopProject()` had already closed it — silently, since
 * `findStaleEnvFileIds()` swallows store errors into an empty array rather
 * than surfacing them.
 *
 * `fast-glob` is mocked (module-scoped to this file only, so the other
 * env-indexer suites keep exercising the real glob) to hold the promise
 * open long enough to interleave a real `controller.abort()` + `db.close()`
 * — the actual event-loop interleaving `stopProject()` produces, not a
 * synchronous same-tick abort a cooperative check could never observe.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let resolveGlob: ((paths: string[]) => void) | undefined;

vi.mock('fast-glob', () => ({
  default: vi.fn(
    () =>
      new Promise<string[]>((resolve) => {
        resolveGlob = resolve;
      }),
  ),
}));

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'env-indexer-glob-abort-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', workDir);
  resolveGlob = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workDir, { recursive: true, force: true });
});

describe('EnvIndexer stop race during the async glob (TRA-3061, Reviewer F)', () => {
  it('rejects with IndexAbortedError instead of pruning against a closed DB on an empty glob result', async () => {
    const { TraceMcpConfigSchema } = await import('../../config.js');
    const { initializeDatabase } = await import('../../db/schema.js');
    const { Store } = await import('../../db/store.js');
    const { EnvIndexer } = await import('../env-indexer.js');
    const { IndexAbortedError } = await import('../index-abort.js');

    const db = initializeDatabase(join(workDir, 'index.db'));
    const store = new Store(db);
    const config = TraceMcpConfigSchema.parse({ root: workDir });
    const indexer = new EnvIndexer(store, config, workDir);
    const getAllFiles = vi.spyOn(store, 'getAllFiles');

    try {
      const controller = new AbortController();
      const pending = indexer.indexEnvFiles(false, controller.signal);

      // Let the mocked fg() promise actually get constructed and awaited
      // before interleaving the stop — matches the real ordering, where
      // the glob is in flight when stopProject() runs. `indexEnvFilesUnsafe`
      // awaits `initContentHasher()` before calling `fg()`, so a single
      // macrotask tick isn't a reliable bound under load (flaked in the
      // full suite run); poll instead of assuming one `setTimeout(0)` tick.
      await vi.waitFor(() => expect(resolveGlob).toBeDefined(), { timeout: 2_000 });

      // Simulate stopProject(): abort the pipeline signal, then close the
      // DB, exactly as the daemon does once its bounded drains expire —
      // while the glob this run is awaiting hasn't resolved yet.
      controller.abort();
      db.close();
      resolveGlob?.([]); // empty .env list — the exact gap Reviewer F found

      await expect(pending).rejects.toBeInstanceOf(IndexAbortedError);
      // The fix must stop before `pruneStaleEnvFiles()` ever queries the
      // (now closed) store — not merely swallow the resulting error.
      expect(getAllFiles).not.toHaveBeenCalled();
    } finally {
      try {
        db.close();
      } catch {
        /* already closed above */
      }
    }
  });
});
