import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import fg from 'fast-glob';
import type { TraceMcpConfig } from '../config.js';
import { disableFts5Triggers, enableFts5Triggers } from '../db/schema.js';
import type { Store } from '../db/store.js';
import { logger } from '../logger.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { FrameworkPlugin, ProjectContext, ResolveContext } from '../plugin-api/types.js';
import { invalidatePageRankCache } from '../scoring/pagerank.js';
import { invalidateSearchCache } from '../scoring/search-cache.js';
import { captureGraphSnapshots } from '../tools/analysis/history.js';
import { safeGitEnv } from '../utils/git-env.js';
import { GitignoreMatcher } from '../utils/gitignore.js';
import { validatePath } from '../utils/security.js';
import { findPackageJsonEntries } from './package-entries.js';
import { TraceignoreMatcher } from '../utils/traceignore.js';
import { EdgeResolver } from './edge-resolver.js';
import { EnvIndexer } from './env-indexer.js';
import { ExtractPool, type ExtractRequest } from './extract-pool.js';
import { FileExtractor } from './file-extractor.js';
import { FilePersister } from './file-persister.js';
import { buildMultiRootWorkspaces, detectWorkspaces, type WorkspaceInfo } from './monorepo.js';
import type { PipelineState } from './pipeline-state.js';
import { buildProjectContext } from './project-context.js';

export type { FileExtraction } from './pipeline-state.js';

import type { ProgressState } from '../progress.js';
import type { FileExtraction } from './pipeline-state.js';

export interface IndexingResult {
  totalFiles: number;
  indexed: number;
  skipped: number;
  errors: number;
  durationMs: number;
  incremental?: boolean;
  /**
   * Set when a full reindex shrunk the symbol or edge count by more than
   * SHRINK_THRESHOLD. graphify v0.5.0 hit this same hazard: an `--update`
   * could silently overwrite a healthy graph with a degenerate one because
   * a parser regression caused half the files to fail. Fail loud, do not
   * fail silent — callers can re-run with `force=true` after investigating.
   */
  shrinkWarning?: {
    beforeSymbols: number;
    afterSymbols: number;
    beforeEdges: number;
    afterEdges: number;
    reason: string;
  };
}

/** A full rebuild that drops more than this fraction of symbols or edges
 * triggers a shrink warning. Tuned to catch real regressions without firing
 * on legitimate large refactors. */
const SHRINK_THRESHOLD = 0.5;
/** Below this absolute symbol count the shrink check is skipped — empty /
 * tiny indexes naturally fluctuate. */
const SHRINK_MIN_BASELINE = 200;

/**
 * Read the current git HEAD SHA for a repo. Returns null when the path isn't a
 * git working tree, when git isn't available, or when the call fails for any
 * other reason — callers must treat freshness checks as best-effort.
 */
function readGitHeadSha(rootPath: string): string | null {
  try {
    const out = execSync('git rev-parse HEAD', {
      cwd: rootPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      env: safeGitEnv(),
    });
    const sha = out.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export class IndexingPipeline {
  constructor(
    private store: Store,
    private registry: PluginRegistry,
    private config: TraceMcpConfig,
    private rootPath: string,
    private progress?: ProgressState,
  ) {}

  private workspaces: WorkspaceInfo[] = [];
  private _lock: Promise<unknown> = Promise.resolve();
  private _projectContext: ProjectContext | undefined;
  private _fileContentCache = new Map<string, string>();
  private _pendingImports = new Map<
    number,
    { from: string; specifiers: string[]; relPath: string }[]
  >();
  private _gitignore: GitignoreMatcher | undefined;
  private _traceignore: TraceignoreMatcher | undefined;
  private _changedFileIds = new Set<number>();
  private _isIncremental = false;
  private _extractPool: ExtractPool | undefined;

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
      // Snapshot the existing index size so runPipeline can detect a
      // catastrophic shrink (e.g. parser regression dropping half the files
      // silently). Skip when force=true — caller has acknowledged the risk.
      const before = force ? null : this.captureSizeSnapshot();
      if (this.config.children?.length) {
        this.workspaces = buildMultiRootWorkspaces(this.rootPath, this.config.children);
        logger.info({ workspaces: this.workspaces.map((w) => w.name) }, 'Multi-root workspaces');
      } else {
        this.workspaces = detectWorkspaces(this.rootPath);
        if (this.workspaces.length > 0) {
          logger.info({ workspaces: this.workspaces.map((w) => w.name) }, 'Detected workspaces');
        }
      }
      const filePaths = await this.collectFiles();
      const r = await this.runPipeline(filePaths, force ?? false, start);
      if (before) this.checkShrink(before, r);
      return r;
    });
    this._lock = result.catch(() => {});
    return result as Promise<IndexingResult>;
  }

  /** Snapshot the current symbol / edge count to compare against after a
   * full reindex. Returns null when the index is empty or below the baseline
   * threshold — at that size the shrink check is statistically meaningless. */
  private captureSizeSnapshot(): { symbols: number; edges: number } | null {
    try {
      const stats = this.store.getStats();
      if (stats.totalSymbols < SHRINK_MIN_BASELINE) return null;
      return { symbols: stats.totalSymbols, edges: stats.totalEdges };
    } catch {
      return null;
    }
  }

  /** Compare post-index counts to the pre-index snapshot and attach a warning
   * to the result if symbols or edges dropped by more than SHRINK_THRESHOLD.
   * The DB is not rolled back — graphify's approach is "warn loudly, let the
   * caller re-run with force"; ours is the same. */
  private checkShrink(before: { symbols: number; edges: number }, result: IndexingResult): void {
    try {
      const stats = this.store.getStats();
      const symbolRatio = stats.totalSymbols / before.symbols;
      const edgeRatio = before.edges > 0 ? stats.totalEdges / before.edges : 1;
      if (symbolRatio < 1 - SHRINK_THRESHOLD || edgeRatio < 1 - SHRINK_THRESHOLD) {
        const reason =
          symbolRatio < edgeRatio
            ? `symbols dropped from ${before.symbols} to ${stats.totalSymbols} (${Math.round(symbolRatio * 100)}%)`
            : `edges dropped from ${before.edges} to ${stats.totalEdges} (${Math.round(edgeRatio * 100)}%)`;
        result.shrinkWarning = {
          beforeSymbols: before.symbols,
          afterSymbols: stats.totalSymbols,
          beforeEdges: before.edges,
          afterEdges: stats.totalEdges,
          reason,
        };
        logger.warn(
          { before, after: stats, reason },
          'Indexing produced a much smaller graph — possible parser regression. Re-run with force=true after investigating.',
        );
      }
    } catch (e) {
      logger.debug({ error: e }, 'Shrink check skipped');
    }
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
      indexed: 0,
      skipped: 0,
      errors: 0,
      durationMs: 0,
    };

    this.progress?.update('indexing', {
      phase: 'running',
      processed: 0,
      total: relPaths.length,
      startedAt: Date.now(),
      completedAt: 0,
    });

    this._projectContext = undefined;
    this.registry.clearCaches();
    this._changedFileIds.clear();
    this._gitignore = new GitignoreMatcher(this.rootPath);
    this._traceignore = new TraceignoreMatcher(this.rootPath, this.config.ignore);
    this.registerFrameworkEdgeTypes();

    try {
      await this.extractAndPersist(relPaths, force, result);
      await this.resolveAllEdges();
      await this.runLspEnrichment();
      await this.indexEnvFiles(force);
    } finally {
      this._fileContentCache.clear();
      this._pendingImports.clear();
      this._changedFileIds.clear();
      invalidatePageRankCache();
      invalidateSearchCache();
    }

    if (!this._isIncremental && result.indexed > 0) {
      try {
        captureGraphSnapshots(this.store, this.rootPath);
      } catch (e) {
        logger.warn({ error: e }, 'Graph snapshot capture failed');
      }
    }

    // Capture git HEAD at index time so freshness checks can detect a stale snapshot.
    // Best-effort — non-git repos and missing git binary are silently ignored.
    try {
      const head = readGitHeadSha(this.rootPath);
      if (head) this.store.setRepoMetadata('index_head_sha', head);
      this.store.setRepoMetadata('indexed_at_ms', String(Date.now()));
    } catch {
      /* best-effort */
    }

    result.durationMs = Date.now() - startMs;
    result.incremental = this._isIncremental;

    this.progress?.update('indexing', {
      phase: 'completed',
      processed: result.indexed + result.skipped + result.errors,
      completedAt: Date.now(),
    });

    logger.info(result, 'Indexing pipeline completed');
    return result;
  }

  /** Pass 1: extract symbols from files and persist in batched transactions. */
  private async extractAndPersist(
    relPaths: string[],
    force: boolean,
    result: IndexingResult,
  ): Promise<void> {
    // Preload all existing file rows in one IN-query so per-file extract()
    // calls hit a Map instead of issuing a SELECT each.
    const existingFiles = this.store.getFilesByPaths(relPaths);

    // Force-include set: package.json#main/module/bin/exports must always be
    // indexed regardless of file-size cap. Without this, lodash-class
    // monolithic libraries (single-file UMD/IIFE declared as `main`) drop
    // out of the index and every published method looks dead.
    const forceIncludePaths = findPackageJsonEntries(this.rootPath);

    const extractor = new FileExtractor({
      store: this.store,
      registry: this.registry,
      rootPath: this.rootPath,
      workspaces: this.workspaces,
      gitignore: this._gitignore,
      fileContentCache: this._fileContentCache,
      buildProjectContext: () => this.buildProjectContext(),
      existingFiles,
      forceIncludePaths,
    });

    // FTS5 trigger disable+rebuild is only worth it on bulk indexing.
    // For small (incremental) batches the per-row trigger fire is cheaper than
    // rebuilding the entire FTS index from all symbols at the end.
    const useFtsRebuild = relPaths.length > IndexingPipeline.FTS_REBUILD_THRESHOLD;
    if (useFtsRebuild) disableFts5Triggers(this.store.db);

    const BATCH_SIZE = Math.min(500, Math.max(100, Math.ceil(relPaths.length / 20)));

    // Worker pool: only worth the spawn cost (~150-300 ms × N) for bigger
    // batches. Below the threshold or when unavailable (env disable, dev mode,
    // tests), we fall through to in-process extraction.
    const pool = this.maybeGetExtractPool(relPaths.length);
    const CONCURRENCY = pool ? pool.size : Math.min(8, cpus().length);

    // Single shared persister/resolver — no need to recreate per batch.
    const state = this.getPipelineState();
    const persistEdgeResolver = new EdgeResolver(state);
    const persister = new FilePersister(state, (edges) => persistEdgeResolver.storeRawEdges(edges));

    for (let i = 0; i < relPaths.length; i += BATCH_SIZE) {
      const batch = relPaths.slice(i, i + BATCH_SIZE);
      const extractions: FileExtraction[] = [];

      if (pool) {
        // Continuous dispatch: spawn `pool.size` consumers that each pull
        // from a shared queue. Keeps every worker fed without chunk barriers.
        const queue = batch.slice();
        await Promise.all(
          Array.from({ length: pool.size }, async () => {
            while (queue.length > 0) {
              const relPath = queue.shift();
              if (!relPath) return;
              const existing = existingFiles.get(relPath) ?? null;
              const gitignored = this._gitignore?.isIgnored(relPath) ?? false;
              const r = await pool.extract({
                relPath,
                rootPath: this.rootPath,
                force,
                existing,
                gitignored,
                workspaces: this.workspaces,
              } as ExtractRequest);
              if (r.kind === 'skipped') {
                result.skipped++;
                continue;
              }
              if (r.kind === 'error') {
                result.errors++;
                continue;
              }
              extractions.push(r.extraction);
            }
          }),
        );
      } else {
        for (let c = 0; c < batch.length; c += CONCURRENCY) {
          const chunk = batch.slice(c, c + CONCURRENCY);
          const results = await Promise.all(
            chunk.map((relPath) => extractor.extract(relPath, force)),
          );
          for (const ext of results) {
            if (ext === 'skipped') {
              result.skipped++;
              continue;
            }
            if (ext === 'error') {
              result.errors++;
              continue;
            }
            extractions.push(ext);
          }
        }
      }

      if (extractions.length > 0) {
        persister.persistBatch(extractions);
        result.indexed += extractions.length;
      }

      const processed = result.indexed + result.skipped + result.errors;
      this.progress?.update('indexing', { processed });
    }

    if (useFtsRebuild) enableFts5Triggers(this.store.db);
  }

  /** Pass 2: resolve all edge types (imports, heritage, ORM, tests). */
  private async resolveAllEdges(): Promise<void> {
    const edgeResolver = new EdgeResolver(this.getPipelineState());
    await edgeResolver.resolveEdges(this.buildProjectContext(), this.buildResolveContext());
    edgeResolver.resolveOrmAssociationEdges();
    edgeResolver.resolveTypeScriptHeritageEdges();
    edgeResolver.resolveEsmImportEdges();
    edgeResolver.resolvePythonImportEdges();
    edgeResolver.resolvePhpImportEdges();
    edgeResolver.resolvePhpCallEdges();
    edgeResolver.resolveTypeScriptCallEdges();
    edgeResolver.resolveTypeScriptTypeEdges();
    edgeResolver.resolveMemberOfEdges();
    edgeResolver.resolvePythonHeritageEdges();
    edgeResolver.resolvePythonCallEdges();
    edgeResolver.resolveTestCoversEdges();
    edgeResolver.resolveMarkdownWikilinkEdges();
    edgeResolver.resolveMarkdownTagEdges();
    // Must run last — projects cross-file symbol edges to file-level `imports`
    // edges so the file dependency graph is as rich as the symbol graph.
    edgeResolver.resolveFileProjectionEdges();
  }

  /** Pass 3: LSP enrichment — upgrade call graph edges with compiler-grade resolution. */
  private async runLspEnrichment(): Promise<void> {
    if (!this.config.lsp?.enabled) return;

    try {
      const { LspBridge } = await import('../lsp/bridge.js');
      const bridge = new LspBridge(this.store, this.config, this.rootPath);
      try {
        await bridge.enrich();
      } finally {
        await bridge.shutdown();
      }
    } catch (e) {
      logger.warn({ error: e }, 'LSP enrichment failed — continuing without LSP edges');
    }
  }

  /** Pass 4: index .env files for environment variable tracking. */
  private async indexEnvFiles(force: boolean): Promise<void> {
    const envIndexer = new EnvIndexer(this.store, this.config, this.rootPath, this._traceignore);
    await envIndexer.indexEnvFiles(force);
  }

  private buildProjectContext(): ProjectContext {
    if (!this._projectContext) {
      this._projectContext = buildProjectContext(this.rootPath);
    }
    return this._projectContext;
  }

  private registerFrameworkEdgeTypes(): void {
    const registerSchema = (plugins: FrameworkPlugin[]) => {
      for (const plugin of plugins) {
        const schema = plugin.registerSchema();
        if (schema.edgeTypes) {
          for (const et of schema.edgeTypes) {
            this.store.ensureEdgeType(et.name, et.category, et.description ?? '');
          }
        }
      }
    };

    // Root-level plugins
    const ctx = this.buildProjectContext();
    const activeResult = this.registry.getActiveFrameworkPlugins(ctx);
    if (activeResult.isOk()) registerSchema(activeResult.value);

    // Workspace-level plugins (may detect frameworks not visible at root)
    for (const ws of this.workspaces) {
      const wsRoot = path.join(this.rootPath, ws.path);
      const wsCtx = buildProjectContext(wsRoot);
      const wsPlugins = this.registry.getAllFrameworkPlugins().filter((p) => p.detect(wsCtx));
      registerSchema(wsPlugins);
    }
  }

  private buildResolveContext(): ResolveContext {
    const store = this.store;
    return {
      rootPath: this.rootPath,
      getAllFiles: () =>
        store.getAllFiles().map((f) => ({
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
          metadata: s.metadata ? (JSON.parse(s.metadata) as Record<string, unknown>) : null,
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
        } catch {
          return undefined;
        }
      },
    };
  }

  private static readonly DEFAULT_MAX_FILES = 10_000;

  /**
   * Above this batch size, we drop FTS5 triggers, bulk-insert, then rebuild
   * the FTS index from scratch. Below it, per-row trigger fires are cheaper
   * than scanning all symbols for a rebuild.
   */
  private static readonly FTS_REBUILD_THRESHOLD = 50;

  /**
   * Spawn a worker pool only when extracting at least this many files —
   * below it, in-process is cheaper than spawn cost (~150-300 ms per worker).
   */
  private static readonly WORKER_THRESHOLD = 100;

  /**
   * Lazy-init the extract worker pool, gated by batch size and the
   * `TRACE_MCP_WORKERS=0` env opt-out. Returns null when workers are
   * unavailable in the current runtime (e.g. tsx dev, vitest) — caller must
   * fall back to in-process extraction.
   */
  private maybeGetExtractPool(batchSize: number): ExtractPool | null {
    if (batchSize < IndexingPipeline.WORKER_THRESHOLD) return null;
    if (process.env.TRACE_MCP_WORKERS === '0') return null;
    if (!this._extractPool) {
      this._extractPool = new ExtractPool();
      if (!this._extractPool.available) {
        logger.debug(
          'Extract worker pool unavailable in this runtime — using in-process extraction',
        );
      }
    }
    return this._extractPool.available ? this._extractPool : null;
  }

  /** Shut down the worker pool. Safe to call repeatedly. */
  async dispose(): Promise<void> {
    if (this._extractPool) {
      await this._extractPool.terminate();
      this._extractPool = undefined;
    }
  }

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

    // Workspace/monorepo fallback: if nothing matched, all code is nested deeper
    // (e.g. root/project/service/src/**). Re-try with **/<pattern> prefixed globs.
    if (entries.length === 0) {
      const deepPatterns = this.config.include
        .filter((p) => !p.startsWith('**/'))
        .map((p) => `**/${p}`);

      if (deepPatterns.length > 0) {
        entries = await fg(deepPatterns, {
          cwd: this.rootPath,
          ignore,
          dot: false,
          absolute: false,
          onlyFiles: true,
        });
        if (entries.length > 0) {
          logger.info(
            { count: entries.length, root: this.rootPath },
            'Workspace root detected — using deep glob patterns',
          );
        }
      }
    }

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
