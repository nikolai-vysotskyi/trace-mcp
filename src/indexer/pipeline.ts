import fs from 'node:fs';
import path from 'node:path';
import { cpus } from 'node:os';
import fg from 'fast-glob';
import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { TraceMcpConfig } from '../config.js';
import type { ResolveContext, ProjectContext } from '../plugin-api/types.js';
import { buildProjectContext } from './project-context.js';
import { logger } from '../logger.js';
import { detectWorkspaces, type WorkspaceInfo } from './monorepo.js';
import { validatePath } from '../utils/security.js';
import { GitignoreMatcher } from '../utils/gitignore.js';
import { TraceignoreMatcher } from '../utils/traceignore.js';
import { invalidatePageRankCache } from '../scoring/pagerank.js';
import { captureGraphSnapshots } from '../tools/analysis/history.js';
import { disableFts5Triggers, enableFts5Triggers } from '../db/schema.js';
import { FilePersister } from './file-persister.js';
import { EdgeResolver } from './edge-resolver.js';
import { FileExtractor } from './file-extractor.js';
import { EnvIndexer } from './env-indexer.js';
import type { PipelineState } from './pipeline-state.js';
export type { FileExtraction } from './pipeline-state.js';
import type { FileExtraction } from './pipeline-state.js';

export interface IndexingResult {
  totalFiles: number;
  indexed: number;
  skipped: number;
  errors: number;
  durationMs: number;
  incremental?: boolean;
}

export class IndexingPipeline {
  constructor(
    private store: Store,
    private registry: PluginRegistry,
    private config: TraceMcpConfig,
    private rootPath: string,
  ) {}

  private workspaces: WorkspaceInfo[] = [];
  private _lock: Promise<unknown> = Promise.resolve();
  private _projectContext: ProjectContext | undefined;
  private _fileContentCache = new Map<string, string>();
  private _pendingImports = new Map<number, { from: string; specifiers: string[]; relPath: string }[]>();
  private _gitignore: GitignoreMatcher | undefined;
  private _traceignore: TraceignoreMatcher | undefined;
  private _changedFileIds = new Set<number>();
  private _isIncremental = false;

  getPipelineState(): PipelineState {
    return {
      store: this.store,
      registry: this.registry,
      config: this.config,
      rootPath: this.rootPath,
      workspaces: this.workspaces,
      isIncremental: this._isIncremental,
      changedFileIds: this._changedFileIds,
      pendingImports: this._pendingImports,
      fileContentCache: this._fileContentCache,
      gitignore: this._gitignore,
    };
  }

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
      indexed: 0, skipped: 0, errors: 0, durationMs: 0,
    };

    this._projectContext = undefined;
    this.registry.clearCaches();
    this._changedFileIds.clear();
    this._gitignore = new GitignoreMatcher(this.rootPath);
    this._traceignore = new TraceignoreMatcher(this.rootPath, this.config.ignore);
    this.registerFrameworkEdgeTypes();

    const extractor = new FileExtractor({
      store: this.store,
      registry: this.registry,
      rootPath: this.rootPath,
      workspaces: this.workspaces,
      gitignore: this._gitignore,
      fileContentCache: this._fileContentCache,
      buildProjectContext: () => this.buildProjectContext(),
    });

    try {
      // Pass 1: extract + persist in batched transactions
      disableFts5Triggers(this.store.db);

      const BATCH_SIZE = Math.min(500, Math.max(100, Math.ceil(relPaths.length / 20)));
      const CONCURRENCY = Math.min(8, cpus().length);

      for (let i = 0; i < relPaths.length; i += BATCH_SIZE) {
        const batch = relPaths.slice(i, i + BATCH_SIZE);
        const extractions: FileExtraction[] = [];

        for (let c = 0; c < batch.length; c += CONCURRENCY) {
          const chunk = batch.slice(c, c + CONCURRENCY);
          const results = await Promise.all(
            chunk.map(relPath => extractor.extract(relPath, force)),
          );
          for (const ext of results) {
            if (ext === 'skipped') { result.skipped++; continue; }
            if (ext === 'error') { result.errors++; continue; }
            extractions.push(ext);
          }
        }

        if (extractions.length > 0) {
          const state = this.getPipelineState();
          const persistEdgeResolver = new EdgeResolver(state);
          const persister = new FilePersister(state, (edges) => persistEdgeResolver.storeRawEdges(edges));
          persister.persistBatch(extractions);
          result.indexed += extractions.length;
        }
      }

      enableFts5Triggers(this.store.db);

      // Pass 2: resolve edges
      const edgeResolver = new EdgeResolver(this.getPipelineState());
      await edgeResolver.resolveEdges(this.buildProjectContext(), this.buildResolveContext());
      edgeResolver.resolveOrmAssociationEdges();
      edgeResolver.resolveTypeScriptHeritageEdges();
      edgeResolver.resolveEsmImportEdges();
      edgeResolver.resolveTestCoversEdges();

      // Pass 3: Index .env files
      const envIndexer = new EnvIndexer(this.store, this.config, this.rootPath);
      await envIndexer.indexEnvFiles(force);
    } finally {
      this._fileContentCache.clear();
      this._pendingImports.clear();
      this._changedFileIds.clear();
      invalidatePageRankCache();
    }

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

  private buildProjectContext(): ProjectContext {
    if (!this._projectContext) {
      this._projectContext = buildProjectContext(this.rootPath);
    }
    return this._projectContext;
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
        id: f.id, path: f.path, language: f.language,
      })),
      getSymbolsByFile: (fileId: number) =>
        store.getSymbolsByFile(fileId).map((s) => ({
          id: s.id, symbolId: s.symbol_id, name: s.name, kind: s.kind,
          fqn: s.fqn, lineStart: s.line_start, lineEnd: s.line_end,
          metadata: s.metadata ? JSON.parse(s.metadata) as Record<string, unknown> : null,
        })),
      getSymbolByFqn: (fqn: string) => {
        const s = store.getSymbolByFqn(fqn);
        return s ? { id: s.id, symbolId: s.symbol_id } : undefined;
      },
      getNodeId: (nodeType: string, refId: number) => store.getNodeId(nodeType, refId),
      createNodeIfNeeded: (nodeType: string, refId: number) => store.createNode(nodeType, refId),
      readFile: (relPath: string) => {
        const cached = this._fileContentCache.get(relPath);
        if (cached !== undefined) return cached;
        try {
          return fs.readFileSync(path.resolve(this.rootPath, relPath), 'utf-8');
        } catch { return undefined; }
      },
    };
  }

  private static readonly DEFAULT_MAX_FILES = 10_000;

  private async collectFiles(): Promise<string[]> {
    const traceignoreIgnore = this._traceignore?.toFastGlobIgnore() ?? [];
    const ignore = [...this.config.exclude, ...traceignoreIgnore];

    let entries = await fg(this.config.include, {
      cwd: this.rootPath,
      ignore,
      dot: false,
      absolute: false,
      onlyFiles: true,
    });

    if (this._traceignore) {
      const ti = this._traceignore;
      entries = entries.filter((e) => !ti.isIgnored(e));
    }

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
}
