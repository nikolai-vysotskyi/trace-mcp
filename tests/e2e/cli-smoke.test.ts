import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { getTableNames, initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/no-framework');

let tmpDir: string;

function makeDbDir(): string {
  tmpDir = createTmpDir('trace-mcp-cli-');
  return tmpDir;
}

describe('CLI smoke tests', () => {
  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('index command creates DB with expected tables', () => {
    const dir = makeDbDir();
    const dbPath = path.join(dir, 'index.db');

    const db = initializeDatabase(dbPath);
    const tables = getTableNames(db);

    expect(tables).toContain('files');
    expect(tables).toContain('symbols');
    expect(tables).toContain('edges');
    expect(tables).toContain('nodes');
    expect(tables).toContain('edge_types');
    expect(tables).toContain('node_types');
    expect(tables).toContain('routes');
    expect(tables).toContain('components');
    expect(tables).toContain('migrations');
    expect(tables).toContain('schema_meta');

    db.close();
  });

  it('indexing fixture creates files and symbols in DB', async () => {
    const dir = makeDbDir();
    const dbPath = path.join(dir, 'index.db');
    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

    const config: TraceMcpConfig = {
      root: FIXTURE_DIR,
      include: ['app/**/*.php', 'src/**/*.ts'],
      exclude: ['vendor/**', 'node_modules/**'],
      db: { path: dbPath },
      plugins: [],
    };

    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    const result = await pipeline.indexAll();

    expect(result.indexed).toBeGreaterThan(0);
    expect(result.errors).toBe(0);

    const stats = store.getStats();
    expect(stats.totalFiles).toBeGreaterThan(0);
    expect(stats.totalSymbols).toBeGreaterThan(0);

    db.close();
  });

  // Windows runners on cold SSDs can spend >10s on the initial WAL handshake
  // plus 28 schema migrations on a brand-new file-backed DB. The test itself
  // is synchronous and trivial — bump the timeout so the slow setup doesn't
  // get blamed on the assertion.
  it('DB schema includes workspace and is_cross_ws columns', () => {
    const dir = makeDbDir();
    const dbPath = path.join(dir, 'index.db');
    const db = initializeDatabase(dbPath);

    // Check files has workspace column
    const fileColumns = db.prepare("PRAGMA table_info('files')").all() as { name: string }[];
    expect(fileColumns.map((c) => c.name)).toContain('workspace');

    // Check edges has is_cross_ws column
    const edgeColumns = db.prepare("PRAGMA table_info('edges')").all() as { name: string }[];
    expect(edgeColumns.map((c) => c.name)).toContain('is_cross_ws');

    db.close();
  }, 30000);
});
