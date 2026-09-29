/**
 * TRA-2067 (GH#1450) — `.env` files already indexed were never dropped after
 * adding them to `ignore.patterns`: `selectOutOfScopeFiles()` exempts
 * `language 'env'`, so `reconcileScope()` never deleted them and key names +
 * comments from real secret files kept being served via `get_env_vars`
 * against an explicit user ignore.
 *
 * Covers: ignore.patterns prune, .traceignore prune, .gitignore prune,
 * deleted-from-disk prune, and the negative (still-owned .env survives).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { TraceMcpConfigSchema } from '../../config.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { TypeScriptLanguagePlugin } from '../plugins/language/typescript/index.js';
import { IndexingPipeline } from '../pipeline.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'env-ignore-prune-2067-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'a.ts'), 'export function realOne() { return 1; }\n');
  writeFileSync(
    join(workDir, '.env'),
    '# production database url\nSECRET_KEY=abc123\nPUBLIC_FLAG=true\n',
  );
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makePipeline(store: Store, ignorePatterns: string[] = []) {
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const config = TraceMcpConfigSchema.parse({
    root: workDir,
    include: ['**/*.ts'],
    exclude: [],
    ignore: { patterns: ignorePatterns },
  });
  return new IndexingPipeline(store, registry, config, workDir);
}

function envKeys(store: Store): string[] {
  const file = store.getFile('.env');
  if (!file) return [];
  return store.getEnvVarsByFile(file.id).map((v) => v.key);
}

describe('TRA-2067 — ignored / deleted .env rows are dropped on reindex', () => {
  it('drops env rows after the path is added to ignore.patterns', async () => {
    const store = new Store(initializeDatabase(':memory:'));

    await makePipeline(store).indexAll();
    expect(store.getFile('.env')).toBeDefined();
    expect(envKeys(store)).toContain('SECRET_KEY');

    // User ignores the file, then reindexes — rows must be gone.
    await makePipeline(store, ['.env']).indexAll();
    expect(store.getFile('.env')).toBeUndefined();
    expect(envKeys(store)).toEqual([]);
    // Code rows are untouched by the env prune.
    expect(store.getFile('src/a.ts')).toBeDefined();
  });

  it('keeps env rows that are still owned', async () => {
    const store = new Store(initializeDatabase(':memory:'));

    await makePipeline(store).indexAll();
    expect(envKeys(store)).toContain('SECRET_KEY');

    await makePipeline(store).indexAll();
    expect(store.getFile('.env')).toBeDefined();
    expect(envKeys(store)).toContain('SECRET_KEY');
  });

  it('drops env rows for files deleted from disk', async () => {
    const store = new Store(initializeDatabase(':memory:'));

    await makePipeline(store).indexAll();
    expect(store.getFile('.env')).toBeDefined();

    rmSync(join(workDir, '.env'), { force: true });
    await makePipeline(store).indexAll();
    expect(store.getFile('.env')).toBeUndefined();
  });

  it('drops env rows hidden by .traceignore', async () => {
    const store = new Store(initializeDatabase(':memory:'));

    await makePipeline(store).indexAll();
    expect(store.getFile('.env')).toBeDefined();

    writeFileSync(join(workDir, '.traceignore'), '.env\n');
    await makePipeline(store).indexAll();
    expect(store.getFile('.env')).toBeUndefined();
  });

  it('drops env rows hidden by .gitignore', async () => {
    const store = new Store(initializeDatabase(':memory:'));

    await makePipeline(store).indexAll();
    expect(store.getFile('.env')).toBeDefined();

    writeFileSync(join(workDir, '.gitignore'), '.env\n');
    await makePipeline(store).indexAll();
    expect(store.getFile('.env')).toBeUndefined();
  });
});
