/**
 * TRA-3061: stopProject() closes the project DB while the env-indexing phase
 * (the last stage of runPipeline, after LSP + SCIP) is still in flight.
 *
 * Field evidence (daemon.log, 2026-11-13 23:39:16..27 UTC, project
 * "assetfeed"): the bounded reindex/watcher/pipeline-dispose drains all
 * timed out in sequence, `db.close()` ran anyway, and
 * `EnvIndexer.indexEnvFiles` then logged `Env indexing failed — skipping` /
 * `TypeError: The database connection is not open` — a scan still walking
 * `.env` files against a Store whose underlying db handle was already shut.
 *
 * Root cause: `indexEnvFilesUnsafe`'s per-file loop has no awaited boundary
 * and never checked the pipeline's `AbortSignal`, unlike every other phase
 * in `runPipeline` (TRA-1017's "checked BEFORE each phase's work" pattern).
 * `EnvIndexer.indexEnvFiles`'s catch-all then swallowed whatever came out,
 * including an `IndexAbortedError`, instead of letting it reach the
 * project-manager's existing non-fatal-abort classification (the same path
 * `edge-resolver.ts` / `watcher.ts` already use for a closed-DB race).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'env-indexer-stop-race-'));
  // Isolate the registry/data dir in /tmp too — descendantExcludeGlobs()
  // reads it, and this must never touch the real daemon's registry.
  vi.stubEnv('TRACE_MCP_DATA_DIR', workDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workDir, { recursive: true, force: true });
});

async function buildIndexer(envFileCount: number) {
  const { TraceMcpConfigSchema } = await import('../../config.js');
  const { initializeDatabase } = await import('../../db/schema.js');
  const { Store } = await import('../../db/store.js');
  const { EnvIndexer } = await import('../env-indexer.js');

  for (let i = 0; i < envFileCount; i++) {
    writeFileSync(join(workDir, i === 0 ? '.env' : `.env.${i}`), `KEY_${i}=value_${i}\n`);
  }

  const db = initializeDatabase(join(workDir, 'index.db'));
  const store = new Store(db);
  const config = TraceMcpConfigSchema.parse({ root: workDir });
  const indexer = new EnvIndexer(store, config, workDir);
  return { indexer, store, db };
}

describe('EnvIndexer stop race (TRA-3061)', () => {
  it('rejects with IndexAbortedError and never touches the store when already aborted', async () => {
    const { IndexAbortedError } = await import('../index-abort.js');
    const { indexer, store, db } = await buildIndexer(3);
    try {
      const insertFile = vi.spyOn(store, 'insertFile');
      const controller = new AbortController();
      controller.abort();

      await expect(indexer.indexEnvFiles(false, controller.signal)).rejects.toBeInstanceOf(
        IndexAbortedError,
      );
      expect(insertFile).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('stops mid-scan instead of writing through a DB closed by a concurrent stopProject', async () => {
    const { IndexAbortedError } = await import('../index-abort.js');
    const { indexer, store, db } = await buildIndexer(3);
    try {
      const controller = new AbortController();
      const original = store.insertFile.bind(store);
      // Simulate stopProject(): abort fires once the first file is
      // committed, then the DB closes — exactly like the field sequence
      // (indexAbortController.abort() followed by db.close() after the
      // bounded drains expire) — while this scan is still mid-loop.
      const insertFile = vi.spyOn(store, 'insertFile').mockImplementationOnce((...args) => {
        const id = original(...args);
        controller.abort();
        db.close();
        return id;
      });

      await expect(indexer.indexEnvFiles(false, controller.signal)).rejects.toBeInstanceOf(
        IndexAbortedError,
      );
      // Exactly one file reached the store before the abort was observed —
      // the loop's next iteration stopped at `throwIfIndexAborted` instead
      // of calling `store.getFile`/`insertFile` against the closed db.
      expect(insertFile).toHaveBeenCalledTimes(1);
    } finally {
      try {
        db.close();
      } catch {
        /* already closed above */
      }
    }
  });

  it('still swallows a non-abort failure (existing best-effort contract)', async () => {
    const { indexer, store, db } = await buildIndexer(1);
    try {
      vi.spyOn(store, 'getFile').mockImplementation(() => {
        throw new Error('boom');
      });
      await expect(indexer.indexEnvFiles(false)).resolves.toBeUndefined();
    } finally {
      db.close();
    }
  });
});
