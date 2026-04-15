/**
 * PHP import resolver — resolves php_imports edges to file-level dependencies.
 *
 * Handles:
 * - PSR-4 resolution via composer.json autoload mappings
 * - FQN-based resolution via the symbols table (classes, interfaces, traits, enums)
 *
 * PHP `use App\Models\User;` → find the file containing the `App\Models\User` class.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { PipelineState } from '../pipeline-state.js';
import { Psr4Resolver } from '../resolvers/psr4.js';
import { logger } from '../../logger.js';

/**
 * Resolve PHP import edges from pendingImports into file→file edges.
 * Uses two strategies:
 * 1. FQN lookup in the symbols table (most reliable — works for any indexed symbol)
 * 2. PSR-4 resolution from composer.json (fallback for symbols not yet indexed)
 */
export function resolvePhpImportEdges(state: PipelineState): void {
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  // Collect all indexed PHP files
  const allPhpFiles = store.db.prepare(
    `SELECT id, path FROM files WHERE language = 'php'`,
  ).all() as Array<{ id: number; path: string }>;

  if (allPhpFiles.length === 0) return;

  // Strategy 1: Build FQN → fileId lookup from symbols table
  const fqnToFile = new Map<string, { id: number; path: string }>();
  const fqnRows = store.db.prepare(
    `SELECT s.fqn, f.id, f.path FROM symbols s
     JOIN files f ON s.file_id = f.id
     WHERE s.fqn IS NOT NULL AND f.language = 'php'
       AND s.kind IN ('class', 'interface', 'trait', 'enum')`,
  ).all() as Array<{ fqn: string; id: number; path: string }>;

  for (const row of fqnRows) {
    fqnToFile.set(row.fqn, { id: row.id, path: row.path });
  }

  // Strategy 2: Try PSR-4 resolver from composer.json
  const composerPath = path.join(state.rootPath, 'composer.json');
  const psr4 = fs.existsSync(composerPath)
    ? Psr4Resolver.fromComposerJson(composerPath, state.rootPath)
    : undefined;

  // Build file path → fileId index for PSR-4 fallback
  const pathToFile = new Map<string, { id: number; path: string }>();
  for (const f of allPhpFiles) {
    pathToFile.set(f.path, f);
  }

  // Pre-load file node IDs
  const fileNodeMap = new Map<number, number>();
  const allFileIds = allPhpFiles.map((f) => f.id);
  const CHUNK = 500;
  for (let i = 0; i < allFileIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('file', allFileIds.slice(i, i + CHUNK))) {
      fileNodeMap.set(k, v);
    }
  }

  const importsEdgeType = store.db.prepare(
    `SELECT id FROM edge_types WHERE name = ?`,
  ).get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const insertStmt = store.db.prepare(
    `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, ?, 0)
     ON CONFLICT(source_node_id, target_node_id, edge_type_id)
     DO UPDATE SET metadata = excluded.metadata`,
  );

  // Collect pending PHP file IDs
  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);

  // Pre-load node IDs for pending files
  for (let i = 0; i < pendingFileIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('file', pendingFileIds.slice(i, i + CHUNK))) {
      fileNodeMap.set(k, v);
    }
  }

  let created = 0;

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      const file = fileMap.get(fileId);
      if (!file || file.language !== 'php') continue;

      const sourceNodeId = fileNodeMap.get(fileId);
      if (sourceNodeId == null) continue;

      // Consolidate imports by FQN
      const consolidated = new Map<string, string[]>();
      for (const { from, specifiers } of imports) {
        const existing = consolidated.get(from);
        if (existing) existing.push(...specifiers);
        else consolidated.set(from, [...specifiers]);
      }

      for (const [fqn, specifiers] of consolidated) {
        const target = resolvePhpFqn(fqn, fqnToFile, psr4, pathToFile);
        if (!target) continue;

        const targetNodeId = fileNodeMap.get(target.id);
        if (targetNodeId == null) continue;
        if (sourceNodeId === targetNodeId) continue;

        insertStmt.run(
          sourceNodeId,
          targetNodeId,
          importsEdgeType.id,
          JSON.stringify({ from: fqn, specifiers }),
        );
        created++;
      }
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'PHP import edges resolved');
  }
}

/**
 * Resolve a PHP FQN to a file using multiple strategies:
 * 1. Direct FQN lookup in the symbols table
 * 2. PSR-4 resolution from composer.json
 */
function resolvePhpFqn(
  fqn: string,
  fqnIndex: Map<string, { id: number; path: string }>,
  psr4: Psr4Resolver | undefined,
  pathIndex: Map<string, { id: number; path: string }>,
): { id: number; path: string } | null {
  if (!fqn) return null;

  // Strategy 1: direct FQN lookup (most reliable)
  const fromFqn = fqnIndex.get(fqn);
  if (fromFqn) return fromFqn;

  // Strategy 2: PSR-4 resolution
  if (psr4) {
    const resolved = psr4.resolve(fqn);
    if (resolved) {
      const fromPath = pathIndex.get(resolved);
      if (fromPath) return fromPath;
    }
  }

  return null;
}
