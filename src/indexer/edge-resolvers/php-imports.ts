/**
 * PHP import resolver — resolves php_imports edges to file-level dependencies.
 *
 * Handles:
 * - PSR-4 resolution via composer.json autoload mappings (per-workspace)
 * - FQN-based resolution via the symbols table (classes, interfaces, traits, enums)
 * - Workspace isolation: imports resolve within the same workspace first
 *
 * PHP `use App\Models\User;` → find the file containing the `App\Models\User` class.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';
import { Psr4Resolver } from '../resolvers/psr4.js';
import { PhantomPackageFactory, packageBucketFor } from './phantom-externals.js';

/**
 * Resolve PHP import edges from pendingImports into file→file edges.
 * Workspace-aware: only creates edges within the same workspace to prevent
 * false connections between independent projects under a common root.
 */
export function resolvePhpImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // WHY: driven by `state.pendingImports`, already scoped to re-extracted files.
  void _scope;
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  // Collect all indexed PHP files with their workspace
  const allPhpFiles = store.db
    .prepare(`SELECT id, path, workspace FROM files WHERE language = 'php'`)
    .all() as Array<{ id: number; path: string; workspace: string | null }>;

  if (allPhpFiles.length === 0) return;

  // Build workspace-aware FQN → file lookup
  // Key: "workspace\0fqn" (or "\0fqn" for files without workspace)
  const fqnToFile = new Map<string, { id: number; path: string; workspace: string | null }>();
  const fqnRows = store.db
    .prepare(
      `SELECT s.fqn, f.id, f.path, f.workspace FROM symbols s
     JOIN files f ON s.file_id = f.id
     WHERE s.fqn IS NOT NULL AND f.language = 'php'
       AND s.kind IN ('class', 'interface', 'trait', 'enum')`,
    )
    .all() as Array<{ fqn: string; id: number; path: string; workspace: string | null }>;

  for (const row of fqnRows) {
    const key = `${row.workspace ?? ''}\0${row.fqn}`;
    fqnToFile.set(key, { id: row.id, path: row.path, workspace: row.workspace });
  }

  // Build per-workspace PSR-4 resolvers from composer.json
  const psr4Resolvers = new Map<string, Psr4Resolver>();
  const workspacePaths = new Set<string>();
  for (const f of allPhpFiles) {
    if (f.workspace) workspacePaths.add(f.workspace);
  }

  for (const wsPath of workspacePaths) {
    const wsRoot = path.join(state.rootPath, wsPath);
    const composerPath = path.join(wsRoot, 'composer.json');
    if (fs.existsSync(composerPath)) {
      const resolver = Psr4Resolver.fromComposerJson(composerPath, wsRoot);
      if (resolver) psr4Resolvers.set(wsPath, resolver);
    }
  }

  // Also try root-level composer.json for files without workspace
  const rootComposer = path.join(state.rootPath, 'composer.json');
  if (fs.existsSync(rootComposer)) {
    const resolver = Psr4Resolver.fromComposerJson(rootComposer, state.rootPath);
    if (resolver) psr4Resolvers.set('', resolver);
  }

  // Build file path → file index
  const pathToFile = new Map<string, { id: number; path: string; workspace: string | null }>();
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

  const importsEdgeType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const insertStmt = store.db.prepare(
    `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(source_node_id, target_node_id, edge_type_id)
     DO UPDATE SET metadata = excluded.metadata`,
  );

  // Collect pending PHP file IDs
  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);

  // Build fileId → workspace lookup for pending files
  const fileWorkspace = new Map<number, string | null>();
  for (const f of allPhpFiles) {
    fileWorkspace.set(f.id, f.workspace);
  }

  // Pre-load node IDs for pending files
  for (let i = 0; i < pendingFileIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('file', pendingFileIds.slice(i, i + CHUNK))) {
      fileNodeMap.set(k, v);
    }
  }

  let created = 0;
  let phantomEdges = 0;
  const phantomPackages = new PhantomPackageFactory(state, 'php');
  const phantomEdgesSeen = new Set<string>(); // dedupe per source+bucket

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      const file = fileMap.get(fileId);
      if (!file || file.language !== 'php') continue;

      const sourceNodeId = fileNodeMap.get(fileId);
      if (sourceNodeId == null) continue;

      const sourceWs = fileWorkspace.get(fileId) ?? null;

      // Consolidate imports by FQN
      const consolidated = new Map<string, string[]>();
      for (const { from, specifiers } of imports) {
        const existing = consolidated.get(from);
        if (existing) existing.push(...specifiers);
        else consolidated.set(from, [...specifiers]);
      }

      for (const [fqn, specifiers] of consolidated) {
        const target = resolvePhpFqn(
          fqn,
          sourceWs,
          fqnToFile,
          psr4Resolvers,
          pathToFile,
          state.rootPath,
        );
        if (target) {
          const targetNodeId = fileNodeMap.get(target.id);
          if (targetNodeId == null) continue;
          if (sourceNodeId === targetNodeId) continue;

          const isCrossWs = sourceWs !== target.workspace ? 1 : 0;

          insertStmt.run(
            sourceNodeId,
            targetNodeId,
            importsEdgeType.id,
            JSON.stringify({ from: fqn, specifiers }),
            isCrossWs,
          );
          created++;
          continue;
        }

        // Unresolved FQN: likely a vendor class not indexed. Emit a file→file
        // edge to a phantom package bucket so framework-dependent files (e.g.
        // Laravel migrations, Nova resources, Symfony bundles) cluster around
        // their shared external anchor instead of sitting as disconnected dots.
        const bucket = packageBucketFor(fqn);
        if (!bucket) continue;
        const dedupKey = `${sourceNodeId}\0${sourceWs ?? ''}\0${bucket}`;
        if (phantomEdgesSeen.has(dedupKey)) continue;
        phantomEdgesSeen.add(dedupKey);

        const pkg = phantomPackages.ensure(bucket, sourceWs);
        if (pkg.node_id === sourceNodeId) continue;
        insertStmt.run(
          sourceNodeId,
          pkg.node_id,
          importsEdgeType.id,
          JSON.stringify({ from: fqn, specifiers, external: true, bucket }),
          0,
        );
        phantomEdges++;
      }
    }
  })();

  if (created > 0 || phantomEdges > 0) {
    logger.info({ edges: created, phantomEdges }, 'PHP import edges resolved');
  }
}

/**
 * Resolve a PHP FQN to a file, respecting workspace isolation.
 *
 * Resolution order:
 * 1. Same-workspace FQN lookup (symbols table)
 * 2. Same-workspace PSR-4 resolution (composer.json)
 * 3. No-workspace FQN lookup (for files outside any workspace)
 * 4. Root PSR-4 fallback
 *
 * Cross-workspace resolution is intentionally skipped to prevent false
 * connections between independent projects under a common root.
 */
function resolvePhpFqn(
  fqn: string,
  sourceWorkspace: string | null,
  fqnIndex: Map<string, { id: number; path: string; workspace: string | null }>,
  psr4Resolvers: Map<string, Psr4Resolver>,
  pathIndex: Map<string, { id: number; path: string; workspace: string | null }>,
  rootPath: string,
): { id: number; path: string; workspace: string | null } | null {
  if (!fqn) return null;

  const wsKey = sourceWorkspace ?? '';

  // 1. Same-workspace FQN lookup
  const sameWs = fqnIndex.get(`${wsKey}\0${fqn}`);
  if (sameWs) return sameWs;

  // 2. Same-workspace PSR-4 resolution
  const psr4 = psr4Resolvers.get(wsKey);
  if (psr4) {
    const resolved = psr4.resolve(fqn);
    if (resolved) {
      // PSR-4 returns path relative to workspace root — convert to project-relative
      const projectRelative = sourceWorkspace ? `${sourceWorkspace}/${resolved}` : resolved;
      const fromPath = pathIndex.get(projectRelative);
      if (fromPath) return fromPath;
    }
  }

  // 3. No-workspace fallback (for files not assigned to any workspace)
  if (sourceWorkspace) {
    const noWs = fqnIndex.get(`\0${fqn}`);
    if (noWs) return noWs;
  }

  return null;
}
