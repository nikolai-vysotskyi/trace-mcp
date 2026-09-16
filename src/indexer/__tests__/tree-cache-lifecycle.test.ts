/**
 * TRA-1577 — the per-file tree-sitter cache in the watcher-increment
 * lifecycle: an edited file reindexed via `indexFiles()` must reparse
 * incrementally (not from scratch), symbol output must stay identical, and
 * delete/rename must invalidate or move the entry.
 *
 * Uses the full default plugin registry (like production) on a scratch
 * project. Edits always change file size so the mtime+size prefilter can
 * never hash-skip them into a false "no parse happened" pass.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { getTreeCacheStats, resetTreeCacheStats } from '../../parser/tree-cache.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { IndexingPipeline } from '../pipeline.js';

let workDir: string;
let db: Database.Database;
let store: Store;
let pipeline: IndexingPipeline;

const A = 'src/a.ts';
const B = 'src/b.ts';

function write(rel: string, content: string): void {
  writeFileSync(join(workDir, rel), content);
}

function symbolsOf(rel: string): string[] {
  const file = store.getFile(rel);
  if (!file) return [];
  return store.getSymbolsByFile(file.id).map((s) => s.name);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tree-cache-lifecycle-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  write(A, 'export function alpha(): number {\n  return 1;\n}\n');
  write(B, 'export function beta(): number {\n  return 2;\n}\n');

  db = initializeDatabase(join(workDir, 'index.db'));
  store = new Store(db);
  pipeline = new IndexingPipeline(
    store,
    PluginRegistry.createWithDefaults(),
    TraceMcpConfigSchema.parse({ root: workDir }),
    workDir,
  );
  resetTreeCacheStats();
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

describe('tree cache in the watcher-increment lifecycle', () => {
  it('reparses an edited file incrementally with identical symbols', async () => {
    await pipeline.indexAll();
    expect(symbolsOf(A)).toContain('alpha');

    resetTreeCacheStats();
    write(
      A,
      'export function alpha(): number {\n  return 1;\n}\n\nexport function gamma(): number {\n  return 3;\n}\n',
    );
    const r = await pipeline.indexFiles([A]);
    expect(r.indexed).toBe(1);

    const stats = getTreeCacheStats();
    // The edited file's language-plugin parse reused the cold-index tree.
    expect(stats.incrementalParses).toBeGreaterThanOrEqual(1);
    expect(symbolsOf(A).sort()).toEqual(['alpha', 'gamma']);
    // The untouched sibling was hash-skipped, not reparsed.
    expect(symbolsOf(B)).toEqual(['beta']);
  });

  it('keeps serving incremental parses across repeated edits', async () => {
    await pipeline.indexAll();
    resetTreeCacheStats();
    for (let i = 0; i < 3; i++) {
      write(A, `export function alpha(): number {\n  return ${i + 10};\n}\n`);
      const r = await pipeline.indexFiles([A]);
      expect(r.indexed).toBe(1);
    }
    const stats = getTreeCacheStats();
    expect(stats.incrementalParses).toBeGreaterThanOrEqual(3);
    expect(symbolsOf(A)).toEqual(['alpha']);
  });

  it('deleteFiles invalidates the entry so re-creation parses from scratch', async () => {
    await pipeline.indexAll();
    write(
      A,
      'export function alpha(): number {\n  return 1;\n}\n\nexport function extra(): number {\n  return 0;\n}\n',
    );
    await pipeline.indexFiles([A]);

    resetTreeCacheStats();
    pipeline.deleteFiles([A]);
    const afterDelete = getTreeCacheStats();
    expect(afterDelete.invalidations).toBeGreaterThanOrEqual(1);

    // Re-create with identical content: the old entry is gone, so this is a
    // cold miss (full parse), not an identical hit or incremental reuse.
    write(A, 'export function alpha(): number {\n  return 1;\n}\n');
    await pipeline.indexFiles([A]);
    const stats = getTreeCacheStats();
    expect(stats.fullParses).toBeGreaterThanOrEqual(1);
    expect(stats.incrementalParses).toBe(0);
    expect(stats.identicalHits).toBe(0);
    expect(symbolsOf(A)).toEqual(['alpha']);
  });

  it('a rename moves the entry and the next edit stays incremental', async () => {
    await pipeline.indexAll();
    resetTreeCacheStats();

    // Simulate a move the watcher never reported as a delete: the old path
    // is gone from disk but its DB row is still there (a full walk would
    // reconcile-scope the row away before rename detection — the
    // watcher-driven indexFiles() path below is where renames fire).
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(workDir, B));
    write('src/c.ts', 'export function beta(): number {\n  return 2;\n}\n');
    const renamed = await pipeline.indexFiles(['src/c.ts']);
    expect(renamed.indexed).toBe(0);

    // The first edit under the new path reuses the moved entry.
    write(
      'src/c.ts',
      'export function beta(): number {\n  return 2;\n}\n\nexport function delta(): number {\n  return 4;\n}\n',
    );
    const r = await pipeline.indexFiles(['src/c.ts']);
    expect(r.indexed).toBe(1);
    const stats = getTreeCacheStats();
    expect(stats.incrementalParses).toBeGreaterThanOrEqual(1);
    expect(symbolsOf('src/c.ts').sort()).toEqual(['beta', 'delta']);
  });
});
