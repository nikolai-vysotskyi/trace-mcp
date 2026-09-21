/**
 * TRA-1017: an indexing run handed an aborted `AbortSignal` must stop at its
 * next batch/phase boundary with `IndexAbortedError` — never ride a
 * minutes-long run to completion past the daemon's shutdown deadline — and a
 * non-aborted signal must leave the happy path untouched.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { IndexAbortedError, throwIfIndexAborted } from '../index-abort.js';
import { IndexingPipeline } from '../pipeline.js';

let workDir: string;
let db: Database.Database;
let store: Store;
let pipeline: IndexingPipeline;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'index-abort-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  for (let i = 0; i < 20; i++) {
    writeFileSync(
      join(workDir, 'src', `m${i}.ts`),
      `export function f${i}(): number { return ${i}; }\n`,
    );
  }

  db = initializeDatabase(join(workDir, 'index.db'));
  store = new Store(db);
  pipeline = new IndexingPipeline(
    store,
    PluginRegistry.createWithDefaults(),
    TraceMcpConfigSchema.parse({}),
    workDir,
  );
});

afterEach(async () => {
  await pipeline.dispose?.();
  try {
    db.close();
  } catch {
    /* best-effort */
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('throwIfIndexAborted', () => {
  it('is a no-op without a signal', () => {
    expect(() => throwIfIndexAborted(undefined, workDir)).not.toThrow();
    expect(() => throwIfIndexAborted(new AbortController().signal, workDir)).not.toThrow();
  });

  it('throws IndexAbortedError once aborted', () => {
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      throwIfIndexAborted(controller.signal, workDir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IndexAbortedError);
    expect((caught as Error).name).toBe('IndexAbortedError');
  });
});

describe('indexAll with AbortSignal (TRA-1017)', () => {
  it('rejects with IndexAbortedError on a pre-aborted signal without indexing', async () => {
    const controller = new AbortController();
    controller.abort();

    const attempted = pipeline.indexAll(false, { signal: controller.signal });
    await expect(attempted).rejects.toBeInstanceOf(IndexAbortedError);
    // Nothing was persisted: the abort lands before reconcile/extract.
    expect(store.getStats().totalSymbols).toBe(0);
  });

  it('completes normally with a non-aborted signal', async () => {
    const controller = new AbortController();
    const result = await pipeline.indexAll(false, { signal: controller.signal });
    expect(result.indexed).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
    expect(store.getStats().totalSymbols).toBeGreaterThan(0);
  });

  it('stays usable after an aborted run (the lock recovers)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(pipeline.indexAll(false, { signal: controller.signal })).rejects.toBeInstanceOf(
      IndexAbortedError,
    );
    // The aborted run must not wedge the pipeline lock for the next run.
    const result = await pipeline.indexAll(false);
    expect(result.errors).toBe(0);
    expect(store.getStats().totalSymbols).toBeGreaterThan(0);
  });
});
