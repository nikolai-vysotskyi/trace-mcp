import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import fg from 'fast-glob';
import picomatch from 'picomatch';
import type { TraceMcpConfig } from '../config.js';
import {
  disableBulkMode,
  disableFts5Triggers,
  enableBulkMode,
  enableFts5Triggers,
} from '../db/schema.js';
import type { Store } from '../db/store.js';
import { logger } from '../logger.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type {
  ChangeScope,
  FrameworkPlugin,
  ProjectContext,
  ResolveContext,
} from '../plugin-api/types.js';
import { invalidatePageRankCache } from '../scoring/pagerank.js';
import { invalidateSearchCache } from '../scoring/search-cache.js';
import { captureGraphSnapshots } from '../tools/analysis/history.js';
import { safeGitEnv } from '../utils/git-env.js';
import { initContentHasher } from '../util/hash.js';
import { descendantExcludeGlobs } from '../registry.js';
import { GitignoreMatcher } from '../utils/gitignore.js';
import { hashContent } from '../utils/hasher.js';
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
// P02 Task DAG migration: 3 passes are scheduled through a TaskDag instead
// of being called imperatively from `runPipeline`. The Task wrappers live in
// `src/pipeline/tasks/*` and delegate to the existing private methods on
// this class. See plans/plan-cognee-pipeline-migration-IMPL.md.
import {
  createGraphSnapshotsTask,
  createLspEnrichmentTask,
  createResolveEdgesTask,
  GRAPH_SNAPSHOTS_TASK_NAME,
  LSP_ENRICHMENT_TASK_NAME,
  RESOLVE_EDGES_TASK_NAME,
  TaskDag,
  type TaskCache,
} from '../pipeline/index.js';

export type { FileExtraction } from './pipeline-state.js';

import type { ProgressState } from '../progress.js';
import type { FileExtraction } from './pipeline-state.js';

/**
 * Postprocess intensity level for an indexing run. CRG v2.2.0 introduced
 * this knob so CI builds and incremental updates could skip the
 * heavyweight passes that aren't needed every time.
 *
 *   full    — the default; runs every postprocess phase
 *   minimal — skips LSP enrichment + env-var scan + git history snapshots
 *   none    — skips edge resolution as well; raw symbols only
 */
export type PostprocessLevel = 'full' | 'minimal' | 'none';

export interface IndexingResult {
  totalFiles: number;
  indexed: number;
  skipped: number;
  errors: number;
  durationMs: number;
  incremental?: boolean;
  /** Postprocess level the result was produced at — surfaced for callers. */
  postprocess?: PostprocessLevel;
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
  /**
   * File IDs that were touched in this run (extracted, re-extracted, or had
   * their resolution scope expanded by rename/edge bind churn). Surfaced so
   * callers — primarily the background LSP enricher — can scope follow-up
   * work to exactly the files whose symbols may have new outgoing edges.
   *
   * Empty / undefined for full reindexes (the enricher is meant to handle
   * incremental drift, not the synchronous initial pass).
   */
  changedFileIds?: number[];
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
/** In-place sort of a path list so files of the same extension cluster
 *  together. Workers reuse their parser cache on runs of the same language. */
export function sortByExtension(relPaths: string[]): string[] {
  relPaths.sort((a, b) => {
    const extA = path.extname(a);
    const extB = path.extname(b);
    return extA.localeCompare(extB) || a.localeCompare(b);
  });
  return relPaths;
}

function readGitHeadSha(rootPath: string): string | null {
  try {
    // execFileSync (no shell) — matches the boundary established in 3b08ed0
    // for every other git spawn in the codebase. Inputs here are constants
    // so there is no current injection vector, but keeping the spawn shape
    // uniform means the next change to this function cannot accidentally
    // reintroduce a shell-mode call.
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
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

/**
 * Decide whether a full (non-incremental) `indexAll` can skip the postprocess
 * phase (edge resolution + LSP enrichment + env scan).
 *
 * The daemon re-runs `indexAll` for every registered project on every start.
 * Without this gate it re-resolves the entire edge graph even when extraction
 * hash-skipped 100% of files (`indexed: 0`) — tens of seconds of CPU plus a
 * full-graph memory spike per project on every restart. On a multi-project
 * daemon that spike is what drives the OOM-kill -> launchd respawn -> full
 * reindex -> OOM loop that surfaces to MCP clients as "Session expired".
 *
 * Skip only with positive proof the persisted graph is already current:
 *   - not a forced rebuild — post-update and FK-recovery passes set force=true
 *     and MUST rebuild so schema / plugin-version changes land;
 *   - extraction touched nothing (indexed === 0 && errors === 0);
 *   - the graph already has edges (not a first/empty index);
 *   - git HEAD matches the SHA stamped at the last successful index.
 *
 * ponytail: git-only freshness proof. Non-git projects (no HEAD) never skip —
 * they keep the prior full-resolution behavior rather than risk a stale graph.
 * Same blind spot as the incremental short-circuit in resolveAllEdges(): an
 * uncommitted file *deletion* at an unchanged HEAD won't re-prune edges until
 * the next real change; the watcher + debounced reconcile cover that live.
 */
export function canSkipFullPostprocess(args: {
  force: boolean;
  indexed: number;
  errors: number;
  totalEdges: number;
  currentHead: string | null;
  storedHead: string | null;
}): boolean {
  const { force, indexed, errors, totalEdges, currentHead, storedHead } = args;
  if (force) return false;
  if (indexed !== 0 || errors !== 0) return false;
  if (totalEdges <= 0) return false;
  if (!currentHead || !storedHead) return false;
  return currentHead === storedHead;
}

export interface IndexingPipelineDeps {
  /** Inject a daemon-shared ExtractPool. When provided, the pipeline never
   *  creates its own pool and dispose() does NOT terminate the shared one. */
  extractPool?: ExtractPool | null;
  /**
   * Inject a custom `TaskCache` for the TaskDag. The daemon should pass
   * `new SqliteTaskCache(db)` so cached pass outputs persist on disk instead
   * of growing the daemon's resident set. CLI / one-shot callers should
   * leave this undefined — the default in-memory cache is LRU-capped and
   * cheaper for short-lived processes.
   */
  taskCache?: TaskCache | null;
  /**
   * Debounce window (ms) before the deferred full edge-resolution reconcile
   * pass fires after symbol-name churn. Production callers leave this
   * undefined (10s default); tests inject a small value so they can await
   * the pass with real timers.
   */
  reconcileDebounceMs?: number;
}

export class IndexingPipeline {
  constructor(
    private store: Store,
    private registry: PluginRegistry,
    private config: TraceMcpConfig,
    private rootPath: string,
    private progress?: ProgressState,
    deps?: IndexingPipelineDeps,
  ) {
    if (deps?.extractPool) {
      this._extractPool = deps.extractPool;
      this._poolIsOwned = false;
    }
    if (deps?.reconcileDebounceMs !== undefined) {
      this._reconcileDebounceMs = deps.reconcileDebounceMs;
    }
    // P02 Task DAG: register the migrated passes once per pipeline instance.
    // Each Task is a thin adapter — the actual work still happens in the
    // private methods on this class (or in `captureGraphSnapshots`); the
    // Task layer only changes how those methods are scheduled.
    //
    // When `deps.taskCache` is provided (the daemon path passes a
    // `SqliteTaskCache(db)`), cache state lives on disk and never accumulates
    // in the daemon's heap. Otherwise the DAG falls back to its built-in
    // LRU-capped in-memory cache — fine for one-shot CLI runs.
    this._taskCacheIsExternal = !!deps?.taskCache;
    this._dag = deps?.taskCache ? new TaskDag({ cache: deps.taskCache }) : new TaskDag();
    this._dag.register(createResolveEdgesTask());
    this._dag.register(createLspEnrichmentTask());
    this._dag.register(createGraphSnapshotsTask());
  }

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
  // Phase 4 phantom-rebind: snapshot of persister's name churn after the
  // most-recent extract phase. buildChangeScope() reads these so resolvers
  // can rebind unresolved edges in OTHER files that match new symbol names,
  // and unbind edges pointing at deleted symbols. Empty for full reindexes.
  private _lastNewSymbolNames: Map<string, Set<number>> = new Map();
  private _lastDeletedSymbolNames: Map<string, Set<number>> = new Map();
  private _isIncremental = false;
  /** Set by dispose(); pending deferred work must bail instead of touching a closed DB. */
  private _disposed = false;
  private _extractPool: ExtractPool | undefined;
  /** True when this pipeline owns its pool (lazy, per-instance) and must
   *  terminate it on dispose(). False when the pool came in via DI from the
   *  daemon — termination is the daemon's responsibility. */
  private _poolIsOwned = true;
  /**
   * True when the TaskDag was constructed with an injected cache (the daemon
   * passes `SqliteTaskCache(db)`). When true, `dispose()` does NOT clear the
   * cache — it belongs to the caller. When false (CLI / one-shot path), the
   * in-memory cache is owned by this pipeline and cleared on dispose so the
   * Map can be GC'd promptly.
   */
  private _taskCacheIsExternal = false;
  /**
   * Postprocess level for the current run, set by indexAll/indexFiles. CRG
   * v2.2.0 made this configurable so CI builds and incremental updates
   * could skip the heavyweight LSP / env / snapshot phases. 'full' runs
   * everything; 'minimal' skips LSP enrichment and env-var scan; 'none'
   * also skips git-history snapshots and the registry-side capture.
   */
  private _postprocessLevel: PostprocessLevel = 'full';

  /**
   * P02 Task DAG holding the migrated pipeline passes (resolve-edges,
   * lsp-enrichment, graph-snapshots). Registered once per pipeline
   * instance in the constructor. Internal API — production callers stay on
   * `indexAll` / `indexFiles`.
   */
  private readonly _dag: TaskDag;

  /** Internal accessor for tests that want to inspect / drive the DAG directly. */
  getTaskDag(): TaskDag {
    return this._dag;
  }

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

  async indexAll(
    force?: boolean,
    opts: { postprocess?: PostprocessLevel } = {},
  ): Promise<IndexingResult> {
    const result = this._lock.then(async () => {
      this._isIncremental = false;
      this._postprocessLevel = opts.postprocess ?? 'full';
      const start = Date.now();
      // Snapshot the existing index size so runPipeline can detect a
      // catastrophic shrink (e.g. parser regression dropping half the files
      // silently). Skip when:
      //   - force=true: caller has acknowledged the risk
      //   - postprocess=none: edge resolution is skipped by design, so an
      //     N→0 edge ratio after the run is expected and a `shrinkWarning`
      //     would be a false positive that automated quality gates would
      //     misinterpret as a regression.
      const skipShrinkCheck = force === true || this._postprocessLevel === 'none';
      const before = skipShrinkCheck ? null : this.captureSizeSnapshot();
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
      // Engage bulk-load mode (synchronous=OFF, foreign_keys=OFF) only for
      // genuine from-scratch indexes. We never enter bulk mode on a live
      // daemon with an existing graph because other connections may still
      // read the DB and a crash with synchronous=OFF would corrupt the file.
      // The "from-scratch" signal is `totalSymbols === 0` — this works even
      // when `force=true` is passed (which would otherwise skip the shrink
      // check signal).
      const isFromScratch = (() => {
        try {
          return this.store.getStats().totalSymbols === 0;
        } catch {
          return false;
        }
      })();
      if (isFromScratch) {
        logger.info('Engaging bulk-load mode for from-scratch index');
        enableBulkMode(this.store.db);
      }
      let r: IndexingResult;
      try {
        r = await this.runPipeline(filePaths, force ?? false, start);
      } finally {
        // Always restore production-safe pragmas — a crash with
        // synchronous=OFF on disk would leave the daemon unsafe. disableBulkMode
        // also runs ANALYZE + WAL checkpoint, so we don't need a separate
        // ANALYZE on this path.
        if (isFromScratch) {
          try {
            disableBulkMode(this.store.db);
          } catch (err) {
            logger.warn({ err }, 'Failed to restore pragmas after bulk index (non-fatal)');
          }
        }
      }
      if (before) this.checkShrink(before, r);
      // Non-bulk path: refresh planner statistics so subsequent queries pick
      // indices using real cardinality rather than fallback heuristics.
      // ANALYZE is sub-second on graphs in our typical size range and runs at
      // most once per full reindex. Skipped on the bulk path because
      // disableBulkMode already ran ANALYZE.
      if (!isFromScratch) {
        try {
          this.store.db.exec('ANALYZE');
        } catch (err) {
          logger.debug({ err }, 'ANALYZE failed after indexAll (non-fatal)');
        }
      }
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

  async indexFiles(
    filePaths: string[],
    opts: { postprocess?: PostprocessLevel } = {},
  ): Promise<IndexingResult> {
    const result = this._lock.then(async () => {
      this._isIncremental = true;
      // Default to 'minimal' for incremental runs. Watcher/hook/register_edit
      // callers don't override; full postprocess (LSP + env + snapshots) was
      // the source of 3-11s outliers visible in daemon.log on single-file
      // edits. Explicit callers (the `reindex` MCP tool for indexPath param)
      // still pass 'full' explicitly when needed.
      this._postprocessLevel = opts.postprocess ?? 'minimal';
      const start = Date.now();
      // Same exclude gate collectFiles() applies via fast-glob. Without it,
      // event-driven entry points (watcher, hooks, register_edit, HTTP) index
      // runtime churn the full pipeline would never touch — e.g. Laravel
      // storage/framework/sessions blobs arriving on every web request.
      const isExcluded = this.getExcludeMatcher();
      // A registered descendant owns its own subtree — drop its files so an
      // umbrella root's watcher-driven reindex is a no-op instead of a second,
      // umbrella-wide edge reconcile (the daemon-starvation cause behind #209).
      const descendantGlobs = descendantExcludeGlobs(this.rootPath);
      const ownedByDescendant = descendantGlobs.length
        ? picomatch(descendantGlobs, { dot: true })
        : undefined;
      const relPaths: string[] = [];
      for (const fp of filePaths) {
        const rel = path.isAbsolute(fp) ? path.relative(this.rootPath, fp) : fp;
        const check = validatePath(rel, this.rootPath);
        if (check.isErr()) {
          logger.warn({ file: fp }, 'Path traversal blocked in indexFiles');
          continue;
        }
        const relPosix = rel.split(path.sep).join('/');
        if (isExcluded(relPosix)) {
          logger.debug({ file: rel }, 'Excluded path skipped in indexFiles');
          continue;
        }
        if (ownedByDescendant?.(relPosix)) {
          logger.debug({ file: rel }, 'Skipped: owned by a more-specific registered project');
          continue;
        }
        relPaths.push(rel);
      }
      return this.runPipeline(relPaths, false, start);
    });
    this._lock = result.catch(() => {});
    return result as Promise<IndexingResult>;
  }

  private _excludeMatcher?: (p: string) => boolean;

  /** Lazily-built picomatch matcher over config.exclude (POSIX rel paths). */
  private getExcludeMatcher(): (p: string) => boolean {
    if (!this._excludeMatcher) {
      this._excludeMatcher = picomatch(this.config.exclude ?? [], { dot: true });
    }
    return this._excludeMatcher;
  }

  private async runPipeline(
    relPaths: string[],
    force: boolean,
    startMs: number,
  ): Promise<IndexingResult> {
    // Sync the xxhash-wasm module before any extract() runs so the
    // content-hash gate is non-blocking on the hot path.
    await initContentHasher();

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
      // Postprocess-level gating: 'none' stops after raw symbol extraction;
      // 'minimal' resolves edges but skips LSP + env scan; 'full' runs all.
      // P02 Task DAG: resolve-edges + lsp-enrichment are scheduled via
      // this._dag. The Task wrappers are pure adapters — they call back
      // into the private methods below. Telemetry / progress callbacks are
      // unchanged because the underlying methods own them.
      //
      // Restart short-circuit: when extraction proves nothing changed since
      // the last successful index (HEAD + content match) the persisted edge
      // graph is already correct. Skip the whole postprocess so a daemon
      // restart doesn't re-resolve every project's full graph from scratch —
      // see canSkipFullPostprocess() for why this breaks the OOM-restart loop.
      const skipPostprocess =
        this._postprocessLevel !== 'none' &&
        canSkipFullPostprocess({
          force,
          indexed: result.indexed,
          errors: result.errors,
          totalEdges: this.store.getStats().totalEdges,
          currentHead: readGitHeadSha(this.rootPath),
          storedHead: this.store.getRepoMetadata('index_head_sha'),
        });
      if (skipPostprocess) {
        logger.info(
          { root: this.rootPath, postprocess: this._postprocessLevel },
          'Index unchanged since last run (HEAD + content match) — skipping edge resolution + postprocess',
        );
      } else {
        if (this._postprocessLevel !== 'none') {
          await this._dag.run(RESOLVE_EDGES_TASK_NAME, {
            runResolveAllEdges: () => this.resolveAllEdges(),
          });
        }
        if (this._postprocessLevel === 'full') {
          await this._dag.run(LSP_ENRICHMENT_TASK_NAME, {
            runLspEnrichment: () => this.runLspEnrichment(),
          });
          await this.indexEnvFiles(force);
        }
      }
    } finally {
      // Snapshot the changed-file set BEFORE clearing so callers (background
      // LSP enricher) can scope follow-up work to exactly these files. The
      // set is otherwise wiped here for the next run. Empty array for full
      // reindexes — extractAndPersist only populates _changedFileIds for the
      // incremental path.
      if (this._changedFileIds.size > 0) {
        result.changedFileIds = Array.from(this._changedFileIds);
      }
      this._fileContentCache.clear();
      this._pendingImports.clear();
      this._changedFileIds.clear();
      invalidatePageRankCache();
      invalidateSearchCache();
    }

    if (this._postprocessLevel === 'full' && !this._isIncremental && result.indexed > 0) {
      try {
        // P02 Task DAG: graph-snapshots is scheduled via this._dag. The Task
        // wrapper is a pure adapter — it calls `captureGraphSnapshots(store,
        // rootPath)`. The outer try/catch stays here because the original
        // contract is "log the failure, never abort indexing".
        await this._dag.run(GRAPH_SNAPSHOTS_TASK_NAME, {
          captureSnapshots: () => captureGraphSnapshots(this.store, this.rootPath),
        });
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
    result.postprocess = this._postprocessLevel;

    this.progress?.update('indexing', {
      phase: 'completed',
      processed: result.indexed + result.skipped + result.errors,
      completedAt: Date.now(),
    });

    logger.info(result, 'Indexing pipeline completed');
    return result;
  }

  /**
   * Pre-pass: detect file renames by content hash. When a path on disk has
   * no matching DB row but its content hash matches a DB row whose old path
   * no longer exists on disk, treat it as a rename — atomically update the
   * file row's path and skip extraction. Inspired by graphify v0.7.0's move
   * to content-only cache keys.
   *
   * Returns the count of detected renames. Mutates the DB and the
   * `existingFiles` lookup so the caller can re-load it.
   */
  private detectRenames(
    relPaths: string[],
    existingFiles: Map<string, import('../db/types.js').FileRow>,
  ): number {
    // Files in DB whose path is not in the current scan list — candidates
    // for "old name of a renamed file".
    const onDiskSet = new Set(relPaths);
    const orphans = this.store.getAllFiles().filter((f) => {
      if (!f.content_hash) return false;
      if (onDiskSet.has(f.path)) return false;
      // Defensive: only consider rows whose old path actually no longer exists
      // on disk. A second snapshot could otherwise mistakenly rename a row
      // whose original file was simply excluded from this batch.
      const abs = path.resolve(this.rootPath, f.path);
      return !fs.existsSync(abs);
    });
    if (orphans.length === 0) return 0;

    // Index orphans by hash for O(1) lookup. A given hash may appear under
    // multiple orphans (legitimate identical files that were all moved); we
    // keep them in an array and pick the first available match per new path.
    const orphansByHash = new Map<string, import('../db/types.js').FileRow[]>();
    for (const o of orphans) {
      const arr = orphansByHash.get(o.content_hash!) ?? [];
      arr.push(o);
      orphansByHash.set(o.content_hash!, arr);
    }

    let renamed = 0;
    for (const relPath of relPaths) {
      if (existingFiles.has(relPath)) continue; // already known under this path
      const abs = path.resolve(this.rootPath, relPath);
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        continue; // unreadable file — leave for the normal error path
      }
      const hash = hashContent(buf);
      const candidates = orphansByHash.get(hash);
      if (!candidates || candidates.length === 0) continue;

      const orphan = candidates.shift()!;
      // Carry the existing row over to the new path. All FK references
      // (symbols, edges, nodes) keep their connection because the row id
      // does not change.
      this.store.updateFilePath(orphan.id, relPath);
      existingFiles.set(relPath, { ...orphan, path: relPath });
      renamed++;
      logger.debug(
        { from: orphan.path, to: relPath, hash: hash.slice(0, 8) },
        'Detected rename — reused existing symbols',
      );
    }
    return renamed;
  }

  /** Pass 1: extract symbols from files and persist in batched transactions. */
  private async extractAndPersist(
    relPaths: string[],
    force: boolean,
    result: IndexingResult,
  ): Promise<void> {
    // Preload all existing file rows in one IN-query so per-file extract()
    // calls hit a Map instead of issuing a SELECT each.
    let existingFiles = this.store.getFilesByPaths(relPaths);

    // Detect renames before extraction. Without this pass a refactor that
    // moves N files to new paths re-extracts every byte, even though the
    // content is identical to known DB rows. graphify v0.7.0 fixed the same
    // wasted work by keying its cache on content alone.
    const renamed = this.detectRenames(relPaths, existingFiles);
    if (renamed > 0) {
      // Renamed paths are now keyed under their new path in the DB; refresh
      // the lookup map so the extractor sees them as "existing".
      existingFiles = this.store.getFilesByPaths(relPaths);
      logger.info({ renamed }, 'Detected renames — reused existing symbols');
    }

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

    // Cluster same-language files so each worker hits its parser cache instead
    // of paying ~50-100 ms WASM Language.load on every extension switch.
    sortByExtension(relPaths);

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
    // Phase 4 phantom-rebind: reset prior-run snapshot, then snapshot fresh
    // maps once persistBatch has populated them across all batches.
    this._lastNewSymbolNames = new Map();
    this._lastDeletedSymbolNames = new Map();

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
              if (r.kind === 'mtime_updated') {
                // WHY: workers have no DB handle — apply the deferred mtime
                // update on the main thread so the next run hits the cheap
                // mtime fast-path instead of re-hashing every file.
                this.store.updateFileMtime(r.fileId, r.newMtimeMs);
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
            if (ext.kind === 'skipped') {
              result.skipped++;
              continue;
            }
            if (ext.kind === 'mtime_updated') {
              // WHY: in-process path normally writes via the in-extractor
              // store handle; this branch is defensive for callers that
              // construct a FileExtractor without a store.
              this.store.updateFileMtime(ext.fileId, ext.newMtimeMs);
              result.skipped++;
              continue;
            }
            if (ext.kind === 'error') {
              result.errors++;
              continue;
            }
            extractions.push(ext.extraction);
          }
        }
      }

      if (extractions.length > 0) {
        persister.persistBatch(extractions);
        result.indexed += extractions.length;
      }

      // Bound in-process content residency to one batch: Pass 2
      // (buildResolveContext.readFile) re-reads from disk on a cache miss, and
      // the OS page cache keeps these warm, so it is safe to release the
      // batch's source here instead of pinning the whole repo's file content
      // in RAM until run end. The end-of-run clear() (in run()'s finally
      // block) remains as the final safety net. relPath is the exact key the
      // in-process extractor populated the cache with (file-extractor.ts sets
      // fileContentCache.set(relPath, ...)); for the worker path these keys
      // are not present, so the delete is a harmless no-op.
      for (const ext of extractions) {
        this._fileContentCache.delete(ext.relPath);
      }

      const processed = result.indexed + result.skipped + result.errors;
      this.progress?.update('indexing', { processed });
      // persistBatch is one synchronous SQLite transaction over up to 500
      // files — stacked back-to-back across batches it starves the event
      // loop, /health stops answering, and the desktop app's watchdog kills
      // the daemon mid-warm-up. One macrotask turn per batch keeps the
      // process responsive at negligible cost.
      await new Promise<void>((r) => setImmediate(r));
    }

    if (useFtsRebuild) enableFts5Triggers(this.store.db);
    // Phase 4 phantom-rebind: persistBatch has now populated the persister
    // diff maps; expose them to buildChangeScope() via the pipeline fields.
    this._lastNewSymbolNames = persister.newSymbolNames;
    this._lastDeletedSymbolNames = persister.deletedSymbolNames;
  }

  /** Pass 2: resolve all edge types (imports, heritage, ORM, tests). */
  private async resolveAllEdges(): Promise<void> {
    const scope = this.buildChangeScope();

    // Short-circuit: incremental run with no actual content change (hash-gate
    // hit on every file). Edges are stable, no need to re-resolve anything.
    if (
      scope &&
      scope.changedFileIds.size === 0 &&
      scope.newSymbolNames.size === 0 &&
      scope.deletedSymbolNames.size === 0
    ) {
      logger.debug('No files or symbols changed — skipping edge resolution');
      return;
    }

    await this.runEdgeResolvers(scope);

    // Symbol-name churn (add / delete / rename) means references in UNTOUCHED
    // files may need rebinding — a brand-new symbol can satisfy a previously
    // unresolved call, and a deleted one may have shadowed a same-name
    // alternative. That used to force an inline full-pass on every such edit
    // (1-9s of synchronous CPU per watcher event on large repos — the
    // dominant indexing cost observed in the field, and every new file
    // counts all its symbols as new). The scoped pass above keeps the
    // changed files correct immediately; one debounced full reconcile pass
    // restores global correctness after the edit storm quiets down.
    if (scope && (scope.newSymbolNames.size > 0 || scope.deletedSymbolNames.size > 0)) {
      this.scheduleEdgeReconcile();
    }
  }

  /**
   * Run every edge resolver against `scope` (undefined = full pass).
   *
   * Each resolver stage is fully synchronous (better-sqlite3 + in-memory
   * indexes); on large repos a full pass holds the event loop for seconds.
   * That made the daemon's /health endpoint unresponsive during warm-up, and
   * the desktop app's 5s watchdog answered by shooting the daemon with
   * `daemon restart` — an infinite restart loop in the field. The
   * setImmediate yield between stages gives pending I/O (health checks, MCP
   * requests) a turn while preserving stage ORDER (fastapi-mounts needs
   * python imports; file-projection must run last).
   */
  private async runEdgeResolvers(scope: ChangeScope | undefined): Promise<void> {
    if (scope === undefined) this._lastFullResolveMs = Date.now();
    const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
    const edgeResolver = new EdgeResolver(this.getPipelineState());
    await edgeResolver.resolveEdges(
      this.buildProjectContext(),
      this.buildResolveContext(scope),
      scope,
    );
    const stages: Array<() => void> = [
      () => edgeResolver.resolveOrmAssociationEdges(scope),
      () => edgeResolver.resolveTypeScriptHeritageEdges(scope),
      () => edgeResolver.resolveEsmImportEdges(scope),
      () => edgeResolver.resolvePythonImportEdges(scope),
      () => edgeResolver.resolvePhpImportEdges(scope),
      () => edgeResolver.resolvePhpCallEdges(scope),
      () => edgeResolver.resolveTypeScriptCallEdges(scope),
      () => edgeResolver.resolveTypeScriptTypeEdges(scope),
      () => edgeResolver.resolveMemberOfEdges(scope),
      () => edgeResolver.resolvePythonHeritageEdges(scope),
      () => edgeResolver.resolvePythonCallEdges(scope),
      // After Python imports + calls: turn type annotations into `references`
      // edges. Runs before file projection so they reach the file-level graph too.
      () => edgeResolver.resolvePythonTypeEdges(scope),
      // Cross-file FastAPI mount prefixes — needs resolved Python imports above.
      () => edgeResolver.resolveFastapiRouterMounts(scope),
      () => edgeResolver.resolveTestCoversEdges(scope),
      () => edgeResolver.resolveMarkdownWikilinkEdges(scope),
      () => edgeResolver.resolveMarkdownTagEdges(scope),
      // Must run last — projects cross-file symbol edges to file-level `imports`
      // edges so the file dependency graph is as rich as the symbol graph.
      () => edgeResolver.resolveFileProjectionEdges(scope),
    ];
    for (const stage of stages) {
      await yieldLoop();
      stage();
    }
  }

  /**
   * Build a `ChangeScope` from pipeline state. Returns `undefined` for
   * full-index runs (`indexAll(force=true)` or first index) so resolvers fall
   * back to full-pass behaviour. Returns a populated scope for incremental
   * runs, OR `undefined` when the watcher batch is so large (>200 files) that
   * the incremental advantage is gone — full-pass is cheaper at that point.
   *
   * Symbol-name churn (rename / add / delete) no longer downgrades the run
   * to a full pass: edges pointing at deleted symbols are already removed by
   * the node-delete FK cascade in deleteSymbolsByFile(), and cross-file
   * rebinding to new names is handled by the debounced reconcile pass
   * scheduled in resolveAllEdges(). The previous inline full-pass cost 1-9s
   * of synchronous CPU per edit that introduced or removed any symbol.
   */
  private buildChangeScope(): ChangeScope | undefined {
    if (!this._isIncremental) return undefined;
    if (this._changedFileIds.size > IndexingPipeline.MAX_INCREMENTAL_FILES) return undefined;
    return {
      changedFileIds: this._changedFileIds,
      newSymbolNames: this._lastNewSymbolNames,
      deletedSymbolNames: this._lastDeletedSymbolNames,
    };
  }

  /** Debounce window before the deferred full edge-resolution reconcile. */
  private static readonly EDGE_RECONCILE_DEBOUNCE_MS = 10_000;
  private _reconcileDebounceMs: number = IndexingPipeline.EDGE_RECONCILE_DEBOUNCE_MS;
  private _reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  /** Date.now() at the most recent scheduleEdgeReconcile() call. */
  private _reconcileScheduledAt = 0;
  /** Timestamp of the most recent full (scope=undefined) resolver pass. */
  private _lastFullResolveMs = 0;

  /**
   * Schedule a coalesced full edge-resolution pass. Incremental runs whose
   * symbol names churned resolve only their own files inline; references in
   * untouched files that should (re)bind to the new/deleted names are
   * reconciled here, once, after EDGE_RECONCILE_DEBOUNCE_MS of quiet. An
   * edit storm of N files costs N scoped passes + 1 full pass instead of N
   * full passes. The pass chains onto `_lock`, so it serializes with any
   * concurrently queued pipeline run and never overlaps a live transaction.
   */
  private scheduleEdgeReconcile(): void {
    if (this._reconcileTimer) clearTimeout(this._reconcileTimer);
    this._reconcileScheduledAt = Date.now();
    this._reconcileTimer = setTimeout(() => this.fireEdgeReconcile(), this._reconcileDebounceMs);
    // Never keep the process alive just for a pending reconcile.
    this._reconcileTimer.unref?.();
  }

  /** Timer body for the deferred reconcile — chains the full pass onto the pipeline lock. */
  private fireEdgeReconcile(): void {
    this._reconcileTimer = null;
    const scheduledAt = this._reconcileScheduledAt;
    const run = this._lock.then(async () => {
      if (this._disposed) return;
      // A full pass already ran after this was scheduled (forced reindex,
      // large-batch fallback) — the graph is already reconciled.
      if (this._lastFullResolveMs >= scheduledAt) return;
      const start = Date.now();
      await this.runEdgeResolvers(undefined);
      invalidatePageRankCache();
      invalidateSearchCache();
      logger.info({ durationMs: Date.now() - start }, 'Deferred edge reconcile completed');
    });
    this._lock = run.catch((e) => {
      logger.warn({ error: e }, 'Deferred edge reconcile failed');
    });
  }

  /**
   * Test hook: fire a pending deferred reconcile immediately and await it.
   * Lets tests assert coalescing behaviour deterministically (large injected
   * debounce + explicit flush) instead of racing wall-clock timers. No-op
   * when nothing is scheduled.
   */
  async __flushEdgeReconcileForTests(): Promise<void> {
    if (!this._reconcileTimer) return;
    clearTimeout(this._reconcileTimer);
    this.fireEdgeReconcile();
    await this._lock;
  }

  /** Pass 3: LSP enrichment — upgrade call graph edges with compiler-grade resolution. */
  private async runLspEnrichment(): Promise<void> {
    if (!this.config.lsp?.enabled) return;
    // Defense in depth: incremental indexFiles() runs default to
    // postprocess='minimal' which already skips this method, but if a future
    // caller bumps an incremental run to 'full' it must still bail here.
    // The BackgroundLspEnricher (src/lsp/background-enricher.ts) handles
    // incremental enrichment out-of-band — running it inline on the watcher
    // hot path was the source of 3-11s outliers Phase 1 fixed.
    if (this._isIncremental) return;

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

  private buildResolveContext(scope?: ChangeScope): ResolveContext {
    const store = this.store;
    return {
      rootPath: this.rootPath,
      changeScope: scope,
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
   * Above this incremental-batch size, scoped edge resolution loses its
   * advantage — the per-resolver indexing setup costs (full target SELECT,
   * name index build, node-id batch load) dominate, so a full pass is
   * cheaper. Empirically tuned: at ~200 changed files the scope filter saves
   * less work than it costs in extra branching.
   */
  private static readonly MAX_INCREMENTAL_FILES = 200;

  /**
   * Lazy-init the extract worker pool, gated by batch size and the
   * `TRACE_MCP_WORKERS=0` env opt-out. Returns null when workers are
   * unavailable in the current runtime (e.g. tsx dev, vitest) — caller must
   * fall back to in-process extraction.
   */
  private maybeGetExtractPool(batchSize: number): ExtractPool | null {
    if (batchSize < IndexingPipeline.WORKER_THRESHOLD) return null;
    if (process.env.TRACE_MCP_WORKERS === '0') return null;
    // Pool was injected by the daemon — reuse without reconstructing.
    if (this._extractPool && !this._poolIsOwned) {
      return this._extractPool.available ? this._extractPool : null;
    }
    if (!this._extractPool) {
      this._extractPool = new ExtractPool();
      this._poolIsOwned = true;
      if (!this._extractPool.available) {
        logger.debug(
          'Extract worker pool unavailable in this runtime — using in-process extraction',
        );
      }
    }
    return this._extractPool.available ? this._extractPool : null;
  }

  /** Shut down the worker pool. Safe to call repeatedly. Pools that were
   *  injected (daemon-shared) are NOT terminated here — the daemon owns them.
   *
   *  Also clears the TaskDag's idempotency cache when it is owned by this
   *  pipeline (in-memory default). Injected caches (e.g. `SqliteTaskCache`)
   *  belong to the caller and are left untouched — closing the underlying
   *  database is the caller's responsibility. */
  async dispose(): Promise<void> {
    this._disposed = true;
    // Drop any pending deferred reconcile — it must never fire against a
    // torn-down store (daemon stopProject closes the DB right after this).
    if (this._reconcileTimer) {
      clearTimeout(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    if (this._extractPool && this._poolIsOwned) {
      await this._extractPool.terminate();
    }
    this._extractPool = undefined;
    if (!this._taskCacheIsExternal) {
      this._dag.clearCache();
    }
  }

  private async collectFiles(): Promise<string[]> {
    const traceignoreIgnore = this._traceignore?.toFastGlobIgnore() ?? [];
    // Most-specific registered project owns a path: skip files that live under a
    // registered descendant so an umbrella root doesn't index its child repos
    // into a second DB (the double-index churn behind #209).
    const ignore = [
      ...this.config.exclude,
      ...traceignoreIgnore,
      ...descendantExcludeGlobs(this.rootPath),
    ];

    // suppressErrors: a path component that matches a directory-shaped glob
    // but is actually a file (e.g. a stray `<ws>/test` FILE meeting the
    // `test/**` include) made fast-glob throw ENOTDIR and abort the whole
    // initial index, bricking the project in 'error' state. Traversal errors
    // (ENOTDIR/EACCES/ELOOP) must skip the entry, not kill indexing.
    let entries = await fg(this.config.include, {
      cwd: this.rootPath,
      ignore,
      dot: false,
      absolute: false,
      onlyFiles: true,
      suppressErrors: true,
    });

    // Monorepo / folder-of-projects: the directory-rooted include globs
    // (src/**, app/**, routes/**, ...) only match at the container root, so
    // nested subprojects are missed (e.g. `the/15carats/15carats-laravel/routes`).
    // When workspaces are detected, also discover files with those patterns
    // anchored to each workspace. Global `**/...` patterns already span the whole
    // tree, so only re-anchor the directory-rooted ones. This is deterministic
    // and complete — unlike the entries===0 deep-glob fallback below, which never
    // fires when a root-level file (a stray README, a `**/*.md`) matched first.
    if (this.workspaces.length > 0) {
      const rooted = this.config.include.filter((p) => !p.startsWith('**/'));
      if (rooted.length > 0) {
        const wsPatterns = this.workspaces.flatMap((ws) => rooted.map((p) => `${ws.path}/${p}`));
        const wsEntries = await fg(wsPatterns, {
          cwd: this.rootPath,
          ignore,
          dot: false,
          absolute: false,
          onlyFiles: true,
          suppressErrors: true,
        });
        if (wsEntries.length > 0) {
          const merged = new Set(entries);
          for (const e of wsEntries) merged.add(e);
          entries = [...merged];
        }
      }
    }

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
          suppressErrors: true,
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
