/**
 * Edge resolution layer — extracted from IndexingPipeline.
 * Orchestrates edge resolution passes and provides shared storeRawEdges.
 * Domain-specific resolvers live in ./edge-resolvers/.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { logger } from '../logger.js';
import { executeFrameworkResolveEdges } from '../plugin-api/executor.js';
import type {
  ChangeScope,
  FrameworkPlugin,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../plugin-api/types.js';
import {
  purgeForbiddenCrossWorkspaceEdges as _purgeCrossWs,
  resolveFileProjectionEdges as _resolveFileProjection,
} from './edge-resolvers/file-projection.js';
import { resolveCImportEdges as _resolveCImports } from './edge-resolvers/c-imports.js';
import { resolveCSharpImportEdges as _resolveCSharpImports } from './edge-resolvers/csharp-imports.js';
import { purgeStaleElectronEdges as _purgeElectron } from './edge-resolvers/electron-removals.js';
import { resolveElixirImportEdges as _resolveElixirImports } from './edge-resolvers/elixir-imports.js';
import { resolveTypeScriptHeritageEdges as _resolveHeritage } from './edge-resolvers/heritage.js';
import { resolveIacImportEdges as _resolveIacImports } from './edge-resolvers/iac-imports.js';
import { resolveGoImportEdges as _resolveGoImports } from './edge-resolvers/go-imports.js';
import { resolveJavaImportEdges as _resolveJavaImports } from './edge-resolvers/java-imports.js';
import { resolveEsmImportEdges as _resolveImports } from './edge-resolvers/imports.js';
import { resolveKotlinImportEdges as _resolveKotlinImports } from './edge-resolvers/kotlin-imports.js';
import { resolveLuaImportEdges as _resolveLuaImports } from './edge-resolvers/lua-imports.js';
import { resolveMarkdownTagEdges as _resolveMarkdownTags } from './edge-resolvers/markdown-tags.js';
import { resolveMarkdownWikilinkEdges as _resolveMarkdownLinks } from './edge-resolvers/markdown-wikilinks.js';
import { resolveMemberOfEdges as _resolveMemberOf } from './edge-resolvers/member-of.js';
import { resolveOrmAssociationEdges as _resolveOrm } from './edge-resolvers/orm.js';
import { resolvePhpCallEdges as _resolvePhpCalls } from './edge-resolvers/php-calls.js';
import { resolvePhpImportEdges as _resolvePhpImports } from './edge-resolvers/php-imports.js';
import { resolvePythonCallEdges as _resolvePyCalls } from './edge-resolvers/python-calls.js';
import { resolvePythonHeritageEdges as _resolvePyHeritage } from './edge-resolvers/python-heritage.js';
import { resolvePythonImportEdges as _resolvePyImports } from './edge-resolvers/python-imports.js';
import { resolveFastapiRouterMounts as _resolveFastapiMounts } from './edge-resolvers/fastapi-mounts.js';
import { resolvePythonTypeEdges as _resolvePyTypes } from './edge-resolvers/python-types.js';
import { resolveRubyImportEdges as _resolveRubyImports } from './edge-resolvers/ruby-imports.js';
import { resolveRustImportEdges as _resolveRustImports } from './edge-resolvers/rust-imports.js';
import { resolveTestCoversEdges as _resolveTests } from './edge-resolvers/tests.js';
import { resolveTypeScriptCallEdges as _resolveTsCalls } from './edge-resolvers/typescript-calls.js';
import { resolveTypeScriptTypeEdges as _resolveTsTypes } from './edge-resolvers/typescript-types.js';
import type { PipelineState } from './pipeline-state.js';
import { buildProjectContext } from './project-context.js';
import { runInOwnTurn, yieldToEventLoopFair } from '../utils/event-loop.js';

/**
 * Edge types whose targets live in metadata and are resolved later by a
 * dedicated resolver. When `storeRawEdges` cannot resolve a graph target for
 * one of these, it must drop the edge rather than fall back to a source→source
 * self-loop. Currently the Python type-annotation carriers, which are turned
 * into proper `references` edges by `resolvePythonTypeEdges`.
 */
const SELF_LOOP_SUPPRESSED_EDGE_TYPES = new Set<string>(['py_param_type', 'py_return_type']);

/**
 * Wrap a resolver call with debug-level timing. Off at info log level;
 * visible via `TRACE_MCP_LOG_LEVEL=debug`. Used to verify Phase 4 scope-aware
 * resolvers stay within their budget under real workloads.
 */
function timed<T>(name: string, fn: () => T): T {
  if (!logger.isLevelEnabled?.('debug')) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - t0;
    logger.debug({ resolver: name, ms }, 'edge resolver complete');
  }
}

/**
 * Async variant of `timed` for the TRA-1764 chunked resolvers, whose passes
 * yield to the event loop between transactions. The reported ms is
 * wall-clock including yields — a chunked pass legitimately reads slower
 * than its old synchronous span.
 */
async function timedAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!logger.isLevelEnabled?.('debug')) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - t0;
    logger.debug({ resolver: name, ms }, 'edge resolver complete');
  }
}

export class EdgeResolver {
  constructor(private state: PipelineState) {}

  /**
   * Pass 2: resolve framework plugin edges (root + per-workspace).
   *
   * Every plugin pass runs in a turn of its own (TRA-922). These passes are
   * fully synchronous (better-sqlite3 + in-memory scans), and on a daemon
   * with several registered projects their sum held the event loop long
   * enough that the TCP accept queue on :3741 never drained — sessions hung
   * in SYN_SENT and each fell back to indexing locally. The fair yield
   * between passes bounds the stall window to the largest single plugin
   * pass, and the per-workspace yield splits the per-project passes the
   * same way. Order is unchanged: the awaits stay sequential, only
   * macrotask boundaries move.
   */
  async resolveEdges(
    projectContext: ProjectContext,
    resolveContext: ResolveContext,
    _scope?: ChangeScope,
  ): Promise<void> {
    // Root-level plugins
    const activeResult = this.state.registry.getActiveFrameworkPlugins(projectContext);
    if (activeResult.isOk()) {
      for (const plugin of activeResult.value) {
        await this.resolvePluginEdges(plugin, resolveContext);
      }
    }

    // Workspace-level plugins — each workspace may have its own frameworks.
    // We create a scoped ResolveContext that translates paths to workspace-relative.
    const seen = new Set<string>(); // avoid running the same plugin twice
    if (activeResult.isOk()) {
      for (const p of activeResult.value) seen.add(p.manifest.name);
    }

    for (const ws of this.state.workspaces) {
      // Per-project boundary: let pending I/O (/health, MCP requests) run
      // between workspaces rather than after all of them.
      await yieldToEventLoopFair();
      const wsRoot = path.join(this.state.rootPath, ws.path);
      // TRA-1543: reuse the pipeline's per-run detection when available (the
      // pipeline already detected these for edge-type registration — detecting
      // again here doubled the manifest reads). Producers that predate the
      // shared map fall back to detecting inline: same set, same order.
      const shared = this.state.wsFrameworkPlugins?.get(ws.path);
      let wsPlugins: FrameworkPlugin[];
      if (shared) {
        wsPlugins = shared.filter((p) => !seen.has(p.manifest.name));
      } else {
        const wsCtx = buildProjectContext(wsRoot);
        wsPlugins = this.state.registry
          .getAllFrameworkPlugins()
          .filter((p) => !seen.has(p.manifest.name) && p.detect(wsCtx));
      }
      if (wsPlugins.length === 0) continue;

      // Create a scoped resolve context: paths are workspace-relative,
      // rootPath points to the workspace root.
      const wsPrefix = `${ws.path}/`;
      const scopedCtx: ResolveContext = {
        rootPath: wsRoot,
        getAllFiles: () =>
          resolveContext
            .getAllFiles()
            .filter((f) => f.path.startsWith(wsPrefix))
            .map((f) => ({ ...f, path: f.path.slice(wsPrefix.length) })),
        getSymbolsByFile: resolveContext.getSymbolsByFile,
        getSymbolByFqn: resolveContext.getSymbolByFqn,
        getNodeId: resolveContext.getNodeId,
        createNodeIfNeeded: resolveContext.createNodeIfNeeded,
        readFile: (relPath: string) => resolveContext.readFile(wsPrefix + relPath),
      };

      for (const plugin of wsPlugins) {
        await this.resolvePluginEdges(plugin, scopedCtx);
      }
    }
  }

  /**
   * One framework plugin's resolve + store as a single fair turn. The
   * closure is async so a plugin that genuinely awaits I/O still resolves
   * before its edges are stored; for the usual synchronous plugin the whole
   * pass (resolve + SQLite store) completes inside the one turn, and the
   * next plugin cannot start until this one finished — order preserved.
   */
  private async resolvePluginEdges(plugin: FrameworkPlugin, ctx: ResolveContext): Promise<void> {
    await runInOwnTurn(async () => {
      const result = await executeFrameworkResolveEdges(plugin, ctx);
      if (result.isErr()) return;
      this.storeRawEdges(result.value);
    });
  }

  /**
   * TRA-1780: purge stale file-anchored electron cross-file edges (removal
   * direction). Runs right after the framework Pass-2 emission so fresh
   * virtuals are already in place, and before file projection (which only
   * reads symbol→symbol edges, but ordering here keeps the invariant
   * "purge sees post-emit state" explicit).
   */
  resolveElectronRemovalEdges(scope?: ChangeScope): void {
    timed('electron-removals', () =>
      _purgeElectron(this.state, scope, (edges) => this.storeRawEdges(edges)),
    );
  }

  /** Pass 2b: ORM association edges. */
  resolveOrmAssociationEdges(scope?: ChangeScope): void {
    timed('orm', () => _resolveOrm(this.state, scope));
  }

  /** Pass 2c: TypeScript extends/implements edges. */
  resolveTypeScriptHeritageEdges(scope?: ChangeScope): void {
    timed('ts-heritage', () => _resolveHeritage(this.state, scope));
  }

  /** Pass 2d: ES module import edges. */
  resolveEsmImportEdges(scope?: ChangeScope): Promise<void> {
    return timedAsync('esm-imports', () => _resolveImports(this.state, scope));
  }

  /** Pass 2e: Python import edges (dotted paths, relative imports). */
  resolvePythonImportEdges(scope?: ChangeScope): void {
    timed('py-imports', () => _resolvePyImports(this.state, scope));
  }

  /** Pass 2e3: Go import edges (module path → package directory). */
  resolveGoImportEdges(scope?: ChangeScope): void {
    timed('go-imports', () => _resolveGoImports(this.state, scope));
  }

  /** Pass 2e4: Java import edges (package name → source directory). */
  resolveJavaImportEdges(scope?: ChangeScope): void {
    timed('java-imports', () => _resolveJavaImports(this.state, scope));
  }

  /** Pass 2e9: Kotlin import edges (package name → source directory). */
  resolveKotlinImportEdges(scope?: ChangeScope): void {
    timed('kotlin-imports', () => _resolveKotlinImports(this.state, scope));
  }

  /** Pass 2e5: Rust import edges (module path → module file). */
  resolveRustImportEdges(scope?: ChangeScope): void {
    timed('rust-imports', () => _resolveRustImports(this.state, scope));
  }

  /** Pass 2e6: C/C++ import edges (`#include` path → header/source file). */
  resolveCImportEdges(scope?: ChangeScope): void {
    timed('c-imports', () => _resolveCImports(this.state, scope));
  }

  /** Pass 2e7: Ruby import edges (`require`/`require_relative` → source file). */
  resolveRubyImportEdges(scope?: ChangeScope): void {
    timed('ruby-imports', () => _resolveRubyImports(this.state, scope));
  }

  /** Pass 2e8: C# import edges (`using` directive → namespace-declaring file). */
  resolveCSharpImportEdges(scope?: ChangeScope): void {
    timed('csharp-imports', () => _resolveCSharpImports(this.state, scope));
  }

  /** Pass 2e10: Elixir import edges (`alias`/`import`/`use`/`require` → module file). */
  resolveElixirImportEdges(scope?: ChangeScope): void {
    timed('elixir-imports', () => _resolveElixirImports(this.state, scope));
  }

  /** Pass 2e11: Lua import edges (`require` → module file). */
  resolveLuaImportEdges(scope?: ChangeScope): void {
    timed('lua-imports', () => _resolveLuaImports(this.state, scope));
  }

  /** Pass 2e2: PHP import edges (PSR-4 use statements). */
  resolvePhpImportEdges(scope?: ChangeScope): void {
    timed('php-imports', () => _resolvePhpImports(this.state, scope));
  }

  /** Pass 2f: Python heritage edges (class inheritance). */
  resolvePythonHeritageEdges(scope?: ChangeScope): void {
    timed('py-heritage', () => _resolvePyHeritage(this.state, scope));
  }

  /** Pass 2g: Python call edges (function/method calls → definitions). */
  resolvePythonCallEdges(scope?: ChangeScope): Promise<void> {
    return timedAsync('py-calls', () => _resolvePyCalls(this.state, scope));
  }

  /** Pass 2g1b: Python type-reference edges (param/return/attribute annotations → class symbols). */
  resolvePythonTypeEdges(scope?: ChangeScope): void {
    timed('py-types', () => _resolvePyTypes(this.state, scope));
  }

  /** Pass 2g1c: compose cross-file FastAPI `include_router(prefix=...)` mount
   * prefixes onto the mounted routers' route URIs. Depends on Python import
   * edges (run resolvePythonImportEdges first). */
  resolveFastapiRouterMounts(scope?: ChangeScope): void {
    timed('fastapi-mounts', () => _resolveFastapiMounts(this.state, scope));
  }

  /** Pass 2g2: PHP call/heritage edges (method calls, extends, implements, uses_trait). */
  resolvePhpCallEdges(scope?: ChangeScope): Promise<void> {
    return timedAsync('php-calls', () => _resolvePhpCalls(this.state, scope));
  }

  /** Pass 2g3: TypeScript/JavaScript call edges (function/method calls → definitions). */
  resolveTypeScriptCallEdges(scope?: ChangeScope): Promise<void> {
    return timedAsync('ts-calls', () => _resolveTsCalls(this.state, scope));
  }

  /** Pass 2g4: TypeScript/JavaScript type-reference edges (types used in annotations). */
  resolveTypeScriptTypeEdges(scope?: ChangeScope): void {
    timed('ts-types', () => _resolveTsTypes(this.state, scope));
  }

  /** Pass 2i: structural member_of edges for every nested symbol → its parent. */
  resolveMemberOfEdges(scope?: ChangeScope): void {
    timed('member-of', () => _resolveMemberOf(this.state, scope));
  }

  /** Pass 2h: test_covers edges. */
  resolveTestCoversEdges(scope?: ChangeScope): Promise<void> {
    return timedAsync('tests', () => _resolveTests(this.state, scope));
  }

  /** Pass 2j: file-level projection of cross-file symbol edges. */
  resolveFileProjectionEdges(scope?: ChangeScope): Promise<void> {
    return timedAsync('file-projection', () => _resolveFileProjection(this.state, scope));
  }

  /**
   * Pass 2l: resolve IaC (Kustomize + docker-compose) path-string `imports`
   * edges to the actual manifest / Dockerfile node. Must run after all files
   * are indexed so the target manifests exist in the graph.
   */
  resolveIacImportEdges(scope?: ChangeScope): void {
    timed('iac-imports', () => _resolveIacImports(this.state, scope));
  }

  /** Pass 2m: Markdown wikilink + md-link edges between notes. */
  resolveMarkdownWikilinkEdges(scope?: ChangeScope): void {
    timed('md-wikilinks', () =>
      _resolveMarkdownLinks(this.state, (edges) => this.storeRawEdges(edges), scope),
    );
  }

  /** Pass 2n: Markdown tag aggregation — note → canonical `tag:<name>` symbol. */
  resolveMarkdownTagEdges(scope?: ChangeScope): void {
    timed('md-tags', () =>
      _resolveMarkdownTags(this.state, (edges) => this.storeRawEdges(edges), scope),
    );
  }

  /** Pass 2k (final sweep): remove forbidden cross-workspace edges. */
  purgeForbiddenCrossWorkspaceEdges(): void {
    _purgeCrossWs(this.state);
  }

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
      const rows = store.db
        .prepare(
          `SELECT s.symbol_id, n.id AS node_id
           FROM symbols s
           JOIN nodes n ON n.node_type = 'symbol' AND n.ref_id = s.id
          WHERE s.symbol_id IN (${placeholders})`,
        )
        .all(...arr) as Array<{ symbol_id: string; node_id: number }>;
      for (const row of rows) {
        symbolNodeCache.set(row.symbol_id, row.node_id);
      }
    }

    // 2. (nodeType, refId) → nodeId — batch by nodeType
    const refIdsByType = new Map<string, Set<number>>();
    for (const edge of edges) {
      if (edge.sourceNodeType && edge.sourceRefId != null) {
        let s = refIdsByType.get(edge.sourceNodeType);
        if (!s) {
          s = new Set();
          refIdsByType.set(edge.sourceNodeType, s);
        }
        s.add(edge.sourceRefId);
      }
      if (edge.targetNodeType && edge.targetRefId != null) {
        let s = refIdsByType.get(edge.targetNodeType);
        if (!s) {
          s = new Set();
          refIdsByType.set(edge.targetNodeType, s);
        }
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
      const rows = store.db
        .prepare(`SELECT id, name, category FROM edge_types WHERE name IN (${ph})`)
        .all(...arr) as Array<{ id: number; name: string; category: string }>;
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
      const resolvedTgt = this.resolveTargetNodeId(edge, symbolNodeCache, typeRefCache);
      // Annotation-only edge types (Python type annotations) carry their target
      // in metadata, to be resolved later into `references` edges by a dedicated
      // resolver. They never have a graph target here — persisting them as
      // source→source self-loops just pollutes the graph (inflating byEdgeType,
      // PageRank, and impact counts) with edges no consumer reads. Skip them.
      if (resolvedTgt == null && SELF_LOOP_SUPPRESSED_EDGE_TYPES.has(edge.edgeType)) continue;
      const tgt = resolvedTgt ?? src;
      resolved.push({ src, tgt, edge });
      if (allNodeIds) {
        allNodeIds.add(src);
        allNodeIds.add(tgt);
      }
    }

    // 5. Pre-load workspace info for cross-workspace detection.
    //
    // TRA-1834: the old form joined with an OR plus a correlated subquery
    // (`... OR (n.node_type = 'symbol' AND f.id = (SELECT file_id FROM
    // symbols ...))`), which defeats index use on the join and plans as a
    // scan with per-row TEXT comparisons — exactly the B-tree + binCollFunc
    // shape a wedged `sqlite3_step` shows. The rewrite below is
    // row-for-row equivalent (LEFT JOINs on PK equality only, so no
    // fan-out and no dropped rows for any node_type) while every join
    // probes by primary key.
    const nodeWorkspaceCache = new Map<number, string | null>();
    if (allNodeIds && allNodeIds.size > 0) {
      const nodeIdArr = Array.from(allNodeIds);
      const ph = nodeIdArr.map(() => '?').join(',');
      const rows = store.db
        .prepare(`
        SELECT n.id AS node_id, COALESCE(f_by_file.workspace, f_by_symbol.workspace) AS workspace
        FROM nodes n
        LEFT JOIN files f_by_file ON n.node_type = 'file' AND f_by_file.id = n.ref_id
        LEFT JOIN symbols s ON n.node_type = 'symbol' AND s.id = n.ref_id
        LEFT JOIN files f_by_symbol ON f_by_symbol.id = s.file_id
        WHERE n.id IN (${ph})
      `)
        .all(...nodeIdArr) as Array<{ node_id: number; workspace: string | null }>;
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
          sourceNodeId,
          targetNodeId,
          edgeTypeId,
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
      return (
        typeRefCache.get(`${edge.sourceNodeType}:${edge.sourceRefId}`) ??
        this.state.store.getNodeId(edge.sourceNodeType, edge.sourceRefId)
      );
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
      return (
        typeRefCache.get(`${edge.targetNodeType}:${edge.targetRefId}`) ??
        this.state.store.getNodeId(edge.targetNodeType, edge.targetRefId)
      );
    }
    if (edge.targetSymbolId) {
      return symbolNodeCache.get(edge.targetSymbolId);
    }
    return undefined;
  }

  resolveWorkspace(relPath: string): string | null {
    for (const ws of this.state.workspaces) {
      if (relPath.startsWith(`${ws.path}/`) || relPath === ws.path) {
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
