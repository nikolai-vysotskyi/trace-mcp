/**
 * TRA-1017 follow-up: ESM import resolution under a symlinked project root.
 *
 * oxc-resolver realpaths symlinks in its output (`/var` → `/private/var`,
 * `/tmp` → `/private/tmp` on macOS) while the pipeline's rootPath may keep
 * the unresolved spelling (`os.tmpdir()` differs per machine/env). Comparing
 * the raw pair with `path.relative` then yields `..`-paths for files that
 * ARE in the project, and every relative import was silently skipped with
 * zero errors — an entire CI platform lost all ESM edges this way.
 *
 * The resolver must accept whichever spelling keeps the target in-root.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { IndexingPipeline } from '../pipeline.js';

let workDir: string;
let linkDir: string;
let db: Database.Database | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'esm-symlink-real-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'a.ts'), 'export function foo() { return 1; }\n');
  writeFileSync(
    join(workDir, 'src', 'b.ts'),
    "import { foo } from './a';\nexport function bar() { return foo(); }\n",
  );
  // Same project visible through an unresolved symlink prefix — the shape
  // os.tmpdir() has on machines where /var or /tmp are symlinks.
  linkDir = `${workDir}-link`;
  symlinkSync(workDir, linkDir, 'dir');
});

afterEach(async () => {
  try {
    db?.close();
  } catch {
    /* best-effort */
  }
  db = undefined;
  rmSync(linkDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

function realImportCount(database: Database.Database): number {
  // Only genuinely resolved ESM imports — file-projection guesses carry
  // metadata.projected and must not satisfy this test (they would mask the
  // resolver silently skipping every relative import).
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM edges
         WHERE edge_type_id = (SELECT id FROM edge_types WHERE name = 'imports')
         AND (metadata IS NULL OR json_extract(metadata, '$.projected') IS NULL)`,
      )
      .get() as { n: number }
  ).n;
}

describe('ESM import edges through a symlinked root (TRA-1017)', () => {
  it('resolves relative imports when rootPath keeps the unresolved spelling', async () => {
    db = initializeDatabase(join(workDir, 'index.db'));
    const store = new Store(db);
    // NOTE: the DB lives in the real dir; only the indexed root goes
    // through the symlink — mirroring a daemon rooted at an unresolved
    // tmpdir while its index DB sits elsewhere.
    const pipeline = new IndexingPipeline(
      store,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      join(linkDir, 'src'),
    );
    try {
      const result = await pipeline.indexAll(true);
      expect(result.errors).toBe(0);
      expect(realImportCount(db)).toBe(1);
    } finally {
      await pipeline.dispose();
    }
  });

  it('resolves relative imports when rootPath is already resolved', async () => {
    db = initializeDatabase(join(workDir, 'index.db'));
    const store = new Store(db);
    const pipeline = new IndexingPipeline(
      store,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      join(workDir, 'src'),
    );
    try {
      const result = await pipeline.indexAll(true);
      expect(result.errors).toBe(0);
      expect(realImportCount(db)).toBe(1);
    } finally {
      await pipeline.dispose();
    }
  });
});
