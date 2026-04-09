/**
 * Tests for src/bundles.ts
 *
 * Strategy: vi.mock redirects TRACE_MCP_HOME to a tmp dir so no real
 * ~/.trace-mcp writes happen.  exportBundle needs a real SQLite source DB;
 * we build a minimal one inline using better-sqlite3.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// ── tmp dir wiring ────────────────────────────────────────────────────────────

let tmpHome: string;

vi.mock('../../src/global.js', () => ({
  get TRACE_MCP_HOME() { return tmpHome; },
}));

// Dynamic imports after mock is in place
let ensureBundlesDir: typeof import('../../src/bundles.js').ensureBundlesDir;
let exportBundle:     typeof import('../../src/bundles.js').exportBundle;
let listBundles:      typeof import('../../src/bundles.js').listBundles;
let removeBundle:     typeof import('../../src/bundles.js').removeBundle;
let loadAllBundles:   typeof import('../../src/bundles.js').loadAllBundles;
let searchBundles:    typeof import('../../src/bundles.js').searchBundles;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bundles-test-'));
  vi.resetModules();
  const m = await import('../../src/bundles.js');
  ensureBundlesDir = m.ensureBundlesDir;
  exportBundle     = m.exportBundle;
  listBundles      = m.listBundles;
  removeBundle     = m.removeBundle;
  loadAllBundles   = m.loadAllBundles;
  searchBundles    = m.searchBundles;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

let _dbCounter = 0;

/** Build a minimal SQLite DB that bundles.ts can read as a source. */
function makeSourceDb(symbols: Array<{ name: string; kind: string; fqn?: string }>): string {
  const dbPath = path.join(tmpHome, `source-${_dbCounter++}.db`);
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, language TEXT, framework_role TEXT
    );
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY, file_id INTEGER, symbol_id TEXT NOT NULL UNIQUE,
      name TEXT, kind TEXT, fqn TEXT, signature TEXT,
      line_start INTEGER, line_end INTEGER, byte_start INTEGER, byte_end INTEGER,
      is_exported INTEGER DEFAULT 0, cyclomatic INTEGER, max_nesting INTEGER,
      param_count INTEGER, metadata TEXT
    );
    CREATE TABLE node_types (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE edge_types (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      category TEXT, directed INTEGER DEFAULT 1, description TEXT
    );
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY, node_type TEXT NOT NULL, ref_id INTEGER NOT NULL,
      UNIQUE(node_type, ref_id)
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      source_node_id INTEGER, target_node_id INTEGER, edge_type_id INTEGER,
      resolved INTEGER DEFAULT 0, metadata TEXT,
      UNIQUE(source_node_id, target_node_id, edge_type_id)
    );
  `);

  db.prepare('INSERT INTO files (id, path, language) VALUES (1, ?, ?)').run('src/index.ts', 'typescript');

  const insertSym = db.prepare(`
    INSERT INTO symbols (id, file_id, symbol_id, name, kind, fqn, byte_start, byte_end, is_exported)
    VALUES (?, 1, ?, ?, ?, ?, 0, 10, 1)
  `);
  symbols.forEach((s, i) => {
    insertSym.run(i + 1, `src/index.ts::${s.name}#${s.kind}`, s.name, s.kind, s.fqn ?? s.name);
  });

  db.close();
  return dbPath;
}

// ── ensureBundlesDir ──────────────────────────────────────────────────────────

describe('ensureBundlesDir', () => {
  it('creates the bundles directory when it does not exist', () => {
    const bundlesDir = path.join(tmpHome, 'bundles');
    expect(fs.existsSync(bundlesDir)).toBe(false);
    ensureBundlesDir();
    expect(fs.existsSync(bundlesDir)).toBe(true);
  });

  it('is idempotent — calling twice does not throw', () => {
    expect(() => { ensureBundlesDir(); ensureBundlesDir(); }).not.toThrow();
  });
});

// ── exportBundle ──────────────────────────────────────────────────────────────

describe('exportBundle', () => {
  it('creates a bundle DB file and returns a manifest entry', () => {
    const src = makeSourceDb([
      { name: 'createUser', kind: 'function' },
      { name: 'UserService', kind: 'class' },
    ]);

    const entry = exportBundle(src, 'my-lib', '1.0.0');

    expect(entry.package).toBe('my-lib');
    expect(entry.version).toBe('1.0.0');
    expect(entry.symbols).toBe(2);
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.size_bytes).toBeGreaterThan(0);

    const bundlePath = path.join(tmpHome, 'bundles', entry.file);
    expect(fs.existsSync(bundlePath)).toBe(true);
  });

  it('registers the entry in the manifest', () => {
    const src = makeSourceDb([{ name: 'foo', kind: 'function' }]);
    exportBundle(src, 'pkg-a', '2.0.0');

    const listed = listBundles();
    expect(listed).toHaveLength(1);
    expect(listed[0].package).toBe('pkg-a');
    expect(listed[0].version).toBe('2.0.0');
  });

  it('overwrites an existing bundle of the same package@version', () => {
    const src1 = makeSourceDb([{ name: 'a', kind: 'function' }]);
    const src2 = makeSourceDb([{ name: 'a', kind: 'function' }, { name: 'b', kind: 'function' }]);

    exportBundle(src1, 'pkg', '1.0.0');
    exportBundle(src2, 'pkg', '1.0.0');

    const listed = listBundles();
    expect(listed).toHaveLength(1);
    expect(listed[0].symbols).toBe(2);
  });

  it('bundle DB contains the correct symbols', () => {
    const src = makeSourceDb([
      { name: 'handler', kind: 'function', fqn: 'routes.handler' },
      { name: 'Config',  kind: 'class' },
    ]);
    const entry = exportBundle(src, 'pkg', '1.0.0');
    const bundlePath = path.join(tmpHome, 'bundles', entry.file);

    const db = new Database(bundlePath, { readonly: true });
    const rows = db.prepare('SELECT name, kind FROM symbols ORDER BY name').all() as Array<{ name: string; kind: string }>;
    db.close();

    expect(rows.map(r => r.name)).toEqual(['Config', 'handler']);
    expect(rows.find(r => r.name === 'handler')?.kind).toBe('function');
  });
});

// ── listBundles ───────────────────────────────────────────────────────────────

describe('listBundles', () => {
  it('returns empty array when no bundles exist', () => {
    expect(listBundles()).toEqual([]);
  });

  it('returns all registered bundles', () => {
    const src = makeSourceDb([{ name: 'x', kind: 'function' }]);
    exportBundle(src, 'lib-a', '1.0.0');
    exportBundle(src, 'lib-b', '2.0.0');

    const listed = listBundles();
    expect(listed).toHaveLength(2);
    expect(listed.map(b => b.package).sort()).toEqual(['lib-a', 'lib-b']);
  });
});

// ── removeBundle ─────────────────────────────────────────────────────────────

describe('removeBundle', () => {
  it('removes a specific version and its file', () => {
    const src = makeSourceDb([{ name: 'x', kind: 'function' }]);
    const entry = exportBundle(src, 'remove-me', '1.0.0');
    const bundlePath = path.join(tmpHome, 'bundles', entry.file);

    const removed = removeBundle('remove-me', '1.0.0');

    expect(removed).toBe(1);
    expect(listBundles()).toHaveLength(0);
    expect(fs.existsSync(bundlePath)).toBe(false);
  });

  it('removes all versions when no version specified', () => {
    const src = makeSourceDb([{ name: 'x', kind: 'function' }]);
    exportBundle(src, 'multi', '1.0.0');
    exportBundle(src, 'multi', '2.0.0');

    const removed = removeBundle('multi');
    expect(removed).toBe(2);
    expect(listBundles()).toHaveLength(0);
  });

  it('returns 0 when package does not exist', () => {
    expect(removeBundle('nonexistent')).toBe(0);
  });

  it('does not remove other packages', () => {
    const src = makeSourceDb([{ name: 'x', kind: 'function' }]);
    exportBundle(src, 'keep', '1.0.0');
    exportBundle(src, 'remove', '1.0.0');

    removeBundle('remove');
    const remaining = listBundles();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].package).toBe('keep');
  });
});

// ── loadAllBundles ────────────────────────────────────────────────────────────

describe('loadAllBundles', () => {
  it('returns empty when no bundles exist', () => {
    expect(loadAllBundles()).toHaveLength(0);
  });

  it('returns loaded bundle handles for each registered bundle', () => {
    const src = makeSourceDb([{ name: 'y', kind: 'function' }]);
    exportBundle(src, 'loaded-pkg', '1.0.0');

    const bundles = loadAllBundles();
    expect(bundles).toHaveLength(1);
    expect(bundles[0].package).toBe('loaded-pkg');
    expect(bundles[0].db).toBeDefined();

    // Clean up open DB handles
    for (const b of bundles) b.db.close();
  });
});

// ── searchBundles ─────────────────────────────────────────────────────────────

describe('searchBundles', () => {
  it('finds symbols by name substring', () => {
    const src = makeSourceDb([
      { name: 'getUserById', kind: 'function' },
      { name: 'createUser',  kind: 'function' },
      { name: 'ProductService', kind: 'class' },
    ]);
    exportBundle(src, 'api', '1.0.0');
    const bundles = loadAllBundles();

    const results = searchBundles(bundles, 'User');
    expect(results.length).toBe(2);
    expect(results.every(r => r.name.includes('User') || r.fqn?.includes('User'))).toBe(true);
    expect(results[0].bundle_package).toBe('api');

    for (const b of bundles) b.db.close();
  });

  it('filters by kind', () => {
    const src = makeSourceDb([
      { name: 'UserService', kind: 'class' },
      { name: 'getUser',     kind: 'function' },
    ]);
    exportBundle(src, 'svc', '1.0.0');
    const bundles = loadAllBundles();

    const classes = searchBundles(bundles, 'User', { kind: 'class' });
    expect(classes).toHaveLength(1);
    expect(classes[0].kind).toBe('class');

    for (const b of bundles) b.db.close();
  });

  it('respects limit', () => {
    const src = makeSourceDb(
      Array.from({ length: 10 }, (_, i) => ({ name: `func${i}`, kind: 'function' })),
    );
    exportBundle(src, 'big', '1.0.0');
    const bundles = loadAllBundles();

    const results = searchBundles(bundles, 'func', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);

    for (const b of bundles) b.db.close();
  });

  it('returns empty for no match', () => {
    const src = makeSourceDb([{ name: 'foo', kind: 'function' }]);
    exportBundle(src, 'pkg', '1.0.0');
    const bundles = loadAllBundles();

    expect(searchBundles(bundles, 'xyzzy_no_match')).toHaveLength(0);

    for (const b of bundles) b.db.close();
  });

  it('searches across multiple bundles', () => {
    const src1 = makeSourceDb([{ name: 'alphaFn', kind: 'function' }]);
    const src2 = makeSourceDb([{ name: 'alphaClass', kind: 'class' }]);
    exportBundle(src1, 'bundle-a', '1.0.0');
    exportBundle(src2, 'bundle-b', '1.0.0');
    const bundles = loadAllBundles();

    const results = searchBundles(bundles, 'alpha');
    expect(results.length).toBe(2);
    const packages = results.map(r => r.bundle_package).sort();
    expect(packages).toEqual(['bundle-a', 'bundle-b']);

    for (const b of bundles) b.db.close();
  });
});
