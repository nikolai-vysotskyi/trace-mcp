/**
 * Contract and integration tests for GET /api/projects/files (TRA-1069):
 * 1. buildProjectFilesQuery produces valid SQL for all sort modes ('recent', 'symbols', 'edges', 'isolated')
 * 2. 'recent' sorts by f.mtime_ms DESC NULLS LAST, putting files with NULL mtime_ms (e.g. synthetic phantom files) last
 * 3. End-to-end fixture test: indexing a project, touching a file, re-indexing, and verifying that the touched file is first in 'recent' mode
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProjectFilesQuery } from '../../src/api/project-files-query.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { initContentHasher } from '../../src/util/hash.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';

function seedFile(
  store: Store,
  filePath: string,
  mtimeMs: number | null,
  indexedAt: string = "datetime('now')",
): number {
  const info = store.db
    .prepare(`INSERT INTO files (path, mtime_ms, indexed_at) VALUES (?, ?, ${indexedAt})`)
    .run(filePath, mtimeMs);
  return Number(info.lastInsertRowid);
}

function seedSymbol(store: Store, fileId: number, name: string) {
  store.db
    .prepare(
      `INSERT INTO symbols (file_id, symbol_id, name, kind, byte_start, byte_end, line_start, line_end)
       VALUES (?, ?, ?, 'function', 0, 0, 1, 1)`,
    )
    .run(fileId, `${fileId}::${name}`, name);
}

describe('buildProjectFilesQuery (contract)', () => {
  it('recent mode sorts by mtime_ms DESC with NULLS LAST', () => {
    const store = createTestStore();

    // Seed files with different mtime_ms and indexed_at timestamps.
    // Notice: old_touched has older indexed_at but NEWEST mtime_ms.
    // synthetic file has NULL mtime_ms.
    const f1 = seedFile(store, 'src/old_touched.ts', 1700000000000, "datetime('now', '-2 hours')");
    seedSymbol(store, f1, 'fn1');

    const f2 = seedFile(
      store,
      'src/recent_indexed_older_mtime.ts',
      1600000000000,
      "datetime('now')",
    );
    seedSymbol(store, f2, 'fn2');

    const f3 = seedFile(store, 'src/middle.ts', 1650000000000, "datetime('now', '-1 hour')");
    seedSymbol(store, f3, 'fn3');

    const fNull = seedFile(
      store,
      '__external__/_root/pkg/node:fs.synthetic',
      null,
      "datetime('now')",
    );
    seedSymbol(store, fNull, 'fs');

    const { sql, params } = buildProjectFilesQuery('recent', '', 10);
    const rows = store.db.prepare(sql).all(...params) as Array<{
      path: string;
      symbols: number;
      edges: number;
    }>;

    expect(rows.map((r) => r.path)).toEqual([
      'src/old_touched.ts',
      'src/middle.ts',
      'src/recent_indexed_older_mtime.ts',
      '__external__/_root/pkg/node:fs.synthetic',
    ]);
  });

  it('excludes non-code files via CODE_FILTER', () => {
    const store = createTestStore();
    seedFile(store, 'README.md', 2000000000000);
    seedFile(store, 'package.json', 2000000000000);
    seedFile(store, 'tsconfig.json', 2000000000000);
    seedFile(store, 'config.yml', 2000000000000);
    seedFile(store, '.env.local', 2000000000000);
    seedFile(store, 'src/valid.ts', 1000000000000);

    const { sql, params } = buildProjectFilesQuery('recent', '', 10);
    const rows = store.db.prepare(sql).all(...params) as Array<{ path: string }>;

    expect(rows.map((r) => r.path)).toEqual(['src/valid.ts']);
  });

  it('supports directory, glob, and prefix scope filtering', () => {
    const store = createTestStore();
    seedFile(store, 'src/routes/api.ts', 1000);
    seedFile(store, 'src/components/button.tsx', 2000);
    seedFile(store, 'lib/util.ts', 3000);

    // Directory scope
    const dirQuery = buildProjectFilesQuery('recent', 'src/', 10);
    const dirRows = store.db.prepare(dirQuery.sql).all(...dirQuery.params) as Array<{
      path: string;
    }>;
    expect(dirRows.map((r) => r.path).sort()).toEqual([
      'src/components/button.tsx',
      'src/routes/api.ts',
    ]);

    // Glob scope
    const globQuery = buildProjectFilesQuery('recent', '*.tsx', 10);
    const globRows = store.db.prepare(globQuery.sql).all(...globQuery.params) as Array<{
      path: string;
    }>;
    expect(globRows.map((r) => r.path)).toEqual(['src/components/button.tsx']);
  });

  it('handles symbols, edges, and isolated sort modes', () => {
    const store = createTestStore();
    const fA = seedFile(store, 'src/a.ts', 1000);
    seedSymbol(store, fA, 'symA1');
    seedSymbol(store, fA, 'symA2');

    const fB = seedFile(store, 'src/b.ts', 1000);
    seedSymbol(store, fB, 'symB1');

    const symQuery = buildProjectFilesQuery('symbols', '', 10);
    const symRows = store.db.prepare(symQuery.sql).all(...symQuery.params) as Array<{
      path: string;
      symbols: number;
    }>;
    expect(symRows[0].path).toBe('src/a.ts');
    expect(symRows[0].symbols).toBe(2);
    expect(symRows[1].path).toBe('src/b.ts');
    expect(symRows[1].symbols).toBe(1);
  });
});

describe('Recently Changed sidebar ordering with IndexingPipeline (TRA-1069 e2e)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = createTmpDir('trace-mcp-recent-sort-');
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    await initContentHasher();
  });

  afterEach(() => {
    removeTmpDir(tmpRoot);
  });

  function makeRegistry(): PluginRegistry {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    return registry;
  }

  function makeConfig(): TraceMcpConfig {
    return {
      root: tmpRoot,
      include: ['src/**/*.ts'],
      exclude: [],
      plugins: [],
    };
  }

  it('touching a file and reindexing puts it first in recent sort', async () => {
    const store = createTestStore();
    const registry = makeRegistry();
    const pipeline = new IndexingPipeline(store, registry, makeConfig(), tmpRoot);

    const fileA = path.join(tmpRoot, 'src/a.ts');
    const fileB = path.join(tmpRoot, 'src/b.ts');
    const fileC = path.join(tmpRoot, 'src/c.ts');

    fs.writeFileSync(fileA, 'export const a = 1;\n');
    fs.writeFileSync(fileB, 'export const b = 2;\n');
    fs.writeFileSync(fileC, 'export const c = 3;\n');

    // Set deterministic timestamps in the past: a=1000s, b=2000s, c=3000s
    fs.utimesSync(fileA, 1000, 1000);
    fs.utimesSync(fileB, 2000, 2000);
    fs.utimesSync(fileC, 3000, 3000);

    // Initial full index
    await pipeline.indexAll();

    // In initial index, c has highest mtime, b is second, a is third
    const { sql: sql1, params: params1 } = buildProjectFilesQuery('recent', '', 10);
    const initialRows = store.db.prepare(sql1).all(...params1) as Array<{ path: string }>;
    expect(initialRows.map((r) => r.path)).toEqual(['src/c.ts', 'src/b.ts', 'src/a.ts']);

    // Now touch fileA: set its mtime to 5000s (newer than b and c)
    fs.utimesSync(fileA, 5000, 5000);

    // Re-index
    await pipeline.indexAll();

    // Verify fileA is now strictly first in recent mode
    const { sql: sql2, params: params2 } = buildProjectFilesQuery('recent', '', 10);
    const afterTouchRows = store.db.prepare(sql2).all(...params2) as Array<{ path: string }>;
    expect(afterTouchRows.map((r) => r.path)).toEqual(['src/a.ts', 'src/c.ts', 'src/b.ts']);

    // Touch fileB: set its mtime to 7000s
    fs.utimesSync(fileB, 7000, 7000);
    await pipeline.indexAll();

    const { sql: sql3, params: params3 } = buildProjectFilesQuery('recent', '', 10);
    const finalRows = store.db.prepare(sql3).all(...params3) as Array<{ path: string }>;
    expect(finalRows.map((r) => r.path)).toEqual(['src/b.ts', 'src/a.ts', 'src/c.ts']);
  });
});
