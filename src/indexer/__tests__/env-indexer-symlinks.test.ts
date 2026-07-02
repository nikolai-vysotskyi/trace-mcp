/**
 * Regression coverage for #218 — EnvIndexer's fast-glob call was the ONLY one
 * in src/ with neither `suppressErrors` nor a surrounding try/catch, so an
 * Ansible Molecule-style directory symlink cycle (`roles/<role>/molecule/
 * <scenario>/roles/<role> -> ../../../`) crashed the whole indexing run with
 * an uncaught ENAMETOOLONG rejection. A .env discovery failure must never
 * abort the whole index.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { EnvIndexer } from '../env-indexer.js';

let workDir: string;
let db: Database.Database;
let store: Store;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'env-indexer-symlinks-'));
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

describe('EnvIndexer.indexEnvFiles — symlink containment (#218)', () => {
  it('resolves without throwing and still indexes a real .env on a molecule-style cycle', async () => {
    const repoDir = join(workDir, 'repo');
    const roleDir = join(repoDir, 'roles', 'docker');
    const scenarioRolesDir = join(roleDir, 'molecule', 'default', 'roles');
    mkdirSync(scenarioRolesDir, { recursive: true });
    writeFileSync(join(repoDir, '.env'), 'DATABASE_URL=postgres://localhost/db\n');

    let symlinkOk = true;
    try {
      symlinkSync('../../../', join(scenarioRolesDir, 'docker'), 'dir');
    } catch {
      symlinkOk = false;
    }
    if (!symlinkOk) {
      return;
    }

    const config = TraceMcpConfigSchema.parse({});
    const indexer = new EnvIndexer(store, config, repoDir);

    await expect(indexer.indexEnvFiles(false)).resolves.toBeUndefined();

    const envFile = store.getFile('.env');
    expect(envFile).toBeDefined();
    expect(store.getEnvVarsByFile(envFile?.id ?? -1).map((v) => v.key)).toContain('DATABASE_URL');
  });
});
