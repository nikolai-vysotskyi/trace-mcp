/**
 * TRA-1664: when a root holds more files than `security.max_files`, the walk
 * is cut to the cap — and that must be visible, not silent. The full reindex
 * flags the result (`IndexingResult.truncated`) and stamps repo metadata so
 * stats/UI keep reporting "index partial" after restarts; a later full walk
 * that fits under the cap clears the stamp.
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
import { IndexingPipeline, readIndexTruncation } from '../pipeline.js';

let workDir: string;
let db: Database.Database;
let store: Store;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'index-truncation-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  for (let i = 0; i < 5; i++) {
    writeFileSync(
      join(workDir, 'src', `m${i}.ts`),
      `export function f${i}(): number { return ${i}; }\n`,
    );
  }
  db = initializeDatabase(join(workDir, 'index.db'));
  store = new Store(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* best-effort */
  }
  rmSync(workDir, { recursive: true, force: true });
});

function makePipeline(maxFiles: number): IndexingPipeline {
  return new IndexingPipeline(
    store,
    PluginRegistry.createWithDefaults(),
    TraceMcpConfigSchema.parse({ security: { max_files: maxFiles } }),
    workDir,
  );
}

describe('indexAll under security.max_files (TRA-1664)', () => {
  it('flags the result and stamps metadata when the walk is cut', async () => {
    const pipeline = makePipeline(3);
    try {
      const r = await pipeline.indexAll();
      expect(r.truncated).toEqual({ found: 5, limit: 3 });
      expect(readIndexTruncation(store)).toEqual({ found: 5, limit: 3 });
    } finally {
      await pipeline.dispose?.();
    }
  });

  it('clears the stamp once a later full walk fits under the cap', async () => {
    const cramped = makePipeline(3);
    try {
      await cramped.indexAll();
    } finally {
      await cramped.dispose?.();
    }
    expect(readIndexTruncation(store)).toEqual({ found: 5, limit: 3 });

    const roomy = makePipeline(10_000);
    try {
      // Forced: a plain indexAll on a live index takes the incremental fast
      // path (no walk, nothing to stamp), and the index would still be
      // partial — only a full walk re-verifies the whole tree.
      const r = await roomy.indexAll(true);
      expect(r.truncated).toBeUndefined();
      expect(readIndexTruncation(store)).toBeNull();
    } finally {
      await roomy.dispose?.();
    }
  });

  it('leaves result and metadata clean when the walk fits', async () => {
    const pipeline = makePipeline(10_000);
    try {
      const r = await pipeline.indexAll();
      expect(r.truncated).toBeUndefined();
      expect(readIndexTruncation(store)).toBeNull();
    } finally {
      await pipeline.dispose?.();
    }
  });
});
