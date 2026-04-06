import fs from 'node:fs';
import path from 'node:path';
import { cpus } from 'node:os';
import fg from 'fast-glob';
import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { TraceMcpConfig } from '../config.js';
import type { ResolveContext, RawEdge, RawRoute, RawComponent, RawMigration, RawOrmModel, RawOrmAssociation, RawRnScreen, ProjectContext, FileParseResult } from '../plugin-api/types.js';
import { buildProjectContext } from './project-context.js';
import { executeLanguagePlugin, executeFrameworkExtractNodes } from '../plugin-api/executor.js';
import { hashContent } from '../utils/hasher.js';
import { validatePath, validateFileSize, isSensitiveFile, isBinaryBuffer } from '../utils/security.js';
import { logger } from '../logger.js';
import { detectWorkspaces, type WorkspaceInfo } from './monorepo.js';
import { parseEnvFile } from '../utils/env-parser.js';
import { computeComplexity } from '../tools/complexity.js';
import { GitignoreMatcher } from '../utils/gitignore.js';
import { TraceignoreMatcher } from '../utils/traceignore.js';
import { invalidatePageRankCache } from '../scoring/pagerank.js';
import { captureGraphSnapshots } from '../tools/history.js';
import { disableFts5Triggers, enableFts5Triggers } from '../db/schema.js';
import { FilePersister } from './file-persister.js';
import { EdgeResolver } from './edge-resolver.js';
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
  // Traceignore matcher — files matching these rules are fully skipped from indexing.
  private _traceignore: TraceignoreMatcher | undefined;
  // Incremental indexing state: tracks which files were actually re-indexed in this run.
  // When set, edge resolution passes scope to these files only (O(changed) not O(all)).
  private _changedFileIds = new Set<number>();
  private _isIncremental = false;

  /** Build the shared state snapshot consumed by FilePersister and EdgeResolver. */
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

    // Load .traceignore + config ignore rules
    this._traceignore = new TraceignoreMatcher(this.rootPath, this.config.ignore);

    // Register edge types from framework plugins
    this.registerFrameworkEdgeTypes();

    try {
      // Pass 1: extract + persist in batched transactions for throughput.
      // Extractions within each batch run concurrently (parallel I/O + parsing),
      // then persist in a single SQLite transaction per batch.
      {
        // Disable FTS5 triggers during batch inserts — rebuild once after all inserts.
        // This avoids per-row FTS5 index updates (20-30% speedup on symbol insertion).
        disableFts5Triggers(this.store.db);

        const BATCH_SIZE = Math.min(500, Math.max(100, Math.ceil(relPaths.length / 20)));
        const CONCURRENCY = Math.min(8, cpus().length);
        for (let i = 0; i < relPaths.length; i += BATCH_SIZE) {
          const batch = relPaths.slice(i, i + BATCH_SIZE);
          const extractions: FileExtraction[] = [];

          // Run extractions concurrently within the batch, limited by CONCURRENCY
          for (let c = 0; c < batch.length; c += CONCURRENCY) {
            const chunk = batch.slice(c, c + CONCURRENCY);
            const results = await Promise.all(
              chunk.map(relPath => this.extractFile(relPath, force)),
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

        // Rebuild FTS5 index once after all batch inserts and re-enable triggers
        enableFts5Triggers(this.store.db);
      }

      // Pass 2: resolve edges via EdgeResolver
      const edgeResolver = new EdgeResolver(this.getPipelineState());

      // Pass 2a: framework plugin edges
      await edgeResolver.resolveEdges(this.buildProjectContext(), this.buildResolveContext());

      // Pass 2b: ORM associations → graph edges (resolved after all entities indexed)
      edgeResolver.resolveOrmAssociationEdges();

      // Pass 2c: TypeScript heritage → graph edges (extends/implements → find_usages)
      edgeResolver.resolveTypeScriptHeritageEdges();

      // Pass 2d: ES module imports → file→file edges (enables dependency graph + dead export analysis)
      edgeResolver.resolveEsmImportEdges();

      // Pass 2e: test_covers edges — test file imports source file → test_covers edge
      edgeResolver.resolveTestCoversEdges();

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
    let fileMtimeMs: number | null = null;
    try {
      const stat = fs.lstatSync(absPath);
      if (stat.isSymbolicLink()) {
        logger.warn({ file: relPath }, 'Symlink skipped');
        return 'error';
      }
      fileMtimeMs = stat.mtimeMs;
    } catch {
      // lstat failed — file may not exist; readFileSync below will catch it
    }

    // Block sensitive files (credentials, keys, secrets) from indexing
    if (isSensitiveFile(relPath)) {
      logger.warn({ file: relPath }, 'Sensitive file blocked from indexing');
      return 'skipped';
    }

    // Single DB lookup — reused for both mtime fast-path and hash-change check
    const existing = this.store.getFile(relPath);

    // mtime fast-path: if mtime hasn't changed, the file content is identical —
    // skip the expensive read + hash computation entirely.
    if (!force && fileMtimeMs != null && existing
        && existing.mtime_ms != null && existing.mtime_ms === Math.floor(fileMtimeMs)) {
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
      mtimeMs: fileMtimeMs != null ? Math.floor(fileMtimeMs) : null,
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

  private static readonly DEFAULT_MAX_FILES = 10_000;

  private async collectFiles(): Promise<string[]> {
    // Merge config exclude with traceignore skip-dir patterns for fast-glob
    const traceignoreIgnore = this._traceignore?.toFastGlobIgnore() ?? [];
    const ignore = [...this.config.exclude, ...traceignoreIgnore];

    let entries = await fg(this.config.include, {
      cwd: this.rootPath,
      ignore,
      dot: false,
      absolute: false,
      onlyFiles: true,
    });

    // Post-filter with .traceignore pattern rules (gitignore syntax not 1:1 with fast-glob)
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
