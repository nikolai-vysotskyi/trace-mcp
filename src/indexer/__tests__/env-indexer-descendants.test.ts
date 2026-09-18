/**
 * TRA-1666: EnvIndexer bypassed the descendant-exclusion and gitignore gates
 * the rest of the pipeline applies — `.env` files of nested registered
 * projects landed in the parent DB as duplicates.
 *
 * Covers: descendant-owned `.env` skipped, git-ignored `.env` skipped,
 * root-owned `.env` still indexed.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../registry.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    // Umbrella root with one registered descendant owning `child/`.
    descendantExcludeGlobs: vi.fn(() => ['child/**']),
  };
});

import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { EnvIndexer } from '../env-indexer.js';

let workDir: string;
let db: Database.Database;
let store: Store;
let repoDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'env-indexer-descendants-'));
  repoDir = join(workDir, 'repo');
  mkdirSync(join(repoDir, 'child'), { recursive: true });
  mkdirSync(join(repoDir, 'secret'), { recursive: true });
  writeFileSync(join(repoDir, '.env'), 'ROOT_KEY=1\n');
  writeFileSync(join(repoDir, 'child', '.env'), 'CHILD_KEY=1\n');
  writeFileSync(join(repoDir, 'secret', '.env'), 'SECRET_KEY=1\n');
  writeFileSync(join(repoDir, '.gitignore'), 'secret/\n');
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

describe('EnvIndexer.indexEnvFiles — descendant + gitignore gates (TRA-1666)', () => {
  it('indexes the root .env but skips descendant-owned and git-ignored ones', async () => {
    const config = TraceMcpConfigSchema.parse({});
    const indexer = new EnvIndexer(store, config, repoDir);

    await indexer.indexEnvFiles(true);

    const rootFile = store.getFile('.env');
    expect(rootFile).toBeDefined();
    expect(store.getEnvVarsByFile(rootFile?.id ?? -1).map((v) => v.key)).toContain('ROOT_KEY');

    expect(store.getFile('child/.env')).toBeUndefined();
    expect(store.getFile('secret/.env')).toBeUndefined();
  });
});
