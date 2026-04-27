/**
 * Pre-Indexed Bundles — snapshot & restore of symbol/edge data for popular libraries.
 *
 * A bundle is a stripped-down SQLite DB containing:
 * - files (path, language only)
 * - symbols (all metadata)
 * - nodes + edges (dependency graph)
 * - edge_types (schema)
 *
 * Bundles do NOT contain file content, FTS5 data, or git metadata.
 * They are designed to be small, portable, and shareable.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { logger } from './logger.js';
import { TRACE_MCP_HOME } from './global.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const BUNDLES_DIR = path.join(TRACE_MCP_HOME, 'bundles');

export function ensureBundlesDir(): void {
  fs.mkdirSync(BUNDLES_DIR, { recursive: true });
}

function getBundlePath(packageName: string, version: string): string {
  const safeName = packageName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(BUNDLES_DIR, `${safeName}-${version}.bundle.db`);
}

// ---------------------------------------------------------------------------
// Bundle manifest
// ---------------------------------------------------------------------------

interface BundleManifestEntry {
  package: string;
  version: string;
  file: string;
  symbols: number;
  edges: number;
  size_bytes: number;
  created_at: string;
  sha256: string;
}

interface BundleManifest {
  bundles: BundleManifestEntry[];
}

function getManifestPath(): string {
  return path.join(BUNDLES_DIR, 'manifest.json');
}

function loadManifest(): BundleManifest {
  const p = getManifestPath();
  if (!fs.existsSync(p)) return { bundles: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { bundles: [] };
  }
}

function saveManifest(manifest: BundleManifest): void {
  ensureBundlesDir();
  fs.writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Export a bundle from an indexed database
// ---------------------------------------------------------------------------

export function exportBundle(
  sourceDbPath: string,
  packageName: string,
  version: string,
): BundleManifestEntry {
  ensureBundlesDir();
  const bundlePath = getBundlePath(packageName, version);

  // Open source DB
  const src = new Database(sourceDbPath, { readonly: true });

  // Create bundle DB
  if (fs.existsSync(bundlePath)) fs.unlinkSync(bundlePath);
  const dst = new Database(bundlePath);

  dst.pragma('journal_mode = WAL');
  dst.pragma('synchronous = OFF');

  // Create minimal schema
  dst.exec(`
    CREATE TABLE IF NOT EXISTS bundle_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id              INTEGER PRIMARY KEY,
      path            TEXT NOT NULL UNIQUE,
      language        TEXT,
      framework_role  TEXT
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id          INTEGER PRIMARY KEY,
      file_id     INTEGER NOT NULL REFERENCES files(id),
      symbol_id   TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      fqn         TEXT,
      signature   TEXT,
      line_start  INTEGER,
      line_end    INTEGER,
      byte_start  INTEGER,
      byte_end    INTEGER,
      is_exported INTEGER NOT NULL DEFAULT 0,
      cyclomatic  INTEGER,
      max_nesting INTEGER,
      param_count INTEGER,
      metadata    TEXT
    );

    CREATE TABLE IF NOT EXISTS node_types (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS edge_types (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      category    TEXT,
      directed    INTEGER DEFAULT 1,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id        INTEGER PRIMARY KEY,
      node_type TEXT NOT NULL,
      ref_id    INTEGER NOT NULL,
      UNIQUE(node_type, ref_id)
    );

    CREATE TABLE IF NOT EXISTS edges (
      id              INTEGER PRIMARY KEY,
      source_node_id  INTEGER NOT NULL REFERENCES nodes(id),
      target_node_id  INTEGER NOT NULL REFERENCES nodes(id),
      edge_type_id    INTEGER NOT NULL REFERENCES edge_types(id),
      resolved        INTEGER DEFAULT 0,
      metadata        TEXT,
      resolution_tier TEXT NOT NULL DEFAULT 'ast_resolved',
      UNIQUE(source_node_id, target_node_id, edge_type_id)
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);
  `);

  // Copy data
  dst.exec('BEGIN');

  // Files (minimal fields only)
  const srcFiles = src
    .prepare('SELECT id, path, language, framework_role FROM files')
    .all() as Array<{
    id: number;
    path: string;
    language: string | null;
    framework_role: string | null;
  }>;
  const insertFile = dst.prepare(
    'INSERT INTO files (id, path, language, framework_role) VALUES (?, ?, ?, ?)',
  );
  for (const f of srcFiles) {
    insertFile.run(f.id, f.path, f.language, f.framework_role);
  }

  // Symbols
  const srcSymbols = src
    .prepare(`
    SELECT id, file_id, symbol_id, name, kind, fqn, signature,
           line_start, line_end, byte_start, byte_end, is_exported,
           cyclomatic, max_nesting, param_count, metadata
    FROM symbols
  `)
    .all() as Array<Record<string, unknown>>;
  const insertSymbol = dst.prepare(`
    INSERT INTO symbols (id, file_id, symbol_id, name, kind, fqn, signature,
      line_start, line_end, byte_start, byte_end, is_exported,
      cyclomatic, max_nesting, param_count, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of srcSymbols) {
    insertSymbol.run(
      s.id,
      s.file_id,
      s.symbol_id,
      s.name,
      s.kind,
      s.fqn,
      s.signature,
      s.line_start,
      s.line_end,
      s.byte_start,
      s.byte_end,
      s.is_exported,
      s.cyclomatic,
      s.max_nesting,
      s.param_count,
      s.metadata,
    );
  }

  // Node types
  const srcNodeTypes = src.prepare('SELECT id, name FROM node_types').all() as Array<{
    id: number;
    name: string;
  }>;
  const insertNodeType = dst.prepare('INSERT INTO node_types (id, name) VALUES (?, ?)');
  for (const nt of srcNodeTypes) {
    insertNodeType.run(nt.id, nt.name);
  }

  // Edge types
  const srcEdgeTypes = src
    .prepare('SELECT id, name, category, directed, description FROM edge_types')
    .all() as Array<Record<string, unknown>>;
  const insertEdgeType = dst.prepare(
    'INSERT INTO edge_types (id, name, category, directed, description) VALUES (?, ?, ?, ?, ?)',
  );
  for (const et of srcEdgeTypes) {
    insertEdgeType.run(et.id, et.name, et.category, et.directed, et.description);
  }

  // Nodes
  const srcNodes = src.prepare('SELECT id, node_type, ref_id FROM nodes').all() as Array<{
    id: number;
    node_type: string;
    ref_id: number;
  }>;
  const insertNode = dst.prepare('INSERT INTO nodes (id, node_type, ref_id) VALUES (?, ?, ?)');
  for (const n of srcNodes) {
    insertNode.run(n.id, n.node_type, n.ref_id);
  }

  // Edges — handle source DBs that predate the resolution_tier column
  const hasResolutionTier = src
    .prepare(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('edges') WHERE name = 'resolution_tier'",
    )
    .get() as { cnt: number };
  const edgeSelect =
    hasResolutionTier.cnt > 0
      ? 'SELECT id, source_node_id, target_node_id, edge_type_id, resolved, metadata, resolution_tier FROM edges'
      : 'SELECT id, source_node_id, target_node_id, edge_type_id, resolved, metadata FROM edges';
  const srcEdges = src.prepare(edgeSelect).all() as Array<Record<string, unknown>>;
  const insertEdge = dst.prepare(
    'INSERT INTO edges (id, source_node_id, target_node_id, edge_type_id, resolved, metadata, resolution_tier) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const e of srcEdges) {
    insertEdge.run(
      e.id,
      e.source_node_id,
      e.target_node_id,
      e.edge_type_id,
      e.resolved,
      e.metadata,
      e.resolution_tier ?? 'ast_resolved',
    );
  }

  // Meta
  dst.prepare('INSERT INTO bundle_meta (key, value) VALUES (?, ?)').run('package', packageName);
  dst.prepare('INSERT INTO bundle_meta (key, value) VALUES (?, ?)').run('version', version);
  dst
    .prepare('INSERT INTO bundle_meta (key, value) VALUES (?, ?)')
    .run('created_at', new Date().toISOString());
  dst
    .prepare('INSERT INTO bundle_meta (key, value) VALUES (?, ?)')
    .run('symbols_count', String(srcSymbols.length));
  dst
    .prepare('INSERT INTO bundle_meta (key, value) VALUES (?, ?)')
    .run('edges_count', String(srcEdges.length));

  dst.exec('COMMIT');

  // Compact
  dst.pragma('journal_mode = DELETE');
  dst.exec('VACUUM');
  dst.close();
  src.close();

  // Compute hash
  const bundleContent = fs.readFileSync(bundlePath);
  const sha256 = crypto.createHash('sha256').update(bundleContent).digest('hex');
  const sizeBytes = bundleContent.length;

  // Update manifest
  const entry: BundleManifestEntry = {
    package: packageName,
    version,
    file: path.basename(bundlePath),
    symbols: srcSymbols.length,
    edges: srcEdges.length,
    size_bytes: sizeBytes,
    created_at: new Date().toISOString(),
    sha256,
  };

  const manifest = loadManifest();
  manifest.bundles = manifest.bundles.filter(
    (b) => !(b.package === packageName && b.version === version),
  );
  manifest.bundles.push(entry);
  saveManifest(manifest);

  logger.info(
    {
      package: packageName,
      version,
      symbols: srcSymbols.length,
      edges: srcEdges.length,
      sizeKB: Math.round(sizeBytes / 1024),
    },
    'Bundle exported',
  );

  return entry;
}

// ---------------------------------------------------------------------------
// List & remove bundles
// ---------------------------------------------------------------------------

export function listBundles(): BundleManifestEntry[] {
  return loadManifest().bundles;
}

export function removeBundle(packageName: string, version?: string): number {
  const manifest = loadManifest();
  const toRemove = manifest.bundles.filter(
    (b) => b.package === packageName && (!version || b.version === version),
  );
  for (const entry of toRemove) {
    const fp = path.join(BUNDLES_DIR, entry.file);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  manifest.bundles = manifest.bundles.filter(
    (b) => !(b.package === packageName && (!version || b.version === version)),
  );
  saveManifest(manifest);
  return toRemove.length;
}

// ---------------------------------------------------------------------------
// Load bundle for cross-index queries
// ---------------------------------------------------------------------------

interface LoadedBundle {
  package: string;
  version: string;
  db: Database.Database;
}

function loadBundle(packageName: string, version: string): LoadedBundle | null {
  const bundlePath = getBundlePath(packageName, version);
  if (!fs.existsSync(bundlePath)) return null;
  try {
    const db = new Database(bundlePath, { readonly: true });
    return { package: packageName, version, db };
  } catch (e) {
    logger.warn({ package: packageName, version, error: e }, 'Failed to load bundle');
    return null;
  }
}

export function loadAllBundles(): LoadedBundle[] {
  const manifest = loadManifest();
  const bundles: LoadedBundle[] = [];
  for (const entry of manifest.bundles) {
    const loaded = loadBundle(entry.package, entry.version);
    if (loaded) bundles.push(loaded);
  }
  return bundles;
}

// ---------------------------------------------------------------------------
// Cross-index symbol search in bundles
// ---------------------------------------------------------------------------

interface BundleSymbol {
  symbol_id: string;
  name: string;
  kind: string;
  fqn: string | null;
  signature: string | null;
  file: string;
  line: number | null;
  bundle_package: string;
  bundle_version: string;
}

export function searchBundles(
  bundles: LoadedBundle[],
  query: string,
  opts: { kind?: string; limit?: number } = {},
): BundleSymbol[] {
  const results: BundleSymbol[] = [];
  const limit = opts.limit ?? 20;
  const pattern = `%${query}%`;

  for (const bundle of bundles) {
    try {
      let sql = `
        SELECT s.symbol_id, s.name, s.kind, s.fqn, s.signature, f.path as file, s.line_start as line
        FROM symbols s JOIN files f ON s.file_id = f.id
        WHERE (s.name LIKE ? OR s.fqn LIKE ?)
      `;
      const params: unknown[] = [pattern, pattern];

      if (opts.kind) {
        sql += ' AND s.kind = ?';
        params.push(opts.kind);
      }

      sql += ' LIMIT ?';
      params.push(limit - results.length);

      const rows = bundle.db.prepare(sql).all(...params) as Array<{
        symbol_id: string;
        name: string;
        kind: string;
        fqn: string | null;
        signature: string | null;
        file: string;
        line: number | null;
      }>;

      for (const row of rows) {
        results.push({
          ...row,
          bundle_package: bundle.package,
          bundle_version: bundle.version,
        });
      }

      if (results.length >= limit) break;
    } catch (e) {
      logger.warn({ bundle: bundle.package, error: e }, 'Bundle search failed');
    }
  }

  return results;
}
