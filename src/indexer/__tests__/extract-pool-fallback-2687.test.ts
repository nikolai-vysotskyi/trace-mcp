import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { initContentHasher } from '../../util/hash.js';
import { extractAndPersist } from '../extract-and-persist.js';
import * as poolMod from '../extract-pool.js';
import { FileExtractor } from '../file-extractor.js';
import { buildProjectContext } from '../project-context.js';

describe('extractAndPersist — pool failure fallback (TRA-2687)', () => {
  let workDir: string;
  let db: Database.Database;
  let store: Store;
  let registry: PluginRegistry;

  beforeEach(async () => {
    await initContentHasher();
    workDir = mkdtempSync(join(tmpdir(), 'extract-pool-fallback-'));
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(
      join(workDir, 'src', 'a.ts'),
      'export function alpha(): string { return "alpha"; }\n',
      'utf-8',
    );
    writeFileSync(
      join(workDir, 'src', 'b.ts'),
      'export function beta(): number { return 42; }\n',
      'utf-8',
    );

    db = initializeDatabase(':memory:');
    store = new Store(db);

    registry = await PluginRegistry.createWithDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      db.close();
    } catch {
      /* ignore */
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('falls back to in-process extraction when worker pool fails mid-indexing', async () => {
    // Mock a failing extract pool that simulates deleted install tree / missing worker entry
    const failingPool = {
      size: 2,
      extract: vi
        .fn()
        .mockRejectedValue(new Error('Extract worker pool unavailable in this runtime')),
      dropProject: vi.fn(),
      terminate: vi.fn().mockResolvedValue(undefined),
    };

    const relPaths = ['src/a.ts', 'src/b.ts'];
    const result: import('../extract-and-persist.js').ExtractAndPersistResult = {
      indexed: 0,
      skipped: 0,
      errors: 0,
    };

    const outcome = await extractAndPersist(
      {
        rootPath: workDir,
        registry,
        store,
        gitignore: undefined,
        workspaces: [],
        fileContentCache: new Map(),
        buildProjectContext: () => buildProjectContext(workDir),
        getPipelineState: () => ({
          store,
          registry,
          config: {} as any,
          rootPath: workDir,
          workspaces: [],
          isIncremental: false,
          changedFileIds: new Set<number>(),
          pendingImports: new Map(),
          fileContentCache: new Map(),
          gitignore: undefined,
        }),
        maybeGetExtractPool: () => failingPool as unknown as poolMod.ExtractPool,
        ftsRebuildThreshold: 1000,
        sortByExtension: (files) => files,
      },
      relPaths,
      true,
      result,
    );

    // The indexer must succeed despite pool errors
    expect(result.indexed).toBe(2);
    expect(result.errors).toBe(0);

    // Verify symbols were actually parsed and persisted in the database via in-process extractor
    const symbols = db.prepare('SELECT name, kind FROM symbols').all() as Array<{
      name: string;
      kind: string;
    }>;
    const names = symbols.map((s) => s.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });
});
