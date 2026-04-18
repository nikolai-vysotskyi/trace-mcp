/**
 * Edge resolution layer — extracted from IndexingPipeline.
 * Orchestrates edge resolution passes and provides shared storeRawEdges.
 * Domain-specific resolvers live in ./edge-resolvers/.
 */
import path from 'node:path';
import type { ResolveContext, RawEdge, ProjectContext } from '../plugin-api/types.js';
import { executeFrameworkResolveEdges } from '../plugin-api/executor.js';
import { buildProjectContext } from './project-context.js';
import { logger } from '../logger.js';
import type { PipelineState } from './pipeline-state.js';
import { resolveOrmAssociationEdges as _resolveOrm } from './edge-resolvers/orm.js';
import { resolveTypeScriptHeritageEdges as _resolveHeritage } from './edge-resolvers/heritage.js';
import { resolveEsmImportEdges as _resolveImports } from './edge-resolvers/imports.js';
import { resolvePythonImportEdges as _resolvePyImports } from './edge-resolvers/python-imports.js';
import { resolvePythonHeritageEdges as _resolvePyHeritage } from './edge-resolvers/python-heritage.js';
import { resolvePythonCallEdges as _resolvePyCalls } from './edge-resolvers/python-calls.js';
import { resolvePhpImportEdges as _resolvePhpImports } from './edge-resolvers/php-imports.js';
import { resolvePhpCallEdges as _resolvePhpCalls } from './edge-resolvers/php-calls.js';
import { resolveTypeScriptCallEdges as _resolveTsCalls } from './edge-resolvers/typescript-calls.js';
import { resolveTypeScriptTypeEdges as _resolveTsTypes } from './edge-resolvers/typescript-types.js';
import { resolveMemberOfEdges as _resolveMemberOf } from './edge-resolvers/member-of.js';
import { resolveTestCoversEdges as _resolveTests } from './edge-resolvers/tests.js';
import { resolveFileProjectionEdges as _resolveFileProjection, purgeForbiddenCrossWorkspaceEdges as _purgeCrossWs } from './edge-resolvers/file-projection.js';

export class EdgeResolver {
  constructor(private state: PipelineState) {}

  /** Pass 2: resolve framework plugin edges (root + per-workspace). */
  async resolveEdges(projectContext: ProjectContext, resolveContext: ResolveContext): Promise<void> {
    // Root-level plugins
    const activeResult = this.state.registry.getActiveFrameworkPlugins(projectContext);
    if (activeResult.isOk()) {
      for (const plugin of activeResult.value) {
        const result = await executeFrameworkResolveEdges(plugin, resolveContext);
        if (result.isErr()) continue;
        this.storeRawEdges(result.value);
      }
    }

    // Workspace-level plugins — each workspace may have its own frameworks.
    // We create a scoped ResolveContext that translates paths to workspace-relative.
    const seen = new Set<string>(); // avoid running the same plugin twice
    if (activeResult.isOk()) {
      for (const p of activeResult.value) seen.add(p.manifest.name);
    }

    for (const ws of this.state.workspaces) {
      const wsRoot = path.join(this.state.rootPath, ws.path);
      const wsCtx = buildProjectContext(wsRoot);
      const wsPlugins = this.state.registry.getAllFrameworkPlugins()
        .filter((p) => !seen.has(p.manifest.name) && p.detect(wsCtx));
      if (wsPlugins.length === 0) continue;

      // Create a scoped resolve context: paths are workspace-relative,
      // rootPath points to the workspace root.
      const wsPrefix = ws.path + '/';
      const scopedCtx: ResolveContext = {
        rootPath: wsRoot,
        getAllFiles: () => resolveContext.getAllFiles()
          .filter((f) => f.path.startsWith(wsPrefix))
          .map((f) => ({ ...f, path: f.path.slice(wsPrefix.length) })),
        getSymbolsByFile: resolveContext.getSymbolsByFile,
        getSymbolByFqn: resolveContext.getSymbolByFqn,
        getNodeId: resolveContext.getNodeId,
        createNodeIfNeeded: resolveContext.createNodeIfNeeded,
        readFile: (relPath: string) => resolveContext.readFile(wsPrefix + relPath),
      };

      for (const plugin of wsPlugins) {
        const result = await executeFrameworkResolveEdges(plugin, scopedCtx);
        if (result.isErr()) continue;
        this.storeRawEdges(result.value);
      }
    }
  }

  /** Pass 2b: ORM association edges. */
  resolveOrmAssociationEdges(): void { _resolveOrm(this.state); }

  /** Pass 2c: TypeScript extends/implements edges. */
  resolveTypeScriptHeritageEdges(): void { _resolveHeritage(this.state); }

  /** Pass 2d: ES module import edges. */
  resolveEsmImportEdges(): void { _resolveImports(this.state); }

  /** Pass 2e: Python import edges (dotted paths, relative imports). */
  resolvePythonImportEdges(): void { _resolvePyImports(this.state); }

  /** Pass 2e2: PHP import edges (PSR-4 use statements). */
  resolvePhpImportEdges(): void { _resolvePhpImports(this.state); }

  /** Pass 2f: Python heritage edges (class inheritance). */
  resolvePythonHeritageEdges(): void { _resolvePyHeritage(this.state); }

  /** Pass 2g: Python call edges (function/method calls → definitions). */
  resolvePythonCallEdges(): void { _resolvePyCalls(this.state); }

  /** Pass 2g2: PHP call/heritage edges (method calls, extends, implements, uses_trait). */
  resolvePhpCallEdges(): void { _resolvePhpCalls(this.state); }

  /** Pass 2g3: TypeScript/JavaScript call edges (function/method calls → definitions). */
  resolveTypeScriptCallEdges(): void { _resolveTsCalls(this.state); }

  /** Pass 2g4: TypeScript/JavaScript type-reference edges (types used in annotations). */
  resolveTypeScriptTypeEdges(): void { _resolveTsTypes(this.state); }

  /** Pass 2i: structural member_of edges for every nested symbol → its parent. */
  resolveMemberOfEdges(): void { _resolveMemberOf(this.state); }

  /** Pass 2h: test_covers edges. */
  resolveTestCoversEdges(): void { _resolveTests(this.state); }

  /** Pass 2j: file-level projection of cross-file symbol edges. */
  resolveFileProjectionEdges(): void { _resolveFileProjection(this.state); }

  /** Pass 2k (final sweep): remove forbidden cross-workspace edges. */
  purgeForbiddenCrossWorkspaceEdges(): void { _purgeCrossWs(this.state); }

  /** Store raw edges from framework/language plugins into the graph. */
  storeRawEdges(edges: RawEdge[]): void {
    if (edges.length === 0) return;
    const { store } = this.state;

    // 1. symbolIdStr → nodeId
    const symbolIdStrs = new Set<string>();
    for (const edge of edges) {
      if (edge.sourceSymbolId) symbolIdStrs.add(edge.sourceSymbolId);
      if (edge.targetSymbolId) symbolIdStrs.add(edge.targetSymbolId);
    }

    const symbolNodeCache = new Map<string, number>();
    if (symbolIdStrs.size > 0) {
      const arr = Array.from(symbolIdStrs);
      const placeholders = arr.map(() => '?').join(',');
      const rows = store.db.prepare(
        `SELECT s.symbol_id, n.id AS node_id
           FROM symbols s
           JOIN nodes n ON n.node_type = 'symbol' AND n.ref_id = s.id
          WHERE s.symbol_id IN (${placeholders})`,
      ).all(...arr) as Array<{ symbol_id: string; node_id: number }>;
      for (const row of rows) {
        symbolNodeCache.set(row.symbol_id, row.node_id);
      }
    }

    // 2. (nodeType, refId) → nodeId — batch by nodeType
    const refIdsByType = new Map<string, Set<number>>();
    for (const edge of edges) {
      if (edge.sourceNodeType && edge.sourceRefId != null) {
        let s = refIdsByType.get(edge.sourceNodeType);
        if (!s) { s = new Set(); refIdsByType.set(edge.sourceNodeType, s); }
        s.add(edge.sourceRefId);
      }
      if (edge.targetNodeType && edge.targetRefId != null) {
        let s = refIdsByType.get(edge.targetNodeType);
        if (!s) { s = new Set(); refIdsByType.set(edge.targetNodeType, s); }
        s.add(edge.targetRefId);
      }
    }
    const typeRefCache = new Map<string, number>();
    for (const [nodeType, refIds] of refIdsByType) {
      const batch = store.getNodeIdsBatch(nodeType, Array.from(refIds));
      for (const [refId, nodeId] of batch) {
        typeRefCache.set(`${nodeType}:${refId}`, nodeId);
      }
    }

    // 3. edgeTypeName → edgeTypeId (+ category for cross-workspace policy).
    // Single IN query — used to be one SELECT per distinct edge-type.
    const edgeTypeNames = new Set<string>();
    for (const edge of edges) edgeTypeNames.add(edge.edgeType);
    const edgeTypeCache = new Map<string, number>();
    const edgeTypeCategoryCache = new Map<string, string>();
    if (edgeTypeNames.size > 0) {
      const arr = Array.from(edgeTypeNames);
      const ph = arr.map(() => '?').join(',');
      const rows = store.db.prepare(
        `SELECT id, name, category FROM edge_types WHERE name IN (${ph})`,
      ).all(...arr) as Array<{ id: number; name: string; category: string }>;
      for (const row of rows) {
        edgeTypeCache.set(row.name, row.id);
        edgeTypeCategoryCache.set(row.name, row.category);
      }
    }

    // 4. Resolve src/tgt for every edge once, reused by both the workspace
    // pre-load and the insert loop. Previously each edge was resolved twice.
    const hasWorkspaces = this.state.workspaces.length > 0;
    const resolved: Array<{ src: number; tgt: number; edge: RawEdge }> = [];
    const allNodeIds = hasWorkspaces ? new Set<number>() : null;
    for (const edge of edges) {
      const src = this.resolveNodeId(edge, symbolNodeCache, typeRefCache);
      if (src == null) continue;
      const tgt = this.resolveTargetNodeId(edge, symbolNodeCache, typeRefCache) ?? src;
      resolved.push({ src, tgt, edge });
      if (allNodeIds) { allNodeIds.add(src); allNodeIds.add(tgt); }
    }

    // 5. Pre-load workspace info for cross-workspace detection
    const nodeWorkspaceCache = new Map<number, string | null>();
    if (allNodeIds && allNodeIds.size > 0) {
      const nodeIdArr = Array.from(allNodeIds);
      const ph = nodeIdArr.map(() => '?').join(',');
      const rows = store.db.prepare(`
        SELECT n.id AS node_id, f.workspace
        FROM nodes n
        LEFT JOIN files f ON (n.node_type = 'file' AND n.ref_id = f.id)
          OR (n.node_type = 'symbol' AND f.id = (SELECT file_id FROM symbols WHERE id = n.ref_id))
        WHERE n.id IN (${ph})
      `).all(...nodeIdArr) as Array<{ node_id: number; workspace: string | null }>;
      for (const row of rows) nodeWorkspaceCache.set(row.node_id, row.workspace);
    }

    // Batch insert
    const insertStmt = store.db.prepare(
      `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // Cross-workspace policy: most framework edges (Laravel ORM, Nova, Events,
    // Livewire, NestJS, etc.) resolve class references by FQN. When multiple
    // workspaces share the same FQN (e.g. `App\Models\User` in 8 Laravel
    // apps), resolvers return an arbitrary match, producing bogus cross-repo
    // edges that merge visually independent projects. Drop those at insert
    // time — the only categories that legitimately cross workspaces are:
    //   - `workspace`   : cross_workspace_import / api_call (cross-repo HTTP)
    //   - `runtime`     : observed runtime traces
    // Everything else (laravel, nova, nuxt, vue, react, nestjs, php, typescript,
    // python, core, ...) stays strictly inside its workspace.
    const CROSS_WS_ALLOWED_CATEGORIES = new Set(['workspace', 'runtime']);
    let droppedCrossWs = 0;

    const insertBatch = store.db.transaction(() => {
      for (const { edge, src: sourceNodeId, tgt: targetNodeId } of resolved) {
        const edgeTypeId = edgeTypeCache.get(edge.edgeType);
        if (edgeTypeId == null) continue;

        let isCrossWs = false;
        if (hasWorkspaces) {
          const srcWs = nodeWorkspaceCache.get(sourceNodeId);
          const tgtWs = nodeWorkspaceCache.get(targetNodeId);
          isCrossWs = srcWs != null && tgtWs != null && srcWs !== tgtWs;
        }

        if (isCrossWs) {
          const category = edgeTypeCategoryCache.get(edge.edgeType);
          if (category == null || !CROSS_WS_ALLOWED_CATEGORIES.has(category)) {
            droppedCrossWs++;
            continue;
          }
        }

        const resolutionTier = edge.resolution ?? 'ast_resolved';

        insertStmt.run(
          sourceNodeId, targetNodeId, edgeTypeId,
          (edge.resolved ?? true) ? 1 : 0,
          edge.metadata ? JSON.stringify(edge.metadata) : null,
          isCrossWs ? 1 : 0,
          resolutionTier,
        );
      }
    });
    insertBatch();

    if (droppedCrossWs > 0) {
      logger.info({ dropped: droppedCrossWs }, 'Dropped cross-workspace framework edges');
    }
  }

  private resolveNodeId(
    edge: RawEdge,
    symbolNodeCache: Map<string, number>,
    typeRefCache: Map<string, number>,
  ): number | undefined {
    if (edge.sourceNodeType && edge.sourceRefId != null) {
      return typeRefCache.get(`${edge.sourceNodeType}:${edge.sourceRefId}`)
        ?? this.state.store.getNodeId(edge.sourceNodeType, edge.sourceRefId);
    }
    if (edge.sourceSymbolId) {
      return symbolNodeCache.get(edge.sourceSymbolId);
    }
    return undefined;
  }

  private resolveTargetNodeId(
    edge: RawEdge,
    symbolNodeCache: Map<string, number>,
    typeRefCache: Map<string, number>,
  ): number | undefined {
    if (edge.targetNodeType && edge.targetRefId != null) {
      return typeRefCache.get(`${edge.targetNodeType}:${edge.targetRefId}`)
        ?? this.state.store.getNodeId(edge.targetNodeType, edge.targetRefId);
    }
    if (edge.targetSymbolId) {
      return symbolNodeCache.get(edge.targetSymbolId);
    }
    return undefined;
  }

  resolveWorkspace(relPath: string): string | null {
    for (const ws of this.state.workspaces) {
      if (relPath.startsWith(ws.path + '/') || relPath === ws.path) {
        return ws.name;
      }
    }
    return null;
  }

  isEdgeCrossWorkspace(sourceNodeId: number, targetNodeId: number): boolean {
    if (this.state.workspaces.length === 0) return false;
    const sourceWs = this.getWorkspaceForNode(sourceNodeId);
    const targetWs = this.getWorkspaceForNode(targetNodeId);
    if (sourceWs == null || targetWs == null) return false;
    return sourceWs !== targetWs;
  }

  private getWorkspaceForNode(nodeId: number): string | null {
    const ref = this.state.store.getNodeRef(nodeId);
    if (!ref) return null;
    if (ref.nodeType === 'file') {
      const file = this.state.store.getFileById(ref.refId);
      return file?.workspace ?? null;
    }
    if (ref.nodeType === 'symbol') {
      const sym = this.state.store.getSymbolById(ref.refId);
      if (!sym) return null;
      const file = this.state.store.getFileById(sym.file_id);
      return file?.workspace ?? null;
    }
    return null;
  }
}
