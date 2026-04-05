import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { TraceMcpConfig } from '../config.js';
import type { ResolveContext, RawEdge, RawRoute, RawComponent, RawMigration, RawOrmModel, RawOrmAssociation, RawRnScreen, ProjectContext, FileParseResult } from '../plugin-api/types.js';
import { buildProjectContext } from './project-context.js';
import { executeLanguagePlugin, executeFrameworkExtractNodes, executeFrameworkResolveEdges } from '../plugin-api/executor.js';
import { hashContent } from '../utils/hasher.js';
import { validatePath, validateFileSize, isSensitiveFile, isBinaryBuffer } from '../utils/security.js';
import { logger } from '../logger.js';
import { detectWorkspaces, type WorkspaceInfo } from './monorepo.js';
import { EsModuleResolver } from './resolvers/es-modules.js';
import { parseEnvFile } from '../utils/env-parser.js';
import { computeComplexity } from '../tools/complexity.js';
import { GitignoreMatcher } from '../utils/gitignore.js';
import { invalidatePageRankCache } from '../scoring/pagerank.js';
import { indexTrigramsBatch, deleteTrigramsByFile } from '../db/fuzzy.js';
import { captureGraphSnapshots } from '../tools/history.js';

export interface IndexingResult {
  totalFiles: number;
  indexed: number;
  skipped: number;
  errors: number;
  durationMs: number;
  incremental?: boolean;
}

/** Pre-computed extraction for a single file — no DB writes performed yet. */
interface FileExtraction {
  relPath: string;
  existingId: number | null;
  hash: string;
  contentSize: number;
  language: string;
  workspace: string | null;
  gitignored: boolean;
  status: string;
  frameworkRole?: string;
  symbols: import('../plugin-api/types.js').RawSymbol[];
  otherEdges: RawEdge[];
  importEdges: { from: string; specifiers: string[]; relPath: string }[];
  routes: RawRoute[];
  components: RawComponent[];
  migrations: RawMigration[];
  ormModels: RawOrmModel[];
  ormAssociations: RawOrmAssociation[];
  rnScreens: RawRnScreen[];
  frameworkExtracts: FileParseResult[];
}

export class IndexingPipeline {
  constructor(
    private store: Store,
    private registry: PluginRegistry,
    private config: TraceMcpConfig,
    private rootPath: string,
  ) {}

  private workspaces: WorkspaceInfo[] = [];
  // Serializes concurrent indexAll/indexFiles calls — prevents a watcher-triggered
  // indexFiles from racing with an in-progress indexAll (which would overwrite files
  // the watcher already re-indexed with stale content).
  private _lock: Promise<unknown> = Promise.resolve();
  // Cached once per pipeline instance — package.json / composer.json don't change mid-run.
  private _projectContext: ReturnType<typeof this._buildProjectContext> | undefined;
  // File content cache: avoids re-reading files from disk during resolveEdges (Pass 2).
  private _fileContentCache = new Map<string, string>();
  // Pending import edges: collected in Pass 1, resolved to file→file edges in Pass 2d.
  private _pendingImports = new Map<number, { from: string; specifiers: string[]; relPath: string }[]>();
  // Gitignore matcher — flags files whose content should not be served to AI.
  private _gitignore: GitignoreMatcher | undefined;
  // Incremental indexing state: tracks which files were actually re-indexed in this run.
  // When set, edge resolution passes scope to these files only (O(changed) not O(all)).
  private _changedFileIds = new Set<number>();
  private _isIncremental = false;

  async indexAll(force?: boolean): Promise<IndexingResult> {
    const result = this._lock.then(async () => {
      this._isIncremental = false;
      const start = Date.now();
      this.workspaces = detectWorkspaces(this.rootPath);
      if (this.workspaces.length > 0) {
        logger.info({ workspaces: this.workspaces.map((w) => w.name) }, 'Detected workspaces');
      }
      const filePaths = await this.collectFiles();
      return this.runPipeline(filePaths, force ?? false, start);
    });
    this._lock = result.catch(() => {});
    return result as Promise<IndexingResult>;
  }

  /** Remove deleted files from the index (batched in single transaction). */
  deleteFiles(filePaths: string[]): void {
    if (filePaths.length === 0) return;
    this.store.db.transaction(() => {
      for (const fp of filePaths) {
        const relPath = path.isAbsolute(fp) ? path.relative(this.rootPath, fp) : fp;
        const file = this.store.getFile(relPath);
        if (file) {
          this.store.deleteFile(file.id);
          logger.info({ file: relPath }, 'Deleted file from index');
        }
      }
    })();
  }

  async indexFiles(filePaths: string[]): Promise<IndexingResult> {
    const result = this._lock.then(async () => {
      this._isIncremental = true;
      const start = Date.now();
      const relPaths: string[] = [];
      for (const fp of filePaths) {
        const rel = path.isAbsolute(fp) ? path.relative(this.rootPath, fp) : fp;
        const check = validatePath(rel, this.rootPath);
        if (check.isErr()) {
          logger.warn({ file: fp }, 'Path traversal blocked in indexFiles');
          continue;
        }
        relPaths.push(rel);
      }
      return this.runPipeline(relPaths, false, start);
    });
    this._lock = result.catch(() => {});
    return result as Promise<IndexingResult>;
  }

  private async runPipeline(
    relPaths: string[],
    force: boolean,
    startMs: number,
  ): Promise<IndexingResult> {
    const result: IndexingResult = {
      totalFiles: relPaths.length,
      indexed: 0,
      skipped: 0,
      errors: 0,
      durationMs: 0,
    };

    // Clear cached project context and plugin detection so framework activation uses fresh manifests
    this._projectContext = undefined;
    this.registry.clearCaches();
    this._changedFileIds.clear();

    // Load .gitignore rules (lazy — reloaded per pipeline run to pick up changes)
    this._gitignore = new GitignoreMatcher(this.rootPath);

    // Register edge types from framework plugins
    this.registerFrameworkEdgeTypes();

    try {
      // Pass 1: extract + persist in batched transactions for throughput.
      // Splitting extract (CPU/IO) from persist (DB) lets us wrap each batch
      // in a single SQLite transaction instead of one per file.
      {
        const BATCH_SIZE = 100;
        for (let i = 0; i < relPaths.length; i += BATCH_SIZE) {
          const batch = relPaths.slice(i, i + BATCH_SIZE);
          const extractions: FileExtraction[] = [];

          for (const relPath of batch) {
            const ext = await this.extractFile(relPath, force);
            if (ext === 'skipped') { result.skipped++; continue; }
            if (ext === 'error') { result.errors++; continue; }
            extractions.push(ext);
          }

          if (extractions.length > 0) {
            this.persistBatch(extractions);
            result.indexed += extractions.length;
          }
        }
      }

      // Pass 2: resolve edges (framework plugins)
      await this.resolveEdges();

      // Pass 2b: ORM associations → graph edges (resolved after all entities indexed)
      this.resolveOrmAssociationEdges();

      // Pass 2c: TypeScript heritage → graph edges (extends/implements → find_usages)
      this.resolveTypeScriptHeritageEdges();

      // Pass 2d: ES module imports → file→file edges (enables dependency graph + dead export analysis)
      this.resolveEsmImportEdges();

      // Pass 2e: test_covers edges — test file imports source file → test_covers edge
      this.resolveTestCoversEdges();

      // Pass 3: Index .env files (keys + type metadata only, never store values)
      await this.indexEnvFiles(force);
    } finally {
      // Release memory — file content is no longer needed after Pass 2.
      // In a finally block so caches are freed even if a pass throws.
      this._fileContentCache.clear();
      this._pendingImports.clear();
      this._changedFileIds.clear();
      // Invalidate PageRank cache — edges changed, stale scores would mislead ranking.
      invalidatePageRankCache();
    }

    // Capture graph snapshots for time-machine analysis (non-blocking, after main pipeline).
    // Only on full reindex to avoid snapshot spam from file-watcher micro-updates.
    if (!this._isIncremental && result.indexed > 0) {
      try {
        captureGraphSnapshots(this.store, this.rootPath);
      } catch (e) {
        logger.warn({ error: e }, 'Graph snapshot capture failed');
      }
    }

    result.durationMs = Date.now() - startMs;
    result.incremental = this._isIncremental;
    logger.info(result, 'Indexing pipeline completed');
    return result;
  }

  /**
   * Extract phase: read file, parse with plugin, compute complexity.
   * Pure computation — no DB writes.
   */
  private async extractFile(
    relPath: string,
    force: boolean,
  ): Promise<FileExtraction | 'skipped' | 'error'> {
    const absPath = path.resolve(this.rootPath, relPath);

    // Defence-in-depth: reject paths that escape the project root
    const pathCheck = validatePath(relPath, this.rootPath);
    if (pathCheck.isErr()) {
      logger.warn({ file: relPath }, 'Path traversal blocked');
      return 'error';
    }

    // Reject symlinks to prevent escaping the project root
    try {
      if (fs.lstatSync(absPath).isSymbolicLink()) {
        logger.warn({ file: relPath }, 'Symlink skipped');
        return 'error';
      }
    } catch {
      // lstat failed — file may not exist; readFileSync below will catch it
    }

    // Block sensitive files (credentials, keys, secrets) from indexing
    if (isSensitiveFile(relPath)) {
      logger.warn({ file: relPath }, 'Sensitive file blocked from indexing');
      return 'skipped';
    }

    let content: Buffer;
    try {
      content = fs.readFileSync(absPath);
    } catch {
      logger.warn({ file: relPath }, 'Cannot read file');
      return 'error';
    }

    // Reject binary files (null-byte in first 8 KB)
    if (isBinaryBuffer(content)) {
      logger.warn({ file: relPath }, 'Binary file detected, skipping');
      return 'skipped';
    }

    // Reject oversized files (default 1 MB) to prevent OOM
    const sizeCheck = validateFileSize(content.length);
    if (sizeCheck.isErr()) {
      logger.warn({ file: relPath, size: content.length }, 'File too large, skipping');
      return 'error';
    }

    // Cache content for Pass 2 (resolveEdges reads files again)
    const contentStr = content.toString('utf-8');
    this._fileContentCache.set(relPath, contentStr);

    const hash = hashContent(content);
    const existing = this.store.getFile(relPath);

    // Skip if unchanged
    if (!force && existing && existing.content_hash === hash) {
      return 'skipped';
    }

    // Find matching language plugin
    const plugin = this.registry.getLanguagePluginForFile(relPath);
    if (!plugin) {
      return 'skipped';
    }

    // Execute language plugin
    const parseResult = await executeLanguagePlugin(plugin, relPath, content);
    if (parseResult.isErr()) {
      logger.error({ file: relPath, error: parseResult.error }, 'Language plugin failed');
      return 'error';
    }

    const parsed = parseResult.value;
    const language = parsed.language ?? this.detectLanguage(relPath);
    const workspace = this.resolveWorkspace(relPath);

    // Compute complexity metrics and attach to symbol metadata.
    // Skip trivial symbols (≤2 lines) — they always have cyclomatic=1, nesting=0.
    for (const sym of parsed.symbols) {
      if (sym.kind === 'function' || sym.kind === 'method' || sym.kind === 'class') {
        const lines = (sym.lineEnd ?? sym.lineStart ?? 0) - (sym.lineStart ?? 0);
        if (lines <= 2) {
          sym.metadata = {
            ...(sym.metadata ?? {}),
            cyclomatic: 1,
            max_nesting: 0,
            param_count: sym.signature ? computeComplexity('', sym.signature, language).param_count : 0,
          };
          continue;
        }
        const source = contentStr.slice(sym.byteStart, sym.byteEnd);
        const metrics = computeComplexity(source, sym.signature, language);
        sym.metadata = {
          ...(sym.metadata ?? {}),
          cyclomatic: metrics.cyclomatic,
          max_nesting: metrics.max_nesting,
          param_count: metrics.param_count,
        };
      }
    }

    // Separate import edges from other edges
    const otherEdges: RawEdge[] = [];
    const importEdges: { from: string; specifiers: string[]; relPath: string }[] = [];
    if (parsed.edges?.length) {
      for (const edge of parsed.edges) {
        if (edge.edgeType === 'imports' && !edge.sourceNodeType && !edge.sourceSymbolId) {
          importEdges.push({
            from: (edge.metadata as Record<string, unknown>)?.['from'] as string ?? '',
            specifiers: ((edge.metadata as Record<string, unknown>)?.['specifiers'] as string[]) ?? [],
            relPath,
          });
        } else {
          otherEdges.push(edge);
        }
      }
    }

    // Collect framework extract results (no DB writes)
    const frameworkExtracts = await this.collectFrameworkExtracts(relPath, content, language);

    return {
      relPath,
      existingId: existing?.id ?? null,
      hash,
      contentSize: content.length,
      language,
      workspace,
      gitignored: this._gitignore?.isIgnored(relPath) ?? false,
      status: parsed.status,
      frameworkRole: parsed.frameworkRole,
      symbols: parsed.symbols,
      otherEdges,
      importEdges,
      routes: parsed.routes ?? [],
      components: parsed.components ?? [],
      migrations: parsed.migrations ?? [],
      ormModels: parsed.ormModels ?? [],
      ormAssociations: parsed.ormAssociations ?? [],
      rnScreens: parsed.rnScreens ?? [],
      frameworkExtracts,
    };
  }

  /** Collect framework plugin results without persisting to DB. */
  private async collectFrameworkExtracts(
    relPath: string,
    content: Buffer,
    language: string,
  ): Promise<FileParseResult[]> {
    const ctx = this.buildProjectContext();
    const activeResult = this.registry.getActiveFrameworkPlugins(ctx);
    if (activeResult.isErr()) return [];

    const results: FileParseResult[] = [];
    for (const plugin of activeResult.value) {
      // Skip plugins without extractNodes — avoids the async overhead entirely
      if (!plugin.extractNodes) continue;

      const result = await executeFrameworkExtractNodes(plugin, relPath, content, language);
      if (result.isErr() || !result.value) continue;
      results.push(result.value);
    }
    return results;
  }

  /**
   * Persist phase: write a batch of extractions to DB in a single transaction.
   * Reduces SQLite journal syncs from N to 1 per batch.
   */
  private persistBatch(extractions: FileExtraction[]): void {
    this.store.db.transaction(() => {
      for (const ext of extractions) {
        this.persistExtraction(ext);
      }
    })();
  }

  /** Write a single file extraction to DB (must be called inside a transaction). */
  private persistExtraction(ext: FileExtraction): void {
    // Upsert file record
    let fileId: number;
    if (ext.existingId != null) {
      fileId = ext.existingId;

      // Fast path: if symbols are structurally identical (same symbolIds, names,
      // kinds, signatures), only update byte positions + complexity metrics.
      // This avoids the expensive delete+reinsert cycle and FTS5 trigger churn.
      if (this.tryFastSymbolUpdate(fileId, ext)) {
        this._changedFileIds.add(fileId);
        this.store.updateFileHash(fileId, ext.hash, ext.contentSize);
        if (ext.gitignored) this.store.updateFileGitignored(fileId, true);
        if (ext.importEdges.length > 0) {
          this._pendingImports.set(fileId, ext.importEdges);
        }
        return;
      }

      // Full reindex path
      this._changedFileIds.add(fileId);
      deleteTrigramsByFile(this.store.db, fileId);
      this.store.deleteSymbolsByFile(fileId);
      // Incremental: only delete outgoing edges — incoming edges from other files
      // stay intact (e.g. imports from A→B survive when B is re-indexed).
      if (this._isIncremental) {
        this.store.deleteOutgoingEdgesForFileNodes(fileId);
      } else {
        this.store.deleteEdgesForFileNodes(fileId);
      }
      this.store.deleteEntitiesByFile(fileId);
      this.store.updateFileHash(fileId, ext.hash, ext.contentSize);
      this.store.updateFileStatus(fileId, ext.status, ext.frameworkRole);
      if (ext.workspace) this.store.updateFileWorkspace(fileId, ext.workspace);
    } else {
      fileId = this.store.insertFile(ext.relPath, ext.language, ext.hash, ext.contentSize, ext.workspace);
      this._changedFileIds.add(fileId);
      if (ext.status !== 'ok' || ext.frameworkRole) {
        this.store.updateFileStatus(fileId, ext.status, ext.frameworkRole);
      }
    }

    // Flag gitignored files — indexed for graph metadata, content not served to AI
    if (ext.gitignored) {
      this.store.updateFileGitignored(fileId, true);
    }

    // Insert symbols + trigrams
    if (ext.symbols.length > 0) {
      const insertedIds = this.store.insertSymbols(fileId, ext.symbols);
      // Populate trigram index for fuzzy search (batch, no N+1)
      const trigramBatch = ext.symbols.map((sym, i) => ({
        id: insertedIds[i],
        name: sym.name,
        fqn: sym.fqn ?? null,
      }));
      indexTrigramsBatch(this.store.db, trigramBatch);
    }

    // Insert edges from language plugin
    if (ext.otherEdges.length > 0) this.storeRawEdges(ext.otherEdges);
    if (ext.importEdges.length > 0) {
      this._pendingImports.set(fileId, ext.importEdges);
    }

    // Insert routes, components, migrations, ORM models
    for (const r of ext.routes) this.store.insertRoute(r, fileId);
    for (const c of ext.components) this.store.insertComponent(c, fileId);
    for (const m of ext.migrations) this.store.insertMigration(m, fileId);
    if (ext.ormModels.length > 0) {
      this.storeOrmResults(ext.ormModels, ext.ormAssociations, fileId);
    }
    for (const s of ext.rnScreens) this.store.insertRnScreen(s, fileId);

    // Persist framework extract results
    for (const fwResult of ext.frameworkExtracts) {
      if (fwResult.symbols.length > 0) {
        const fwIds = this.store.insertSymbols(fileId, fwResult.symbols);
        indexTrigramsBatch(this.store.db, fwResult.symbols.map((sym, i) => ({
          id: fwIds[i],
          name: sym.name,
          fqn: sym.fqn ?? null,
        })));
      }
      if (fwResult.edges?.length) {
        this.storeRawEdges(fwResult.edges);
      }
      for (const r of fwResult.routes ?? []) this.store.insertRoute(r, fileId);
      for (const c of fwResult.components ?? []) this.store.insertComponent(c, fileId);
      for (const m of fwResult.migrations ?? []) this.store.insertMigration(m, fileId);
      if (fwResult.ormModels?.length) {
        this.storeOrmResults(fwResult.ormModels, fwResult.ormAssociations ?? [], fileId);
      }
      for (const s of fwResult.rnScreens ?? []) this.store.insertRnScreen(s, fileId);
      if (fwResult.frameworkRole) {
        this.store.updateFileStatus(fileId, fwResult.status, fwResult.frameworkRole);
      }
    }
  }

  /**
   * Fast path for incremental re-indexing: if the set of symbols is structurally
   * identical (same symbolIds, names, kinds, fqns, signatures), only update byte
   * positions and complexity metrics via UPDATE — avoids the expensive
   * delete+reinsert cycle and FTS5 trigger churn (2 FTS ops per symbol saved).
   *
   * Returns true if the fast path was taken.
   */
  private tryFastSymbolUpdate(fileId: number, ext: FileExtraction): boolean {
    // Only viable when there are no framework-injected symbols, edges, or entities
    // that would also need to be diffed.
    if (ext.frameworkExtracts.some((fw) =>
      fw.symbols.length > 0
      || (fw.edges?.length ?? 0) > 0
      || (fw.routes?.length ?? 0) > 0
      || (fw.components?.length ?? 0) > 0
      || (fw.migrations?.length ?? 0) > 0
      || (fw.ormModels?.length ?? 0) > 0
      || (fw.rnScreens?.length ?? 0) > 0
    )) return false;

    // Also skip fast path if language plugin produced entities (routes, components, etc.)
    if (ext.routes.length > 0 || ext.components.length > 0 || ext.migrations.length > 0
      || ext.ormModels.length > 0 || ext.rnScreens.length > 0) return false;

    const existing = this.store.getSymbolsByFile(fileId);
    if (existing.length !== ext.symbols.length) return false;
    if (existing.length === 0) return false;

    // Build symbolId → existing row map
    const existingMap = new Map<string, { id: number; name: string; kind: string; fqn: string | null; signature: string | null }>();
    for (const s of existing) {
      existingMap.set(s.symbol_id, { id: s.id, name: s.name, kind: s.kind, fqn: s.fqn, signature: s.signature });
    }

    // Verify all new symbols match an existing symbol structurally
    for (const sym of ext.symbols) {
      const ex = existingMap.get(sym.symbolId);
      if (!ex) return false;
      if (ex.name !== sym.name || ex.kind !== sym.kind) return false;
      if ((ex.fqn ?? null) !== (sym.fqn ?? null)) return false;
      if ((ex.signature ?? null) !== (sym.signature ?? null)) return false;
    }

    // All match — bulk-update positions + complexity (no FTS triggers fire
    // because name, fqn, signature, summary are untouched).
    const updateStmt = this.store.db.prepare(
      `UPDATE symbols
         SET byte_start = ?, byte_end = ?, line_start = ?, line_end = ?,
             cyclomatic = ?, max_nesting = ?, param_count = ?, metadata = ?
       WHERE id = ?`,
    );

    for (const sym of ext.symbols) {
      const ex = existingMap.get(sym.symbolId)!;
      const cyclomatic = (sym.metadata as Record<string, unknown> | undefined)?.['cyclomatic'] as number | undefined ?? null;
      const maxNesting = (sym.metadata as Record<string, unknown> | undefined)?.['max_nesting'] as number | undefined ?? null;
      const paramCount = (sym.metadata as Record<string, unknown> | undefined)?.['param_count'] as number | undefined ?? null;
      updateStmt.run(
        sym.byteStart, sym.byteEnd,
        sym.lineStart ?? null, sym.lineEnd ?? null,
        cyclomatic, maxNesting, paramCount,
        sym.metadata ? JSON.stringify(sym.metadata) : null,
        ex.id,
      );
    }

    return true;
  }

  private storeOrmResults(
    models: RawOrmModel[],
    associations: RawOrmAssociation[],
    fileId: number,
  ): void {
    // Insert models first, collect name → id map
    const modelIdMap = new Map<string, number>();
    for (const m of models) {
      const id = this.store.insertOrmModel(m, fileId);
      modelIdMap.set(m.name, id);
    }

    // Insert associations — resolve target ID best-effort (may be null if not indexed yet)
    for (const assoc of associations) {
      const sourceId = modelIdMap.get(assoc.sourceModelName)
        ?? this.store.getOrmModelByName(assoc.sourceModelName)?.id;
      if (sourceId == null) continue;

      const targetId = modelIdMap.get(assoc.targetModelName)
        ?? this.store.getOrmModelByName(assoc.targetModelName)?.id
        ?? null;

      this.store.insertOrmAssociation(
        sourceId,
        targetId,
        assoc.targetModelName,
        assoc.kind,
        assoc.options,
        fileId,
      );
    }
  }

  private async resolveEdges(): Promise<void> {
    const ctx = this.buildProjectContext();
    const activeResult = this.registry.getActiveFrameworkPlugins(ctx);
    if (activeResult.isErr()) return;

    const resolveCtx = this.buildResolveContext();

    for (const plugin of activeResult.value) {
      const result = await executeFrameworkResolveEdges(plugin, resolveCtx);
      if (result.isErr()) continue;
      this.storeRawEdges(result.value);
    }
  }

  /** Convert ORM associations (orm_associations table) into graph edges. */
  private resolveOrmAssociationEdges(): void {
    let associations = this.store.getAllOrmAssociations();
    if (associations.length === 0) return;

    // Incremental: only resolve associations from changed files
    if (this._isIncremental && this._changedFileIds.size > 0) {
      associations = associations.filter((a) => a.file_id != null && this._changedFileIds.has(a.file_id));
      if (associations.length === 0) return;
    }

    // Build model ID → ORM type map
    const allModels = this.store.getAllOrmModels();
    const modelOrmMap = new Map<number, string>();
    for (const m of allModels) {
      modelOrmMap.set(m.id, m.orm);
    }

    // ORM-specific kind → edge type name mapping
    const ormKindToEdgeType: Record<string, Record<string, string>> = {
      mongoose: {
        ref: 'mongoose_references',
        discriminator: 'mongoose_discriminates',
      },
      sequelize: {
        hasMany: 'sequelize_has_many',
        belongsTo: 'sequelize_belongs_to',
        belongsToMany: 'sequelize_belongs_to_many',
        hasOne: 'sequelize_has_one',
      },
      typeorm: {
        OneToMany: 'typeorm_one_to_many',
        ManyToOne: 'typeorm_many_to_one',
        OneToOne: 'typeorm_one_to_one',
        ManyToMany: 'typeorm_many_to_many',
      },
      prisma: {
        hasMany: 'prisma_relation',
        belongsTo: 'prisma_relation',
      },
      drizzle: {
        hasMany: 'drizzle_relation',
        belongsTo: 'drizzle_relation',
      },
    };

    // Pre-load: model name → id map for unresolved target lookups
    const modelNameMap = new Map<string, number>();
    for (const m of allModels) modelNameMap.set(m.name, m.id);

    // Pre-load: all orm_model node IDs in one batch query
    const allModelIds = allModels.map((m) => m.id);
    const ormNodeMap = this.store.getNodeIdsBatch('orm_model', allModelIds);

    // Pre-load: edge type IDs for all ORM edge types we might need
    const edgeTypeCache = new Map<string, number>();
    const edgeTypeStmt = this.store.db.prepare('SELECT id FROM edge_types WHERE name = ?');

    const insertStmt = this.store.db.prepare(
      `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
       VALUES (?, ?, ?, 1, NULL, 0)`,
    );

    this.store.db.transaction(() => {
      for (const assoc of associations) {
        let targetModelId = assoc.target_model_id;
        if (targetModelId == null && assoc.target_model_name) {
          targetModelId = modelNameMap.get(assoc.target_model_name) ?? null;
        }
        if (targetModelId == null) continue;

        const sourceNodeId = ormNodeMap.get(assoc.source_model_id);
        const targetNodeId = ormNodeMap.get(targetModelId);
        if (sourceNodeId == null || targetNodeId == null) continue;

        const orm = modelOrmMap.get(assoc.source_model_id) ?? 'unknown';
        const ormMap = ormKindToEdgeType[orm];
        const edgeType = ormMap?.[assoc.kind] ?? `orm_${assoc.kind}`;

        let edgeTypeId = edgeTypeCache.get(edgeType);
        if (edgeTypeId == null) {
          const row = edgeTypeStmt.get(edgeType) as { id: number } | undefined;
          if (!row) continue;
          edgeTypeId = row.id;
          edgeTypeCache.set(edgeType, edgeTypeId);
        }

        insertStmt.run(sourceNodeId, targetNodeId, edgeTypeId);
      }
    })();
  }

  /**
   * Pass 2c: Resolve TypeScript extends/implements metadata into graph edges.
   * Builds a class/interface name → symbol DB id map, then creates
   * ts_extends and ts_implements edges for all symbols that have heritage metadata.
   */
  private resolveTypeScriptHeritageEdges(): void {
    let symbolsWithHeritage = this.store.getSymbolsWithHeritage();
    if (symbolsWithHeritage.length === 0) return;

    // Incremental: only resolve heritage for symbols in changed files
    if (this._isIncremental && this._changedFileIds.size > 0) {
      symbolsWithHeritage = symbolsWithHeritage.filter((s) => this._changedFileIds.has(s.file_id));
      if (symbolsWithHeritage.length === 0) return;
    }

    // Build name → {id, kind} index across ALL TypeScript symbols (classes + interfaces)
    const nameIndex = new Map<string, { id: number; kind: string }[]>();
    const allSymbols = this.store.db.prepare(
      "SELECT id, name, kind FROM symbols WHERE kind IN ('class', 'interface')",
    ).all() as { id: number; name: string; kind: string }[];

    for (const s of allSymbols) {
      const list = nameIndex.get(s.name) ?? [];
      list.push({ id: s.id, kind: s.kind });
      nameIndex.set(s.name, list);
    }

    // Pre-load symbol node IDs — chunked to avoid SQLite variable limit
    const allNeededIds = [...new Set([
      ...allSymbols.map((s) => s.id),
      ...symbolsWithHeritage.map((s) => s.id),
    ])];
    const symbolNodeMap = new Map<number, number>();
    const CHUNK = 500;
    for (let i = 0; i < allNeededIds.length; i += CHUNK) {
      for (const [k, v] of this.store.getNodeIdsBatch('symbol', allNeededIds.slice(i, i + CHUNK))) {
        symbolNodeMap.set(k, v);
      }
    }

    // Pre-load edge type IDs
    const tsExtendsType = this.store.db.prepare('SELECT id FROM edge_types WHERE name = ?').get('ts_extends') as { id: number } | undefined;
    const tsImplementsType = this.store.db.prepare('SELECT id FROM edge_types WHERE name = ?').get('ts_implements') as { id: number } | undefined;
    if (!tsExtendsType || !tsImplementsType) return;

    let created = 0;
    const insertStmt = this.store.db.prepare(
      `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
       VALUES (?, ?, ?, 1, NULL, 0)`,
    );

    this.store.db.transaction(() => {
      for (const sym of symbolsWithHeritage) {
        let meta: Record<string, unknown> = {};
        try { if (sym.metadata) meta = JSON.parse(sym.metadata) as Record<string, unknown>; } catch { continue; }
        const sourceNodeId = symbolNodeMap.get(sym.id);
        if (sourceNodeId == null) continue;

        // Process extends
        const ext = meta['extends'];
        const extNames = Array.isArray(ext) ? ext as string[] : typeof ext === 'string' ? [ext] : [];
        for (const targetName of extNames) {
          const targets = nameIndex.get(targetName);
          if (!targets?.length) continue;
          const targetNodeId = symbolNodeMap.get(targets[0].id);
          if (targetNodeId == null) continue;
          insertStmt.run(sourceNodeId, targetNodeId, tsExtendsType.id);
          created++;
        }

        // Process implements
        const impl = meta['implements'];
        if (Array.isArray(impl)) {
          for (const targetName of impl as string[]) {
            const targets = nameIndex.get(targetName);
            if (!targets?.length) continue;
            const target = targets.find((t) => t.kind === 'interface') ?? targets[0];
            const targetNodeId = symbolNodeMap.get(target.id);
            if (targetNodeId == null) continue;
            insertStmt.run(sourceNodeId, targetNodeId, tsImplementsType.id);
            created++;
          }
        }
      }
    })();

    if (created > 0) {
      logger.info({ edges: created }, 'TypeScript heritage edges resolved');
    }
  }

  /**
   * Pass 2d: Resolve ES module import specifiers to file→file graph edges.
   * Uses the pending imports collected during Pass 1 + the EsModuleResolver.
   */
  private resolveEsmImportEdges(): void {
    if (this._pendingImports.size === 0) return;

    let resolver: EsModuleResolver;
    try {
      const tsconfigPath = fs.existsSync(path.join(this.rootPath, 'tsconfig.json'))
        ? path.join(this.rootPath, 'tsconfig.json')
        : undefined;
      resolver = new EsModuleResolver(this.rootPath, tsconfigPath);
    } catch {
      logger.warn('EsModuleResolver init failed — skipping import edge resolution');
      return;
    }

    let created = 0;

    // Pre-build lookup maps for source files only (not ALL files)
    const pendingFileIds = Array.from(this._pendingImports.keys());
    const fileMap = this.store.getFilesByIds(pendingFileIds);
    const fileNodeMap = this.store.getNodeIdsBatch('file', pendingFileIds);

    // Lazy cache for resolved target paths — avoids loading ALL files into memory.
    // On a 100K-file project, this saves ~50 MB of heap and thousands of Map insertions.
    const targetFileCache = new Map<string, { id: number; nodeId: number } | null>();

    const resolveTargetFile = (relPath: string): { id: number; nodeId: number } | null => {
      const cached = targetFileCache.get(relPath);
      if (cached !== undefined) return cached;
      const f = this.store.getFile(relPath);
      if (!f) { targetFileCache.set(relPath, null); return null; }
      const nodeId = this.store.getNodeId('file', f.id);
      if (nodeId == null) { targetFileCache.set(relPath, null); return null; }
      const entry = { id: f.id, nodeId };
      targetFileCache.set(relPath, entry);
      return entry;
    };

    // Pre-resolve imports edge type
    const importsEdgeType = this.store.db.prepare('SELECT id FROM edge_types WHERE name = ?').get('imports') as { id: number } | undefined;
    if (!importsEdgeType) return;

    const insertStmt = this.store.db.prepare(
      `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
       VALUES (?, ?, ?, 1, ?, 0)`,
    );

    this.store.db.transaction(() => {
      for (const [fileId, imports] of this._pendingImports) {
        const file = fileMap.get(fileId);
        if (!file) continue;

        const absSource = path.resolve(this.rootPath, file.path);
        const sourceNodeId = fileNodeMap.get(fileId);
        if (sourceNodeId == null) continue;

        // Consolidate imports from the same module so specifiers don't get lost
        // by INSERT OR IGNORE when multiple import statements target the same file
        const consolidated = new Map<string, string[]>();
        for (const { from, specifiers } of imports) {
          const existing = consolidated.get(from);
          if (existing) {
            existing.push(...specifiers);
          } else {
            consolidated.set(from, [...specifiers]);
          }
        }

        for (const [from, specifiers] of consolidated) {
          // Skip bare specifiers (node_modules) — only resolve project-local imports
          if (!from.startsWith('.') && !from.startsWith('/') && !from.startsWith('@/') && !from.startsWith('~')) continue;

          const resolved = resolver.resolve(from, absSource);
          if (!resolved) continue;

          const relTarget = path.relative(this.rootPath, resolved);
          const target = resolveTargetFile(relTarget);
          if (!target) continue;

          insertStmt.run(
            sourceNodeId,
            target.nodeId,
            importsEdgeType.id,
            JSON.stringify({ from, specifiers }),
          );
          created++;
        }
      }
    })();

    if (created > 0) {
      logger.info({ edges: created }, 'ES module import edges resolved');
    }
  }

  private static readonly TEST_PATH_RE = /\.(test|spec)\.[jt]sx?$|__tests__\//;

  /**
   * Pass 2e: Create test_covers edges.
   * For each test file, examine its outgoing `imports` edges.
   * If the imported file is NOT a test file, create a `test_covers` edge:
   *   test_file →[test_covers]→ source_file
   */
  private resolveTestCoversEdges(): void {
    const allFiles = this.store.getAllFiles();
    let testFiles = allFiles.filter((f) => IndexingPipeline.TEST_PATH_RE.test(f.path));
    if (testFiles.length === 0) return;

    // Incremental: only process test files that were re-indexed
    if (this._isIncremental && this._changedFileIds.size > 0) {
      testFiles = testFiles.filter((f) => this._changedFileIds.has(f.id));
      if (testFiles.length === 0) return;
    }

    // Pre-load file node IDs — in incremental mode, only load for test files + targets
    // instead of all files (avoids O(allFiles) query when only 1 test changed).
    const testFileIds = testFiles.map((f) => f.id);
    const fileNodeMap = this._isIncremental
      ? this.store.getNodeIdsBatch('file', testFileIds)
      : this.store.getNodeIdsBatch('file', allFiles.map((f) => f.id));

    // Collect all test file node IDs
    const testNodeIds: number[] = [];
    const testNodeToFile = new Map<number, typeof testFiles[0]>();
    for (const tf of testFiles) {
      const nodeId = fileNodeMap.get(tf.id);
      if (nodeId != null) {
        testNodeIds.push(nodeId);
        testNodeToFile.set(nodeId, tf);
      }
    }
    if (testNodeIds.length === 0) return;

    // Batch-fetch all edges for test file nodes
    const allEdges = this.store.getEdgesForNodesBatch(testNodeIds);

    // Build file path set for fast test-file check — use full test set, not just changed
    const testPathSet = new Set(allFiles
      .filter((f) => IndexingPipeline.TEST_PATH_RE.test(f.path))
      .map((f) => f.path));

    // Pre-load all target node refs in one batch
    const targetNodeIds = [...new Set(allEdges.map((e) => e.target_node_id))];
    const targetRefs = this.store.getNodeRefsBatch(targetNodeIds);

    // Pre-load file rows for all target file refs
    const targetFileRefIds = [...targetRefs.values()]
      .filter((r) => r.nodeType === 'file')
      .map((r) => r.refId);
    const targetFileMap = this.store.getFilesByIds(targetFileRefIds);

    // Resolve test_covers edge type
    const testCoversType = this.store.db.prepare('SELECT id FROM edge_types WHERE name = ?').get('test_covers') as { id: number } | undefined;
    if (!testCoversType) return;

    let created = 0;
    const insertStmt = this.store.db.prepare(
      `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
       VALUES (?, ?, ?, 1, ?, 0)`,
    );

    this.store.db.transaction(() => {
      for (const edge of allEdges) {
        if (edge.edge_type_name !== 'imports') continue;
        // Only outgoing edges from test files
        if (!testNodeToFile.has(edge.source_node_id)) continue;

        const targetRef = targetRefs.get(edge.target_node_id);
        if (!targetRef || targetRef.nodeType !== 'file') continue;

        const targetFile = targetFileMap.get(targetRef.refId);
        if (!targetFile) continue;
        if (testPathSet.has(targetFile.path)) continue;

        const testFile = testNodeToFile.get(edge.source_node_id)!;
        insertStmt.run(
          edge.source_node_id,
          edge.target_node_id,
          testCoversType.id,
          JSON.stringify({ test_file: testFile.path }),
        );
        created++;
      }
    })();

    if (created > 0) {
      logger.info({ edges: created }, 'test_covers edges resolved');
    }
  }

  private storeRawEdges(edges: RawEdge[]): void {
    if (edges.length === 0) return;

    // ── Pre-load all caches to eliminate per-edge SELECTs ──

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
      const rows = this.store.db.prepare(
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
    const typeRefCache = new Map<string, number>(); // "type:refId" → nodeId
    for (const [nodeType, refIds] of refIdsByType) {
      const batch = this.store.getNodeIdsBatch(nodeType, Array.from(refIds));
      for (const [refId, nodeId] of batch) {
        typeRefCache.set(`${nodeType}:${refId}`, nodeId);
      }
    }

    // 3. edgeTypeName → edgeTypeId (avoids per-edge SELECT in insertEdge)
    const edgeTypeNames = new Set<string>();
    for (const edge of edges) edgeTypeNames.add(edge.edgeType);
    const edgeTypeCache = new Map<string, number>();
    for (const name of edgeTypeNames) {
      const row = this.store.db.prepare('SELECT id FROM edge_types WHERE name = ?').get(name) as { id: number } | undefined;
      if (row) edgeTypeCache.set(name, row.id);
    }

    // 4. Pre-load workspace info for all node IDs to avoid per-edge DB lookups.
    // Without this, isEdgeCrossWorkspace does 4-6 DB calls per edge.
    const nodeWorkspaceCache = new Map<number, string | null>();
    if (this.workspaces.length > 0) {
      // Collect all node IDs that will participate in edges
      const allNodeIds = new Set<number>();
      for (const edge of edges) {
        const src = this.resolveNodeId(edge, symbolNodeCache, typeRefCache);
        if (src != null) allNodeIds.add(src);
        const tgt = this.resolveTargetNodeId(edge, symbolNodeCache, typeRefCache);
        if (tgt != null) allNodeIds.add(tgt);
      }

      if (allNodeIds.size > 0) {
        const nodeIdArr = Array.from(allNodeIds);
        const ph = nodeIdArr.map(() => '?').join(',');
        // Single query: node → file → workspace (covers both file and symbol nodes)
        const rows = this.store.db.prepare(`
          SELECT n.id AS node_id, f.workspace
          FROM nodes n
          LEFT JOIN files f ON (n.node_type = 'file' AND n.ref_id = f.id)
            OR (n.node_type = 'symbol' AND f.id = (SELECT file_id FROM symbols WHERE id = n.ref_id))
          WHERE n.id IN (${ph})
        `).all(...nodeIdArr) as Array<{ node_id: number; workspace: string | null }>;
        for (const row of rows) nodeWorkspaceCache.set(row.node_id, row.workspace);
      }
    }

    // ── Batch all inserts in a single transaction with a prepared statement ──
    const insertStmt = this.store.db.prepare(
      `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const insertBatch = this.store.db.transaction(() => {
      for (const edge of edges) {
        const sourceNodeId = this.resolveNodeId(edge, symbolNodeCache, typeRefCache);
        if (sourceNodeId == null) continue;
        const targetNodeId = this.resolveTargetNodeId(edge, symbolNodeCache, typeRefCache) ?? sourceNodeId;

        const edgeTypeId = edgeTypeCache.get(edge.edgeType);
        if (edgeTypeId == null) continue;

        // O(1) workspace check via pre-loaded cache instead of 4-6 DB queries per edge
        let isCrossWs = false;
        if (this.workspaces.length > 0) {
          const srcWs = nodeWorkspaceCache.get(sourceNodeId);
          const tgtWs = nodeWorkspaceCache.get(targetNodeId);
          isCrossWs = srcWs != null && tgtWs != null && srcWs !== tgtWs;
        }

        insertStmt.run(
          sourceNodeId,
          targetNodeId,
          edgeTypeId,
          (edge.resolved ?? true) ? 1 : 0,
          edge.metadata ? JSON.stringify(edge.metadata) : null,
          isCrossWs ? 1 : 0,
        );
      }
    });
    insertBatch();
  }

  private resolveNodeId(
    edge: RawEdge,
    symbolNodeCache: Map<string, number>,
    typeRefCache: Map<string, number>,
  ): number | undefined {
    if (edge.sourceNodeType && edge.sourceRefId != null) {
      return typeRefCache.get(`${edge.sourceNodeType}:${edge.sourceRefId}`)
        ?? this.store.getNodeId(edge.sourceNodeType, edge.sourceRefId);
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
        ?? this.store.getNodeId(edge.targetNodeType, edge.targetRefId);
    }
    if (edge.targetSymbolId) {
      return symbolNodeCache.get(edge.targetSymbolId);
    }
    return undefined;
  }

  private buildProjectContext() {
    if (!this._projectContext) {
      this._projectContext = this._buildProjectContext();
    }
    return this._projectContext;
  }

  private _buildProjectContext(): ProjectContext {
    return buildProjectContext(this.rootPath);
  }

  private registerFrameworkEdgeTypes(): void {
    const ctx = this.buildProjectContext();
    const activeResult = this.registry.getActiveFrameworkPlugins(ctx);
    if (activeResult.isErr()) return;

    for (const plugin of activeResult.value) {
      const schema = plugin.registerSchema();
      if (schema.edgeTypes) {
        for (const et of schema.edgeTypes) {
          this.store.ensureEdgeType(et.name, et.category, et.description ?? '');
        }
      }
    }
  }

  private buildResolveContext(): ResolveContext {
    const store = this.store;
    return {
      rootPath: this.rootPath,
      getAllFiles: () => store.getAllFiles().map((f) => ({
        id: f.id,
        path: f.path,
        language: f.language,
      })),
      getSymbolsByFile: (fileId: number) =>
        store.getSymbolsByFile(fileId).map((s) => ({
          id: s.id,
          symbolId: s.symbol_id,
          name: s.name,
          kind: s.kind,
          fqn: s.fqn,
          lineStart: s.line_start,
          lineEnd: s.line_end,
          metadata: s.metadata ? JSON.parse(s.metadata) as Record<string, unknown> : null,
        })),
      getSymbolByFqn: (fqn: string) => {
        const s = store.getSymbolByFqn(fqn);
        return s ? { id: s.id, symbolId: s.symbol_id } : undefined;
      },
      getNodeId: (nodeType: string, refId: number) => store.getNodeId(nodeType, refId),
      createNodeIfNeeded: (nodeType: string, refId: number) => store.createNode(nodeType, refId),
      readFile: (relPath: string) => {
        // Use Pass 1 cache first, fall back to disk
        const cached = this._fileContentCache.get(relPath);
        if (cached !== undefined) return cached;
        try {
          return fs.readFileSync(path.resolve(this.rootPath, relPath), 'utf-8');
        } catch { return undefined; }
      },
    };
  }

  private resolveWorkspace(relPath: string): string | null {
    for (const ws of this.workspaces) {
      if (relPath.startsWith(ws.path + '/') || relPath === ws.path) {
        return ws.name;
      }
    }
    return null;
  }

  private isEdgeCrossWorkspace(sourceNodeId: number, targetNodeId: number): boolean {
    if (this.workspaces.length === 0) return false;

    const sourceWs = this.getWorkspaceForNode(sourceNodeId);
    const targetWs = this.getWorkspaceForNode(targetNodeId);

    if (sourceWs == null || targetWs == null) return false;
    return sourceWs !== targetWs;
  }

  private getWorkspaceForNode(nodeId: number): string | null {
    const ref = this.store.getNodeRef(nodeId);
    if (!ref) return null;

    if (ref.nodeType === 'file') {
      const file = this.store.getFileById(ref.refId);
      return file?.workspace ?? null;
    }
    if (ref.nodeType === 'symbol') {
      const sym = this.store.getSymbolById(ref.refId);
      if (!sym) return null;
      const file = this.store.getFileById(sym.file_id);
      return file?.workspace ?? null;
    }
    return null;
  }

  private static readonly DEFAULT_MAX_FILES = 10_000;

  private async collectFiles(): Promise<string[]> {
    const entries = await fg(this.config.include, {
      cwd: this.rootPath,
      ignore: this.config.exclude,
      dot: false,
      absolute: false,
      onlyFiles: true,
    });

    const maxFiles = this.config.security?.max_files ?? IndexingPipeline.DEFAULT_MAX_FILES;
    if (entries.length > maxFiles) {
      logger.warn(
        { found: entries.length, limit: maxFiles },
        'File count exceeds limit — truncating. Increase security.max_files to index more.',
      );
      return entries.slice(0, maxFiles);
    }

    return entries;
  }

  // ─── .env file indexing ───────────────────────────────────────────

  private static readonly ENV_GLOB = ['.env', '.env.*', '.env.local', '**/.env', '**/.env.*'];

  private async indexEnvFiles(force: boolean): Promise<void> {
    const envPaths = await fg(IndexingPipeline.ENV_GLOB, {
      cwd: this.rootPath,
      ignore: this.config.exclude,
      dot: true,
      absolute: false,
      onlyFiles: true,
    });

    if (envPaths.length === 0) return;

    logger.info({ count: envPaths.length }, 'Indexing .env files (keys only)');

    for (const relPath of envPaths) {
      const absPath = path.resolve(this.rootPath, relPath);

      // Defence-in-depth
      const pathCheck = validatePath(relPath, this.rootPath);
      if (pathCheck.isErr()) continue;

      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        logger.warn({ file: relPath }, 'Cannot read .env file');
        continue;
      }

      const hash = hashContent(Buffer.from(content));
      const existing = this.store.getFile(relPath);

      if (!force && existing && existing.content_hash === hash) continue;

      const entries = parseEnvFile(content);

      // Upsert file record (language = 'env', framework_role = 'config')
      let fileId: number;
      if (existing) {
        fileId = existing.id;
        this.store.deleteEnvVarsByFile(fileId);
        this.store.updateFileHash(fileId, hash, content.length);
      } else {
        fileId = this.store.insertFile(relPath, 'env', hash, content.length);
        this.store.updateFileStatus(fileId, 'ok', 'config');
      }

      for (const entry of entries) {
        this.store.insertEnvVar(fileId, {
          key: entry.key,
          valueType: entry.valueType,
          valueFormat: entry.valueFormat,
          comment: entry.comment,
          quoted: entry.quoted,
          line: entry.line,
        });
      }

      logger.debug({ file: relPath, keys: entries.length }, '.env file indexed');
    }
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).slice(1);
    const map: Record<string, string> = {
      php: 'php',
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      mjs: 'javascript',
      mts: 'typescript',
      vue: 'vue',
    };
    return map[ext] ?? ext;
  }
}
