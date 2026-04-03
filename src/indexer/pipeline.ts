import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { TraceMcpConfig } from '../config.js';
import type { ResolveContext, RawEdge } from '../plugin-api/types.js';
import { executeLanguagePlugin, executeFrameworkExtractNodes, executeFrameworkResolveEdges } from '../plugin-api/executor.js';
import { hashContent } from '../utils/hasher.js';
import { logger } from '../logger.js';
import { detectWorkspaces, type WorkspaceInfo } from './monorepo.js';

export interface IndexingResult {
  totalFiles: number;
  indexed: number;
  skipped: number;
  errors: number;
  durationMs: number;
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

  async indexAll(force?: boolean): Promise<IndexingResult> {
    const result = this._lock.then(async () => {
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

  async indexFiles(filePaths: string[]): Promise<IndexingResult> {
    const result = this._lock.then(async () => {
      const start = Date.now();
      const relPaths = filePaths.map((fp) =>
        path.isAbsolute(fp) ? path.relative(this.rootPath, fp) : fp,
      );
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

    // Register edge types from framework plugins
    this.registerFrameworkEdgeTypes();

    // Pass 1: per-file extraction
    for (const relPath of relPaths) {
      const ok = await this.indexSingleFile(relPath, force);
      if (ok === 'indexed') result.indexed++;
      else if (ok === 'skipped') result.skipped++;
      else result.errors++;
    }

    // Pass 2: resolve edges (framework plugins)
    await this.resolveEdges();

    // Pass 2b: ORM associations → graph edges (resolved after all entities indexed)
    this.resolveOrmAssociationEdges();

    result.durationMs = Date.now() - startMs;
    logger.info(result, 'Indexing pipeline completed');
    return result;
  }

  private async indexSingleFile(
    relPath: string,
    force: boolean,
  ): Promise<'indexed' | 'skipped' | 'error'> {
    const absPath = path.resolve(this.rootPath, relPath);

    let content: Buffer;
    try {
      content = fs.readFileSync(absPath);
    } catch {
      logger.warn({ file: relPath }, 'Cannot read file');
      return 'error';
    }

    // Cache content for Pass 2 (resolveEdges reads files again)
    this._fileContentCache.set(relPath, content.toString('utf-8'));

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

    // Determine workspace for this file
    const workspace = this.resolveWorkspace(relPath);

    // Upsert file record
    let fileId: number;
    if (existing) {
      fileId = existing.id;
      this.store.deleteSymbolsByFile(fileId);
      this.store.deleteEdgesForFileNodes(fileId);
      this.store.updateFileHash(fileId, hash, content.length);
      this.store.updateFileStatus(fileId, parsed.status, parsed.frameworkRole);
      if (workspace) this.store.updateFileWorkspace(fileId, workspace);
    } else {
      fileId = this.store.insertFile(relPath, language, hash, content.length, workspace);
      if (parsed.status !== 'ok' || parsed.frameworkRole) {
        this.store.updateFileStatus(fileId, parsed.status, parsed.frameworkRole);
      }
    }

    // Insert symbols
    if (parsed.symbols.length > 0) {
      this.store.insertSymbols(fileId, parsed.symbols);
    }

    // Insert edges from language plugin
    if (parsed.edges?.length) {
      this.storeRawEdges(parsed.edges);
    }

    // Insert routes, components, migrations, ORM models
    if (parsed.routes?.length) {
      for (const r of parsed.routes) this.store.insertRoute(r, fileId);
    }
    if (parsed.components?.length) {
      for (const c of parsed.components) this.store.insertComponent(c, fileId);
    }
    if (parsed.migrations?.length) {
      for (const m of parsed.migrations) this.store.insertMigration(m, fileId);
    }
    if (parsed.ormModels?.length) {
      this.storeOrmResults(parsed.ormModels, parsed.ormAssociations ?? [], fileId);
    }

    // Framework extractNodes (pass 1)
    await this.runFrameworkExtractNodes(relPath, content, language, fileId);

    return 'indexed';
  }

  private async runFrameworkExtractNodes(
    relPath: string,
    content: Buffer,
    language: string,
    fileId: number,
  ): Promise<void> {
    const ctx = this.buildProjectContext();
    const activeResult = this.registry.getActiveFrameworkPlugins(ctx);
    if (activeResult.isErr()) {
      logger.warn({ error: activeResult.error }, 'Failed to get active framework plugins');
      return;
    }

    for (const plugin of activeResult.value) {
      const result = await executeFrameworkExtractNodes(plugin, relPath, content, language);
      if (result.isErr() || !result.value) continue;

      const fwResult = result.value;
      if (fwResult.symbols.length > 0) {
        this.store.insertSymbols(fileId, fwResult.symbols);
      }
      if (fwResult.edges?.length) {
        this.storeRawEdges(fwResult.edges);
      }
      if (fwResult.routes?.length) {
        for (const r of fwResult.routes) this.store.insertRoute(r, fileId);
      }
      if (fwResult.components?.length) {
        for (const c of fwResult.components) this.store.insertComponent(c, fileId);
      }
      if (fwResult.migrations?.length) {
        for (const m of fwResult.migrations) this.store.insertMigration(m, fileId);
      }
      if (fwResult.ormModels?.length) {
        this.storeOrmResults(fwResult.ormModels, fwResult.ormAssociations ?? [], fileId);
      }
      if (fwResult.rnScreens?.length) {
        for (const s of fwResult.rnScreens) this.store.insertRnScreen(s, fileId);
      }
      if (fwResult.frameworkRole) {
        this.store.updateFileStatus(fileId, fwResult.status, fwResult.frameworkRole);
      }
    }
  }

  private storeOrmResults(
    models: import('../plugin-api/types.js').RawOrmModel[],
    associations: import('../plugin-api/types.js').RawOrmAssociation[],
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
    const associations = this.store.getAllOrmAssociations();
    if (associations.length === 0) return;

    // Map: ORM association kind → edge type name
    const kindToEdgeType: Record<string, string> = {
      // Mongoose
      ref: 'mongoose_references',
      discriminator: 'mongoose_discriminates',
      // Sequelize
      hasMany: 'sequelize_has_many',
      belongsTo: 'sequelize_belongs_to',
      belongsToMany: 'sequelize_belongs_to_many',
      hasOne: 'sequelize_has_one',
      // TypeORM
      OneToMany: 'typeorm_one_to_many',
      ManyToOne: 'typeorm_many_to_one',
      OneToOne: 'typeorm_one_to_one',
      ManyToMany: 'typeorm_many_to_many',
    };

    for (const assoc of associations) {
      // Resolve target model if it wasn't available during Pass 1
      let targetModelId = assoc.target_model_id;
      if (targetModelId == null && assoc.target_model_name) {
        const target = this.store.getOrmModelByName(assoc.target_model_name);
        if (target) targetModelId = target.id;
      }
      if (targetModelId == null) continue;

      const sourceNodeId = this.store.getNodeId('orm_model', assoc.source_model_id);
      const targetNodeId = this.store.getNodeId('orm_model', targetModelId);
      if (sourceNodeId == null || targetNodeId == null) continue;

      const edgeType = kindToEdgeType[assoc.kind] ?? `orm_${assoc.kind}`;
      const insertResult = this.store.insertEdge(sourceNodeId, targetNodeId, edgeType, true, undefined, false);
      if (insertResult.isErr()) {
        logger.warn({ edgeType, error: insertResult.error }, 'Failed to insert ORM edge');
      }
    }
  }

  private storeRawEdges(edges: RawEdge[]): void {
    for (const edge of edges) {
      const sourceNodeId = this.resolveNodeId(edge);
      const targetNodeId = this.resolveTargetNodeId(edge);
      if (sourceNodeId == null || targetNodeId == null) continue;

      const isCrossWs = this.isEdgeCrossWorkspace(sourceNodeId, targetNodeId);

      this.store.insertEdge(
        sourceNodeId,
        targetNodeId,
        edge.edgeType,
        edge.resolved ?? true,
        edge.metadata,
        isCrossWs,
      );
    }
  }

  private resolveNodeId(edge: RawEdge): number | undefined {
    if (edge.sourceNodeType && edge.sourceRefId != null) {
      return this.store.getNodeId(edge.sourceNodeType, edge.sourceRefId);
    }
    if (edge.sourceSymbolId) {
      const sym = this.store.getSymbolBySymbolId(edge.sourceSymbolId);
      if (sym) return this.store.getNodeId('symbol', sym.id);
    }
    return undefined;
  }

  private resolveTargetNodeId(edge: RawEdge): number | undefined {
    if (edge.targetNodeType && edge.targetRefId != null) {
      return this.store.getNodeId(edge.targetNodeType, edge.targetRefId);
    }
    if (edge.targetSymbolId) {
      const sym = this.store.getSymbolBySymbolId(edge.targetSymbolId);
      if (sym) return this.store.getNodeId('symbol', sym.id);
    }
    return undefined;
  }

  private buildProjectContext() {
    if (!this._projectContext) {
      this._projectContext = this._buildProjectContext();
    }
    return this._projectContext;
  }

  private _buildProjectContext() {
    let packageJson: Record<string, unknown> | undefined;
    try {
      const pkgPath = path.resolve(this.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      packageJson = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // No package.json found
    }

    let composerJson: Record<string, unknown> | undefined;
    try {
      const composerPath = path.resolve(this.rootPath, 'composer.json');
      const content = fs.readFileSync(composerPath, 'utf-8');
      composerJson = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // No composer.json found
    }

    let pyprojectToml: Record<string, unknown> | undefined;
    try {
      const tomlPath = path.resolve(this.rootPath, 'pyproject.toml');
      const content = fs.readFileSync(tomlPath, 'utf-8');
      // Lightweight TOML parse — extract [project] dependencies and [tool.poetry] dependencies
      const deps: string[] = [];
      const depBlockRe = /\[(?:project|tool\.poetry)\.?dependencies\]([^[]*)/g;
      let m: RegExpExecArray | null;
      while ((m = depBlockRe.exec(content)) !== null) {
        const block = m[1];
        for (const line of block.split('\n')) {
          const pkg = line.match(/^\s*([a-zA-Z0-9_-]+)/);
          if (pkg) deps.push(pkg[1].toLowerCase());
        }
      }
      // Also parse inline dependencies array: dependencies = ["fastapi>=0.100", ...]
      const inlineDeps = content.match(/dependencies\s*=\s*\[([^\]]*)\]/);
      if (inlineDeps) {
        const items = inlineDeps[1].matchAll(/["']([a-zA-Z0-9_-]+)[^"']*["']/g);
        for (const item of items) {
          deps.push(item[1].toLowerCase());
        }
      }
      pyprojectToml = { _parsedDeps: deps, _raw: content } as Record<string, unknown>;
    } catch {
      // No pyproject.toml found
    }

    let requirementsTxt: string[] | undefined;
    try {
      const reqPath = path.resolve(this.rootPath, 'requirements.txt');
      const content = fs.readFileSync(reqPath, 'utf-8');
      requirementsTxt = content
        .split('\n')
        .map((l) => l.replace(/#.*/, '').trim())
        .filter((l) => l && !l.startsWith('-'))
        .map((l) => l.split(/[>=<!\[;]/)[0].trim().toLowerCase());
    } catch {
      // No requirements.txt found
    }

    return {
      rootPath: this.rootPath,
      packageJson,
      composerJson,
      pyprojectToml,
      requirementsTxt,
      configFiles: [],
    };
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

  private async collectFiles(): Promise<string[]> {
    const entries = await fg(this.config.include, {
      cwd: this.rootPath,
      ignore: this.config.exclude,
      dot: false,
      absolute: false,
      onlyFiles: true,
    });
    return entries;
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
