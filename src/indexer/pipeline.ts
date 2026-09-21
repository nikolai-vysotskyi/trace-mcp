import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type { TraceMcpConfig } from '../config.js';
import { disableBulkMode, enableBulkMode } from '../db/schema.js';
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
import { invalidateTreeCacheFile } from '../parser/tree-cache.js';
import { captureGraphSnapshots } from '../tools/analysis/history.js';
import { runInOwnTurn, yieldToEventLoopFair } from '../utils/event-loop.js';
import { beginReindex } from './reindex-inflight.js';
import { safeGitEnv } from '../utils/git-env.js';
import { initContentHasher } from '../util/hash.js';
import { descendantExcludeGlobs } from '../registry.js';
import { GitignoreMatcher } from '../utils/gitignore.js';
import { validatePath } from '../utils/security.js';
import { TraceignoreMatcher } from '../utils/traceignore.js';
import { EdgeResolver } from './edge-resolver.js';
import { EnvIndexer } from './env-indexer.js';
import { ExtractPool, resolveWorkerThreshold } from './extract-pool.js';
import { collectFiles as collectFilesImpl, type CollectFilesResult } from './file-collector.js';
import {
  type DiscoverIncrementalArgs,
  type DiscoveryResult,
  META_LAST_FULL_MS,
  META_RUNS_SINCE_FULL,
  type QueryGitStatusFn,
  discoverIncrementalFiles,
  queryGitStatus,
  shouldForceFullWalk,
  snapshotPathForDb,
  writeWatcherSnapshot,
} from './incremental-discovery.js';
import { extractAndPersist as extractAndPersistImpl } from './extract-and-persist.js';
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
   * Set when the opening walk hit `security.max_files` and the file list was
   * cut to the cap (TRA-1664). The index is permanently partial until the cap
   * is raised and a full reindex runs — callers must surface this (stats →
   * UI banner) instead of reporting a whole index. `found` is the pre-cap
   * match count, `limit` the cap that was applied.
   */
  truncated?: { found: number; limit: number };
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

/**
 * Thrown when an indexing run observes its `AbortSignal` at a phase/batch
 * boundary and stops early (TRA-1017). Re-exported here so callers can keep
 * importing it from the pipeline module; defined in `./index-abort.js` to
 * avoid a circular import with `extract-and-persist.ts`.
 */
import { IndexAbortedError, throwIfIndexAborted } from './index-abort.js';
export { IndexAbortedError, throwIfIndexAborted };

/** Options for `IndexingPipeline.indexAll`. */
export interface IndexAllOptions {
  postprocess?: PostprocessLevel;
  discovery?: 'auto' | 'full-walk';
  /**
   * Cooperative cancellation (TRA-1017). Checked at batch and phase
   * boundaries — a run stops at the next boundary after abort, never
   * mid-transaction. Aborting rejects with `IndexAbortedError`.
   */
  signal?: AbortSignal;
}

/**
 * Bound for `dispose()`'s drain of in-flight pipeline work (TRA-1017).
 *
 * Sized against the daemon's 20s shutdown deadline (`DAEMON_SHUTDOWN_DEADLINE_MS`):
 * `stopProject()` already spends up to `REINDEX_DRAIN_TIMEOUT_MS` (5s) on the
 * reindex drain plus up to `STOP_PROJECT_INDEX_WAIT_MS` (8s) on the initial
 * index, so 5s here keeps the worst sequential path at 18s with margin left
 * for the synchronous closes and `httpServer.close()`.
 */
export const PIPELINE_DISPOSE_DRAIN_MS = 5_000;

/**
 * `repo_metadata` key marking a run that mutated the index without completing
 * edge resolution (TRA-1017).
 *
 * File persistence updates content hashes and drops the files' old edges
 * BEFORE edge resolution runs. A run cancelled (or crashed) in between leaves
 * an index whose hashes say "current" but whose graph is missing edges — and
 * the next run's zero-change shortcuts (`tryIncrementalDiscovery`,
 * `canSkipFullPostprocess`) would then bless that incomplete graph as
 * up-to-date forever. While this marker is set, `indexAll()` forces a full
 * walk with full-scope resolution instead of trusting the shortcuts; the
 * marker is cleared only after a resolution actually completes.
 */
const POSTPROCESS_INCOMPLETE_KEY = 'postprocess_incomplete';

/** A full rebuild that drops more than this fraction of symbols or edges
 * triggers a shrink warning. Tuned to catch real regressions without firing
 * on legitimate large refactors. */
const SHRINK_THRESHOLD = 0.5;
/** Below this absolute symbol count the shrink check is skipped — empty /
 * tiny indexes naturally fluctuate. */
const SHRINK_MIN_BASELINE = 200;

/**
 * Repo-metadata keys stamping the last full walk's `security.max_files`
 * truncation (TRA-1664). `index_truncated` is `'1'` when the walk was cut to
 * the cap, `'0'` after a walk that fit; the `found`/`limit` companions are
 * only meaningful while it reads `'1'`. Persisted (not just returned on
 * `IndexingResult`) so stats/UI keep reporting "index partial" across daemon
 * restarts that take the incremental fast path and never re-walk the tree.
 */
export const META_INDEX_TRUNCATED = 'index_truncated';
export const META_INDEX_TRUNCATED_FOUND = 'index_truncated_found';
export const META_INDEX_TRUNCATED_LIMIT = 'index_truncated_limit';

/**
 * TRA-1543: repo_metadata key stamping the last completed ANALYZE, backing
 * the throttle on the indexAll walk path (see `maybeAnalyze`). Advisory
 * planner statistics — staleness risks a worse plan, never wrong results.
 */
export const META_LAST_ANALYZE_MS = 'last_analyze_ms';
/** Minimum gap between two ANALYZE runs on the indexAll walk path. */
export const ANALYZE_THROTTLE_MS = 10 * 60_000;

/**
 * TRA-1543: repo_metadata key persisting the workspace→plugin detection
 * (`{ fingerprint, map }` JSON). Fresh pipeline instances (CLI one-shots,
 * the bench harness, daemon restarts) reload it instead of re-detecting
 * ~44 workspaces × ~100 plugins; the manifest gate in runPipeline decides
 * whether the persisted answer is still valid.
 */
export const META_WS_PLUGINS = 'ws_framework_plugins';

/**
 * TRA-1543: file basenames whose creation, deletion or modification can
 * change framework detection (workspace markers from monorepo.ts plus the
 * manifests plugin `detect()` implementations read). An incremental run
 * whose scope touches none of these cannot change the detection outcome, so
 * the previous run's workspace→plugin map is reused instead of re-detecting
 * ~44 workspaces × ~100 plugins. Over-approximated on purpose: an unknown
 * manifest fails the gate (re-detect, a few ms wasted), never skips it.
 */
const FRAMEWORK_MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'composer.json',
  'go.mod',
  'go.sum',
  'cargo.toml',
  'cargo.lock',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'gemfile',
  'gemfile.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'mix.exs',
  'pubspec.yaml',
  'package.swift',
  'cmakelists.txt',
  'dockerfile',
  'docker-compose.yml',
  'compose.yml',
]);

/** Case-insensitive basename check against the manifest set above. */
export function isFrameworkManifestBasename(base: string): boolean {
  const lower = base.toLowerCase();
  if (FRAMEWORK_MANIFEST_BASENAMES.has(lower)) return true;
  // requirements.txt / requirements-dev.txt / Dockerfile.* / docker-compose.*.yml
  if (lower === 'requirements.txt' || lower.startsWith('requirements-')) return true;
  if (lower.startsWith('dockerfile.')) return true;
  if (lower.startsWith('docker-compose.') || lower.startsWith('compose.')) return true;
  return false;
}

/**
 * Read the persisted max_files truncation stamp. Returns null when the last
 * full walk fit under the cap (or predates the stamp) — the index covers the
 * whole tree as far as the walker knows.
 */
export function readIndexTruncation(store: Store): { found: number; limit: number } | null {
  try {
    if (store.getRepoMetadata(META_INDEX_TRUNCATED) !== '1') return null;
    const found = Number.parseInt(store.getRepoMetadata(META_INDEX_TRUNCATED_FOUND) ?? '', 10);
    const limit = Number.parseInt(store.getRepoMetadata(META_INDEX_TRUNCATED_LIMIT) ?? '', 10);
    if (!Number.isFinite(found) || !Number.isFinite(limit) || found <= 0 || limit <= 0) return null;
    return { found, limit };
  } catch {
    return null;
  }
}

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

/** Content hashes that mark synthetic `files` rows minted by edge resolution
 *  for external packages. They have no path on disk, so a scope reconcile must
 *  never mistake them for stale rows. */
const PHANTOM_CONTENT_HASHES = new Set(['__phantom__', '__phantom_pkg__']);

/** The subset of a `FileRow` the scope reconcile needs to judge a row. */
export interface ReconcilableFileRow {
  id: number;
  path: string;
  language: string | null;
  content_hash: string | null;
}

/**
 * Pick the `files` rows a full reindex must delete: those the current walk no
 * longer considers in scope.
 *
 * Indexing is otherwise upsert-only — `insertFile` does `ON CONFLICT DO UPDATE`
 * and nothing ever removes what a previous run wrote. So every path any past
 * version once walked stays in the index and in search results forever, even
 * after the walker stopped visiting it: excluded dirs, vendored trees, a
 * `.gitignore` rule added later. TRA-468 found a project where 93% of the
 * symbol index came from git-ignored vendored code the current indexer walks
 * right past, with a `lastIndexed` timestamp from the run that touched 10% of
 * the rows.
 *
 * Rows kept regardless of scope:
 *   - phantom/external package rows (no on-disk path by construction);
 *   - `.env` rows, which `EnvIndexer` writes on its own pass after this one.
 *
 * Refuses to act on a scope it cannot trust — an empty walk (glob failure,
 * unreadable root) or one truncated at `security.max_files`, where "not in
 * scope" only means "past the cap".
 */
export function selectOutOfScopeFiles(args: {
  files: ReconcilableFileRow[];
  /** Repo-relative POSIX paths the current walk found. */
  inScope: string[];
  /** True when the walk hit `security.max_files` and was cut short. */
  truncated: boolean;
}): number[] {
  const { files, inScope, truncated } = args;
  if (truncated || inScope.length === 0) return [];
  const keep = new Set(inScope.map((p) => p.split(path.sep).join('/')));
  return files
    .filter(
      (f) =>
        !keep.has(f.path.split(path.sep).join('/')) &&
        f.language !== 'env' &&
        !PHANTOM_CONTENT_HASHES.has(f.content_hash ?? ''),
    )
    .map((f) => f.id);
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
  /**
   * Debounce window (ms) before the deferred coverage reconcile fires after
   * incremental churn. Production callers leave this undefined (60s default);
   * tests inject a huge value and flush explicitly.
   */
  coverageReconcileDebounceMs?: number;
  /**
   * TRA-1576: seam for incremental discovery in `indexAll`. Production
   * callers leave this undefined (real watcher-since → git-status → walk).
   * Tests inject a fake `discover` and/or a `snapshotPath` override
   * (including explicit null to disable the watcher source).
   */
  incrementalDiscovery?: {
    discover?: (args: DiscoverIncrementalArgs) => Promise<DiscoveryResult>;
    snapshotPath?: string | null;
    /**
     * Second opinion when the watcher source reports zero changes (see
     * `tryIncrementalDiscovery`). Defaults to the real git-status query;
     * tests inject fakes or null to disable.
     */
    queryGit?: QueryGitStatusFn | null;
  } | null;
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
    if (deps?.coverageReconcileDebounceMs !== undefined) {
      this._coverageDebounceMs = deps.coverageReconcileDebounceMs;
    }
    if (deps?.incrementalDiscovery !== undefined) {
      this._incrementalDiscovery = deps.incrementalDiscovery;
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
  /**
   * TRA-1543: workspace→plugin detection, shared by registration, extraction
   * and resolution within a run (was detected 3× per run) and reused across
   * incremental runs whose scope cannot change it (see canReuseWorkspacePlugins).
   * Keyed by workspace signature; force/full runs always re-detect.
   */
  private _wsFrameworkPlugins: Map<string, FrameworkPlugin[]> | null = null;
  private _wsFrameworkPluginsKey: string | null = null;
  /**
   * Set when the runPipeline gate fails (manifest in scope / force / full
   * run): the next getWorkspaceFrameworkPlugins must detect fresh and
   * re-persist, NOT reload the persisted map the gate just invalidated.
   */
  private _wsPluginsForceRedetect = false;
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
  /** TRA-1541: whether the last Pass 1 took the FTS rebuild path (no ANALYZE). Read by indexFiles. */
  private _lastUsedFtsRebuild = false;
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

  /**
   * Top-level directories under the project root skipped by default ignore
   * rules (built-in skip dirs, `ignore.directories` config, `.traceignore`).
   * Only meaningful after `indexAll()` has run at least once, since that's
   * when `_traceignore` is built.
   */
  getSkippedTopLevelDirs(): string[] {
    return this._traceignore?.getSkippedTopLevelDirs(this.rootPath) ?? [];
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
      wsFrameworkPlugins: this.getWorkspaceFrameworkPlugins(),
    };
  }

  async indexAll(force?: boolean, opts: IndexAllOptions = {}): Promise<IndexingResult> {
    // TRA-1763: hold the in-flight mark from enqueue to settle (queue wait +
    // work), so ready-state full walks (drops/storm full-walk, forced reindex)
    // show up in `projects_indexing`. Released on settle either way; the
    // release is idempotent and `_lock` never rejects, so this cannot leak.
    // Nested marks (e.g. the `reindex` tool already holding one) only bump
    // the per-project refcount, not the distinct-project count.
    const endReindex = beginReindex(this.rootPath);
    const result = this._lock.then(async () => {
      // TRA-1017: observe a stop request before doing any work — the warm
      // incremental-discovery fast path below would otherwise persist
      // discovered changes after the stop was asked for.
      throwIfIndexAborted(opts.signal, this.rootPath);
      this._isIncremental = false;
      this._postprocessLevel = opts.postprocess ?? 'full';
      const start = Date.now();
      // TRA-1715: the root may have vanished since this run was scheduled
      // (a finished task's workdir removed, a volume unmounted). A full
      // walk of a missing root resolves to zero files, and reconcileScope
      // would then drop EVERY indexed row — destroying a healthy index for
      // what may be a transient condition — while the extractor logs one
      // `Cannot read file` per previously-known file. Bail out before any
      // of that: the stored index stays as-is until the root comes back or
      // the project is deregistered/unloaded. Inside the lock so concurrent
      // runs still serialize on this verdict.
      if (!fs.existsSync(this.rootPath)) {
        logger.warn(
          { root: this.rootPath },
          'Skipping index — project root no longer exists on disk',
        );
        return {
          totalFiles: 0,
          indexed: 0,
          skipped: 0,
          errors: 0,
          durationMs: Date.now() - start,
          incremental: false,
          postprocess: this._postprocessLevel,
        } satisfies IndexingResult;
      }
      // Snapshot the existing index size so runPipeline can detect a
      // catastrophic shrink (e.g. parser regression dropping half the files
      // silently). Skip when:
      //   - force=true: caller has acknowledged the risk
      //   - postprocess=none: edge resolution is skipped by design, so an
      //     N→0 edge ratio after the run is expected and a `shrinkWarning`
      //     would be a false positive that automated quality gates would
      //     misinterpret as a regression.
      const skipShrinkCheck = force === true || this._postprocessLevel === 'none';
      if (this.config.children?.length) {
        this.workspaces = buildMultiRootWorkspaces(this.rootPath, this.config.children);
        logger.info({ workspaces: this.workspaces.map((w) => w.name) }, 'Multi-root workspaces');
      } else {
        this.workspaces = detectWorkspaces(this.rootPath);
        if (this.workspaces.length > 0) {
          logger.info({ workspaces: this.workspaces.map((w) => w.name) }, 'Detected workspaces');
        }
      }
      // Read BEFORE reconcileScope: an index whose every row went out of scope
      // is still a live DB other connections may be reading, not a fresh one.
      const isFromScratch = (() => {
        try {
          return this.store.getStats().totalSymbols === 0;
        } catch {
          return false;
        }
      })();
      // TRA-1576: non-force reindex of a live index tries the incremental
      // discovery fast paths (watcher since-query → git status) BEFORE the
      // full walk below. From-scratch, force, and dropped-events reconcile
      // (`discovery: 'full-walk'`) always walk: only a full walk reconciles
      // scope and (for scratch) engages bulk-load mode.
      // TRA-1017: a previous run that mutated without resolving leaves the
      // marker behind — its hashes say "current" while edges are missing, so
      // the fast path's zero-change verdict cannot be trusted. Walk and
      // re-resolve instead; runPipeline clears the marker once it does.
      if (
        !force &&
        opts.discovery !== 'full-walk' &&
        !isFromScratch &&
        !this.isPostprocessIncomplete()
      ) {
        const fast = await this.tryIncrementalDiscovery(start, opts.signal);
        if (fast) return fast;
      }
      const collected = await this.collectFiles();
      // TRA-1017: bail before touching the index when a stop arrived during
      // the walk — reconcileScope below deletes rows, so aborting after it
      // would leave a half-reconciled tree for the next run to repair.
      throwIfIndexAborted(opts.signal, this.rootPath);
      // TRA-1017: mark before the first mutation. reconcileScope deletes
      // out-of-scope rows and extractAndPersist rewrites hashes/edges; if the
      // run never reaches resolution, this marker forces the next run to
      // re-resolve instead of trusting the shortcuts. Cleared by runPipeline
      // only after a resolution actually completes. Skipped for
      // postprocess='none' runs: their unresolved graph is the caller's
      // explicit contract (`reindex` tool), not an interruption to repair.
      if (this._postprocessLevel !== 'none') this.markPostprocessIncomplete();
      const filePaths = collected.files;
      // Reconcile before snapshotting: dropping rows the walk no longer owns is
      // the intended outcome here, not the parser regression `checkShrink`
      // hunts for. Repairing an index that was 93% stale would otherwise raise
      // a shrink warning on the very run that fixed it.
      this.reconcileScope(filePaths, collected.truncated);
      const before = skipShrinkCheck ? null : this.captureSizeSnapshot();
      // Bulk-load mode (synchronous=OFF, foreign_keys=OFF) only for genuine
      // from-scratch indexes — never on a live daemon whose DB other
      // connections may still read (a crash with synchronous=OFF corrupts).
      if (isFromScratch) {
        logger.info('Engaging bulk-load mode for from-scratch index');
        enableBulkMode(this.store.db);
      }
      let r: IndexingResult;
      try {
        r = await this.runPipeline(filePaths, force ?? false, start, opts.signal);
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
      // TRA-1664: the walk was cut at security.max_files — the index is
      // partial by construction. Flag the result for immediate callers and
      // stamp repo metadata so stats/UI keep reporting it after restarts
      // that take the incremental fast path (which never re-walks the tree).
      if (collected.truncated) {
        r.truncated = { found: collected.found, limit: collected.limit };
      }
      this.stampTruncationMetadata(collected);
      if (before) this.checkShrink(before, r);
      // Non-bulk path: refresh planner statistics so subsequent queries pick
      // indices using real cardinality rather than fallback heuristics.
      // Skipped on the bulk path because disableBulkMode already ran ANALYZE.
      //
      // TRA-1543: throttled — ANALYZE is advisory (stale stats only risk a
      // worse query plan, never wrong results) and cost ~24 ms on every
      // full-walk indexAll, including zero-change verification walks. The
      // incremental fast path never paid it (runDiscovered bypasses this
      // block); now the walk path pays it at most once per ANALYZE_THROTTLE_MS
      // instead of once per run. Bulk-index stamp (below) joins the same
      // budget so a fresh index doesn't re-ANALYZE on the next walk.
      if (!isFromScratch) {
        this.maybeAnalyze();
      } else {
        this.stampAnalyzeComplete();
      }
      // TRA-1576: a full walk re-verified the whole tree — reset the
      // periodic-verification counters and refresh the watcher snapshot so
      // the next since-query window starts here. Awaited: the snapshot
      // timestamp MUST predate any change the next run must see — a
      // fire-and-forget write can land after a subsequent touch, making the
      // next since-query report empty (a silent zero-change miss).
      await this.markFullWalkComplete();
      return r;
    });
    this._lock = result.catch(() => {});
    void result.then(endReindex, endReindex);
    return result as Promise<IndexingResult>;
  }

  /**
   * TRA-1576 — incremental discovery for `indexAll` on a live index.
   *
   * Returns a completed `IndexingResult` when a fast path (watcher
   * since-query, git status) supplied the changed set, or null when the
   * caller must do the full `collectFiles()` walk (no source answered, or
   * the periodic-verification policy demands a re-verifying walk).
   *
   * Fast-path runs never reconcile scope — they know nothing about the
   * rest of the tree — and never shrink-check: `totalFiles` covers only
   * the changed set, so a whole-tree size comparison is meaningless.
   * Deletions reported by the source are applied via `deleteFiles()`
   * before extraction. The zero-change case returns before `runPipeline`
   * (no PageRank/search-cache invalidation — the TRA-935 early-return
   * philosophy applied to `indexAll`).
   */
  private async tryIncrementalDiscovery(
    startMs: number,
    signal?: AbortSignal,
  ): Promise<IndexingResult | null> {
    const { runsSinceFull, lastFullMs } = this.readDiscoveryCounters();
    if (shouldForceFullWalk({ runsSinceFull, lastFullMs })) {
      logger.debug({ runsSinceFull, lastFullMs }, 'Incremental discovery: periodic full walk due');
      return null;
    }
    const injected = this._incrementalDiscovery;
    const snapshotPath =
      injected?.snapshotPath !== undefined ? injected.snapshotPath : this.defaultSnapshotPath();
    let discovery: DiscoveryResult;
    try {
      const discover = injected?.discover ?? discoverIncrementalFiles;
      discovery = await discover({
        rootPath: this.rootPath,
        snapshotPath,
        include: this.config.include,
        watcherIgnore: this.nativeWatcherIgnore(),
      });
    } catch (err) {
      logger.debug({ err }, 'Incremental discovery threw — full walk');
      return null;
    }
    // TRA-1017: the discovery answer arrived after awaits — a stop may have
    // been asked for while it was computed. Applying it would persist changes
    // past the stop; fall through to the full walk (which checks again)
    // instead. The walk also re-verifies, so nothing is lost.
    throwIfIndexAborted(signal, this.rootPath);
    if (discovery.source === 'full-walk') return null;
    return this.runDiscovered(discovery, startMs, snapshotPath, signal);
  }

  /**
   * Apply one discovery answer: gate its paths, run the pipeline over the
   * survivors, or take the zero-change early return. Split out of
   * `tryIncrementalDiscovery` so the git second-opinion (below) reuses the
   * same path instead of duplicating it.
   */
  private async runDiscovered(
    discovery: DiscoveryResult,
    startMs: number,
    snapshotPath: string | null,
    signal?: AbortSignal,
  ): Promise<IndexingResult> {
    // TRA-1017: never apply a discovery answer past a stop request.
    throwIfIndexAborted(signal, this.rootPath);
    const injected = this._incrementalDiscovery;
    // The source speaks in tree paths; the pipeline speaks in
    // include-matched, exclude-filtered rel-posix paths. `discover` already
    // intersected with `include`; re-apply the exclude/gitignore/descendant
    // gates (they can change between runs) and drop entries that resolve
    // outside the root or no longer exist (mis-rooted git output under a
    // non-default `status.relativePaths`, or a file deleted after listing).
    const changed = this.filterIndexablePaths(discovery.changed).filter((rel) => {
      try {
        return fs.statSync(path.resolve(this.rootPath, rel)).isFile();
      } catch {
        return false;
      }
    });
    // Deletes are passed through un-gated (the file is gone — include
    // matching is meaningless); `deleteFiles` no-ops rows it never owned.
    // Keep only in-root paths so a mis-rooted source can't traverse.
    const deleted = discovery.deleted.filter((rel) => {
      const check = validatePath(rel, this.rootPath);
      return check.isOk();
    });
    if (changed.length === 0 && deleted.length === 0) {
      // Trust-but-verify: an empty watcher answer is only as fresh as the
      // snapshot write that bounds it. A snapshot that raced ahead of a
      // touch (unawaited write, cross-process interleave) reports empty
      // while the tree is dirty — a silent miss. When this is a git repo,
      // one `git status` (~10-30 ms, cheap exactly when clean) is the
      // second opinion; a disagreement re-enters below with git's lists.
      if (discovery.source === 'watcher-since') {
        const queryGit = injected?.queryGit !== undefined ? injected.queryGit : queryGitStatus;
        let second: { changed: string[]; deleted: string[] } | null = null;
        try {
          second = queryGit?.(this.rootPath) ?? null;
        } catch {
          second = null;
        }
        if (second && (second.changed.length > 0 || second.deleted.length > 0)) {
          logger.warn(
            { changed: second.changed.length, deleted: second.deleted.length },
            'Incremental discovery: watcher reported zero changes but git disagrees — using git lists',
          );
          return this.runDiscovered(
            { source: 'git-status', changed: second.changed, deleted: second.deleted },
            startMs,
            snapshotPath,
            signal,
          );
        }
      }
      await this.afterDiscoveryRun(snapshotPath);
      logger.debug(
        { source: discovery.source },
        'Incremental discovery: zero changes — skipping pipeline',
      );
      // runPipeline's finally block is skipped on this path, but its global
      // cache invalidation is a contract callers rely on ("reindex ⇒ fresh
      // reads" — e.g. rows written outside the pipeline become visible).
      // The per-run maps are already empty; only the shared caches need it.
      invalidatePageRankCache();
      invalidateSearchCache(this.store.db);
      return {
        totalFiles: 0,
        indexed: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startMs,
        incremental: true,
        postprocess: this._postprocessLevel,
      };
    }

    this._isIncremental = true;
    // A prior indexAll left this set; fast runs never reconcile scope, so a
    // stale count would wrongly force edge resolution in runPipeline.
    this._scopeRowsRemoved = 0;
    // TRA-1017: deletes mutate the index — check before them, and mark the
    // run incomplete first so an abort between the deletes and runPipeline's
    // own entry mark still forces a repair pass next time.
    throwIfIndexAborted(signal, this.rootPath);
    if (deleted.length > 0) {
      this.markPostprocessIncomplete();
      this.deleteFiles(deleted);
    }
    const r = await this.runPipeline(changed, false, startMs, signal);
    await this.afterDiscoveryRun(snapshotPath);
    logger.info(
      { source: discovery.source, changed: changed.length, deleted: deleted.length },
      'Incremental discovery fast path used instead of full walk',
    );
    return r;
  }

  /** Snapshot path for the watcher since-query, or null for `:memory:` DBs. */
  private defaultSnapshotPath(): string | null {
    try {
      const name = (this.store.db as unknown as { name?: unknown }).name;
      if (typeof name !== 'string' || name === '' || name === ':memory:') return null;
      return snapshotPathForDb(name);
    } catch {
      return null;
    }
  }

  /** Native-layer ignore list, mirroring `watcher.subscribe`'s. */
  private nativeWatcherIgnore(): string[] {
    const traceignore = new TraceignoreMatcher(this.rootPath, this.config.ignore);
    const skipDirs = [...traceignore.getSkipDirs()];
    return [
      ...skipDirs.map((d) => path.join(this.rootPath, d)),
      ...skipDirs.map((d) => `**/${d}/**`),
      ...(this.config.exclude ?? []),
      ...descendantExcludeGlobs(this.rootPath),
    ];
  }

  private readDiscoveryCounters(): { runsSinceFull: number; lastFullMs: number | null } {
    let runsSinceFull = 0;
    let lastFullMs: number | null = null;
    try {
      const runsRaw = this.store.getRepoMetadata(META_RUNS_SINCE_FULL);
      if (runsRaw != null) {
        const n = Number.parseInt(runsRaw, 10);
        if (Number.isFinite(n) && n >= 0) runsSinceFull = n;
      }
      const lastRaw = this.store.getRepoMetadata(META_LAST_FULL_MS);
      if (lastRaw != null) {
        const t = Number.parseInt(lastRaw, 10);
        if (Number.isFinite(t) && t > 0) lastFullMs = t;
      }
    } catch {
      /* best-effort — a metadata miss just means "verify soon" */
    }
    return { runsSinceFull, lastFullMs };
  }

  /**
   * TRA-1543: run ANALYZE unless one completed within ANALYZE_THROTTLE_MS.
   * The indexAll walk path used to pay ~24 ms per run; planner statistics go
   * stale gracefully, so a 10-minute budget is plenty. Non-fatal by contract.
   */
  private maybeAnalyze(): void {
    let last: number | null = null;
    try {
      const raw = this.store.getRepoMetadata(META_LAST_ANALYZE_MS);
      if (raw != null) {
        const t = Number.parseInt(raw, 10);
        if (Number.isFinite(t) && t > 0) last = t;
      }
    } catch {
      /* best-effort — a metadata miss just means "analyze now" */
    }
    if (last != null && Date.now() - last < ANALYZE_THROTTLE_MS) {
      logger.debug({ lastAnalyzeMs: last }, 'ANALYZE throttled — recent enough');
      return;
    }
    try {
      this.store.db.exec('ANALYZE');
    } catch (err) {
      logger.debug({ err }, 'ANALYZE failed after indexAll (non-fatal)');
      return;
    }
    this.stampAnalyzeComplete();
  }

  /** Record a completed ANALYZE (bulk or throttled-walk path) for the throttle. */
  private stampAnalyzeComplete(): void {
    try {
      this.store.setRepoMetadata(META_LAST_ANALYZE_MS, String(Date.now()));
    } catch {
      /* best-effort */
    }
  }

  /** TRA-1576: bookkeeping after a verifying full walk. */
  private async markFullWalkComplete(): Promise<void> {
    try {
      this.store.setRepoMetadata(META_RUNS_SINCE_FULL, '0');
      this.store.setRepoMetadata(META_LAST_FULL_MS, String(Date.now()));
    } catch {
      /* best-effort */
    }
    const snapshotPath =
      this._incrementalDiscovery?.snapshotPath !== undefined
        ? this._incrementalDiscovery.snapshotPath
        : this.defaultSnapshotPath();
    if (snapshotPath) {
      await writeWatcherSnapshot(this.rootPath, snapshotPath, this.nativeWatcherIgnore());
    }
  }

  /** TRA-1576: bookkeeping after a fast-path run (snapshot refresh + verify countdown). */
  private async afterDiscoveryRun(snapshotPath: string | null): Promise<void> {
    const { runsSinceFull } = this.readDiscoveryCounters();
    try {
      this.store.setRepoMetadata(META_RUNS_SINCE_FULL, String(runsSinceFull + 1));
    } catch {
      /* best-effort */
    }
    if (snapshotPath) {
      await writeWatcherSnapshot(this.rootPath, snapshotPath, this.nativeWatcherIgnore());
    }
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

  /** Rows dropped by the last `reconcileScope` — see its use in `runPipeline`. */
  private _scopeRowsRemoved = 0;

  /**
   * Delete `files` rows (and their symbols/edges/entities) that the current
   * walk no longer owns. Full reindex only — the incremental path is handed a
   * few paths and knows nothing about the rest of the tree.
   *
   * This is also the repair path for an index poisoned by an older version:
   * the daemon runs `indexAll` per project on start, so a stale index converges
   * without any explicit `trace-mcp doctor --fix` step.
   */
  private reconcileScope(inScope: string[], truncated: boolean): number {
    const staleIds = selectOutOfScopeFiles({
      files: this.store.getAllFiles(),
      inScope,
      // Explicit from collectFiles (TRA-1664): inferring truncation from the
      // count misfires exactly at the cap (a walk that found precisely
      // maxFiles files is whole, not cut) and hides the pre-cap total.
      truncated,
    });
    this._scopeRowsRemoved = staleIds.length;
    if (staleIds.length === 0) return 0;
    this.store.db.transaction(() => {
      for (const id of staleIds) this.store.deleteFile(id);
    })();
    logger.info(
      { root: this.rootPath, removed: staleIds.length, inScope: inScope.length },
      'Dropped index rows for files no longer in scope',
    );
    return staleIds.length;
  }

  /**
   * Stamp the last full walk's max_files truncation into repo metadata
   * (TRA-1664). A walk that fit clears the flag so a previously-partial
   * index stops reporting partial after the cap is raised and a full reindex
   * runs. Best-effort: a metadata write must never fail indexing.
   */
  private stampTruncationMetadata(collected: CollectFilesResult): void {
    try {
      if (collected.truncated) {
        this.store.setRepoMetadata(META_INDEX_TRUNCATED, '1');
        this.store.setRepoMetadata(META_INDEX_TRUNCATED_FOUND, String(collected.found));
        this.store.setRepoMetadata(META_INDEX_TRUNCATED_LIMIT, String(collected.limit));
      } else {
        this.store.setRepoMetadata(META_INDEX_TRUNCATED, '0');
      }
    } catch (err) {
      logger.debug({ err }, 'Truncation metadata stamp skipped (non-fatal)');
    }
  }

  deleteFiles(filePaths: string[]): void {
    if (filePaths.length === 0) return;
    // TRA-1553, last resort: stopProject() closes the DB on a bounded drain,
    // so a delete landing after the close must not throw "The database
    // connection is not open" from inside an async continuation as an
    // unhandled rejection. Skipping is safe — the next full indexAll
    // reconciles scope and drops the rows then.
    if (!this.store.db.open) {
      logger.warn(
        { root: this.rootPath, files: filePaths.length },
        'deleteFiles skipped — database already closed',
      );
      return;
    }
    // TRA-1577: drop per-file tree-sitter cache entries alongside the DB rows
    // so a deleted path can't serve a stale incremental base on re-creation,
    // and its WASM trees are freed instead of lingering to LRU eviction.
    for (const fp of filePaths) {
      const rel = path.isAbsolute(fp) ? path.relative(this.rootPath, fp) : fp;
      invalidateTreeCacheFile(this.rootPath, rel.split(path.sep).join('/'));
    }
    this.store.db.transaction(() => {
      for (const fp of filePaths) {
        const rel = path.isAbsolute(fp) ? path.relative(this.rootPath, fp) : fp;
        // Store paths are always posix-separated (collectFiles() via
        // fast-glob) — an unconverted backslash on Windows misses the row
        // entirely, silently no-op'ing the delete (TRA-1045).
        const relPath = rel.split(path.sep).join('/');
        const file = this.store.getFile(relPath);
        if (file) {
          this.store.deleteFile(file.id);
          logger.info({ file: relPath }, 'Deleted file from index');
        }
      }
    })();
  }

  /**
   * Drop the paths an incremental run must not touch: traversal attempts,
   * `config.exclude` matches, subtrees owned by a more-specific registered
   * project, and git-ignored files. Mirrors the gates `collectFiles()`
   * applies to the full walk, so the event-driven entry points (watcher,
   * hooks, `register_edit`, the HTTP reindex endpoint) can't re-add rows the
   * full walk excludes (TRA-468).
   *
   * Pure — no DB, no lock. That is what lets `indexFiles()` decide a batch is
   * a no-op before it queues behind the pipeline lock (TRA-935). Touches the
   * filesystem (one stat per path) but never the database.
   */
  private filterIndexablePaths(filePaths: string[]): string[] {
    // Same exclude gate collectFiles() applies via fast-glob. Without it,
    // event-driven entry points index runtime churn the full pipeline would
    // never touch — e.g. Laravel storage/framework/sessions blobs arriving on
    // every web request.
    const isExcluded = this.getExcludeMatcher();
    // A registered descendant owns its own subtree — drop its files so an
    // umbrella root's watcher-driven reindex is a no-op instead of a second,
    // umbrella-wide edge reconcile (the daemon-starvation cause behind #209).
    const descendantGlobs = descendantExcludeGlobs(this.rootPath);
    const ownedByDescendant = descendantGlobs.length
      ? picomatch(descendantGlobs, { dot: true })
      : undefined;
    const gitignore = this.gitignoreMatcher();
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
      if (gitignore?.isIgnored(relPosix)) {
        logger.debug({ file: rel }, 'Git-ignored path skipped in indexFiles');
        continue;
      }
      // TRA-1649: the watcher enqueues directory paths (mkdir/create events
      // for `.multica`, `.opencode/skills/...`, etc.). Dropping them here
      // keeps them out of `totalFiles` entirely; FileExtractor keeps its own
      // isDirectory guard as a safety net for direct callers. A stat failure
      // (deleted between event and run) keeps the path so the extractor's
      // read path handles it as before.
      try {
        if (fs.statSync(path.resolve(this.rootPath, rel)).isDirectory()) {
          logger.debug({ file: rel }, 'Directory skipped in indexFiles');
          continue;
        }
      } catch {
        /* stat failed — leave the path for the extractor to handle */
      }
      // Store paths are always posix-separated (collectFiles() via
      // fast-glob) — pushing `rel` instead of `relPosix` inserted a phantom
      // duplicate file row on Windows instead of matching the existing one,
      // breaking every downstream mtime/existing-row lookup (TRA-1045).
      relPaths.push(relPosix);
    }
    return relPaths;
  }

  async indexFiles(
    filePaths: string[],
    opts: { postprocess?: PostprocessLevel; signal?: AbortSignal } = {},
  ): Promise<IndexingResult> {
    const enqueuedAt = Date.now();
    const relPaths = this.filterIndexablePaths(filePaths);

    // TRA-935: nothing survived the filters, so this run cannot change a
    // single row. Return before touching `_lock` — running the pipeline
    // anyway costs the ignore-matcher rebuilds, a scope build, and a full
    // search + PageRank cache invalidation, and (worse) queues the no-op
    // behind whatever real indexing is in flight. In one daemon log 29 925 of
    // 30 000 `reindex-file` events took this path; their reported latency was
    // lock-queue wait, which is why elapsedMs read as hours.
    if (relPaths.length === 0) {
      return {
        totalFiles: 0,
        indexed: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - enqueuedAt,
        incremental: true,
        postprocess: opts.postprocess ?? 'minimal',
      };
    }

    // TRA-1763: same mark as indexAll — every watcher/hook batch (including
    // the >200-file bulk full-pass fallback in buildChangeScope) runs at
    // `status: ready` and was invisible to `projects_indexing`. Placed after
    // the TRA-935 no-op early return so filtered-out batches stay uncounted.
    const endReindex = beginReindex(this.rootPath);
    const result = this._lock.then(async () => {
      // TRA-1017: a watcher batch queued before the stop must not start
      // persisting after it — the abort is observed here, at lock entry.
      throwIfIndexAborted(opts.signal, this.rootPath);
      this._isIncremental = true;
      // Incremental runs never reconcile scope; clear the flag a prior
      // indexAll left behind so it can't force a postprocess here.
      this._scopeRowsRemoved = 0;
      // Default to 'minimal' for incremental runs. Watcher/hook/register_edit
      // callers don't override; full postprocess (LSP + env + snapshots) was
      // the source of 3-11s outliers visible in daemon.log on single-file
      // edits. Explicit callers (the `reindex` MCP tool for indexPath param)
      // still pass 'full' explicitly when needed.
      this._postprocessLevel = opts.postprocess ?? 'minimal';
      // TRA-935: `durationMs` must be the work, not the wait. The clock starts
      // once the lock is ours, so callers can subtract it from their own
      // wall-clock to get the queue time instead of reporting the two summed
      // as reindex latency.
      const start = Date.now();
      const r = await this.runPipeline(relPaths, false, start, opts.signal);
      // The watcher/hook path only ever sees the events it was handed. Kick a
      // debounced coverage check so a project whose on-disk shape changed
      // drastically converges without an explicit forced reindex (TRA-231).
      if (r.indexed > 0) this.scheduleCoverageReconcile();
      // TRA-1541 ANALYZE discipline: indexAll refreshes planner statistics at
      // the end of every run, but this incremental path never did. Runs that
      // took the trigger-drop + rebuild path (no ANALYZE there, unlike
      // disableBulkMode) leave sqlite_stat1 describing the pre-burst graph
      // until the next full reindex — refresh here for exactly those runs.
      // Gated on the rebuild flag itself, not on indexed counts: a run with
      // many skipped/errored candidates still rebuilds. Non-fatal by contract.
      if (this._lastUsedFtsRebuild) {
        this._lastUsedFtsRebuild = false;
        try {
          this.store.db.exec('ANALYZE');
        } catch (err) {
          logger.debug({ err }, 'ANALYZE failed after indexFiles (non-fatal)');
        }
      }
      return r;
    });
    this._lock = result.catch(() => {});
    void result.then(endReindex, endReindex);
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

  /**
   * Whether a previous run mutated the index without completing edge
   * resolution (TRA-1017). Best-effort read: a closed/unreadable DB reports
   * clean so teardown-time checks can never throw.
   */
  private isPostprocessIncomplete(): boolean {
    try {
      return this.store.getRepoMetadata(POSTPROCESS_INCOMPLETE_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** Mark the index as mutated-but-unresolved (TRA-1017). Best-effort. */
  private markPostprocessIncomplete(): void {
    try {
      this.store.setRepoMetadata(POSTPROCESS_INCOMPLETE_KEY, '1');
    } catch (err) {
      logger.debug({ err }, 'markPostprocessIncomplete failed (non-fatal)');
    }
  }

  /** Clear the mutated-but-unresolved mark after a resolution completes (TRA-1017). Best-effort. */
  private clearPostprocessIncomplete(): void {
    try {
      this.store.deleteRepoMetadata(POSTPROCESS_INCOMPLETE_KEY);
    } catch (err) {
      logger.debug({ err }, 'clearPostprocessIncomplete failed (non-fatal)');
    }
  }

  private async runPipeline(
    relPaths: string[],
    force: boolean,
    startMs: number,
    signal?: AbortSignal,
  ): Promise<IndexingResult> {
    // TRA-1017: cooperative cancellation — every phase below ends at an
    // awaited boundary, so a stop request lands at the next one instead of
    // riding a 188s run to completion. The abort is checked BEFORE each
    // phase's work, never mid-transaction.
    throwIfIndexAborted(signal, this.rootPath);
    // TRA-1017: remember whether a previous run left the graph unresolved,
    // then mark this run the same way — extractAndPersist rewrites hashes and
    // drops old edges before resolution runs, so any failure/abort from here
    // on must force the next run to re-resolve. The mark is cleared below
    // only after a resolution actually completes; a run that throws keeps it.
    // postprocess='none' runs opt out both ways (see the indexAll call site).
    const wasIncomplete =
      this._postprocessLevel === 'none' ? false : this.isPostprocessIncomplete();
    if (this._postprocessLevel !== 'none') this.markPostprocessIncomplete();
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
      scope: this._isIncremental ? 'incremental' : 'full',
    });

    this._projectContext = undefined;
    // TRA-1543: drop the workspace-plugin detection unless the current scope
    // provably cannot change it (incremental run, same workspaces, no
    // manifest touched — see canReuseWorkspacePlugins). A dropped map is
    // reloaded from repo_metadata when still valid, else detected fresh.
    if (!this._isIncremental || force || !this.canReuseWorkspacePlugins(relPaths)) {
      this._wsFrameworkPlugins = null;
      this._wsPluginsForceRedetect = true;
    }
    this.registry.clearCaches();
    this._changedFileIds.clear();
    this._gitignore = new GitignoreMatcher(this.rootPath);
    // Note: `_scopeRowsRemoved` is deliberately NOT reset here — indexAll sets
    // it just before calling us and the postprocess gate below reads it. It is
    // reset by `indexFiles`, which never reconciles.
    this._traceignore = new TraceignoreMatcher(this.rootPath, this.config.ignore);
    await this.registerFrameworkEdgeTypes();

    try {
      await this.extractAndPersist(relPaths, force, result, signal);
      throwIfIndexAborted(signal, this.rootPath);
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
      //
      // TRA-1543: canSkipFullPostprocess() returns false unless indexed === 0
      // && errors === 0, so don't pay for the git HEAD spawn + getStats +
      // metadata read on every real-change run — check the cheap integers
      // first. Outcome-identical: the delegated call sees the same values.
      let skipPostprocess = false;
      if (
        this._postprocessLevel !== 'none' &&
        !force &&
        this._scopeRowsRemoved === 0 &&
        result.indexed === 0 &&
        result.errors === 0 &&
        // TRA-1017: a run that died after persisting but before resolving
        // leaves hashes saying "current" with edges missing — HEAD + content
        // still match, so this shortcut would bless the incomplete graph
        // forever. Re-resolve instead; the marker clears below once it does.
        !wasIncomplete
      ) {
        skipPostprocess = canSkipFullPostprocess({
          // A scope reconcile just deleted files (and their edges): HEAD may be
          // unchanged and extraction may have hash-skipped everything, but the
          // graph is not the one we stamped. Re-resolve.
          force: false,
          indexed: 0,
          errors: 0,
          totalEdges: this.store.getStats().totalEdges,
          currentHead: readGitHeadSha(this.rootPath),
          storedHead: this.store.getRepoMetadata('index_head_sha'),
        });
      }
      if (skipPostprocess) {
        logger.info(
          { root: this.rootPath, postprocess: this._postprocessLevel },
          'Index unchanged since last run (HEAD + content match) — skipping edge resolution + postprocess',
        );
        // TRA-1017: the entry mark is stale — nothing changed and the graph
        // was complete before this run (the gate above only passes when the
        // previous run resolved). Unreachable when wasIncomplete.
        this.clearPostprocessIncomplete();
      } else {
        throwIfIndexAborted(signal, this.rootPath);
        if (this._postprocessLevel !== 'none') {
          await this._dag.run(RESOLVE_EDGES_TASK_NAME, {
            runResolveAllEdges: () => this.resolveAllEdges(),
          });
          // TRA-1017: resolution completed — the graph is whole again. A
          // scoped run only repairs its own scope, so it clears a previous
          // interruption only when there was none; a full-scope run
          // (`!_isIncremental`) rebuilds every edge and always clears.
          if (!wasIncomplete || !this._isIncremental) this.clearPostprocessIncomplete();
        }
        throwIfIndexAborted(signal, this.rootPath);
        if (this._postprocessLevel === 'full') {
          await this._dag.run(LSP_ENRICHMENT_TASK_NAME, {
            runLspEnrichment: () => this.runLspEnrichment(),
          });
          // SCIP ingestion runs AFTER LSP so its higher-precision tier
          // (scip_resolved > lsp_resolved) wins last and is not downgraded by
          // the LSP edge-upgrade UPDATE. Opt-in, no-op when scip.enabled=false.
          await this.runScipIngestion();
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
      invalidateSearchCache(this.store.db);
    }

    if (this._postprocessLevel === 'full' && !this._isIncremental && result.indexed > 0) {
      // TRA-1017: the snapshot phase is pure telemetry — never worth holding
      // a shutdown for.
      throwIfIndexAborted(signal, this.rootPath);
      // #237: yield before the (synchronous, potentially multi-second) graph
      // snapshot capture so /health can be serviced between edge resolution and
      // snapshotting on a full reindex.
      await yieldToEventLoopFair();
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

  /** Pass 1: extract symbols from files and persist in batched transactions. */
  private async extractAndPersist(
    relPaths: string[],
    force: boolean,
    result: IndexingResult,
    signal?: AbortSignal,
  ): Promise<void> {
    // Phase 4 phantom-rebind: reset prior-run snapshot before the batch runs;
    // extractAndPersistImpl returns the persister's fresh diff maps below.
    this._lastNewSymbolNames = new Map();
    this._lastDeletedSymbolNames = new Map();

    const outcome = await extractAndPersistImpl(
      {
        store: this.store,
        registry: this.registry,
        rootPath: this.rootPath,
        workspaces: this.workspaces,
        gitignore: this._gitignore,
        fileContentCache: this._fileContentCache,
        buildProjectContext: () => this.buildProjectContext(),
        getPipelineState: () => this.getPipelineState(),
        maybeGetExtractPool: (batchSize) => this.maybeGetExtractPool(batchSize),
        ftsRebuildThreshold: IndexingPipeline.FTS_REBUILD_THRESHOLD,
        progress: this.progress,
        sortByExtension,
        signal,
      },
      relPaths,
      force,
      result,
    );

    // Phase 4 phantom-rebind: expose the persister's diff maps to
    // buildChangeScope() via the pipeline fields.
    this._lastNewSymbolNames = outcome.newSymbolNames;
    this._lastDeletedSymbolNames = outcome.deletedSymbolNames;
    // TRA-1541: remember whether Pass 1 rebuilt FTS (no ANALYZE on that path)
    // so indexFiles can refresh planner statistics below.
    this._lastUsedFtsRebuild = outcome.usedFtsRebuild;
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
    const edgeResolver = new EdgeResolver(this.getPipelineState());
    // #237: the postprocess (edge-resolution) phase runs right after extraction
    // hits 100%, and in the field SIGTERMs delivered during this window were
    // only processed once it finished — i.e. this phase starves the event loop
    // and /health. Yield before the first (heaviest, cross-file) resolver pass
    // so the loop can service a health check between extraction and resolution.
    // The framework pass itself yields per plugin and per workspace inside
    // EdgeResolver.resolveEdges (TRA-922), so this pre-yield only covers the
    // boundary before it starts.
    await yieldToEventLoopFair();
    await edgeResolver.resolveEdges(
      this.buildProjectContext(),
      this.buildResolveContext(scope),
      scope,
    );
    const stages: Array<() => void> = [
      // TRA-1780: purge stale electron removal edges right after the
      // framework emission above (fresh virtuals in place) and before the
      // domain resolvers + file projection below.
      () => edgeResolver.resolveElectronRemovalEdges(scope),
      () => edgeResolver.resolveOrmAssociationEdges(scope),
      () => edgeResolver.resolveTypeScriptHeritageEdges(scope),
      () => edgeResolver.resolveEsmImportEdges(scope),
      () => edgeResolver.resolvePythonImportEdges(scope),
      () => edgeResolver.resolvePhpImportEdges(scope),
      () => edgeResolver.resolveGoImportEdges(scope),
      () => edgeResolver.resolveJavaImportEdges(scope),
      () => edgeResolver.resolveRustImportEdges(scope),
      () => edgeResolver.resolveCImportEdges(scope),
      () => edgeResolver.resolveRubyImportEdges(scope),
      () => edgeResolver.resolveCSharpImportEdges(scope),
      () => edgeResolver.resolveKotlinImportEdges(scope),
      () => edgeResolver.resolveElixirImportEdges(scope),
      () => edgeResolver.resolveLuaImportEdges(scope),
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
      // Kustomize/compose path-string imports → actual manifest / Dockerfile
      // node. Runs before file-projection so the resolved cross-file edge also
      // reaches the file-level dependency graph.
      () => edgeResolver.resolveIacImportEdges(scope),
      // Must run last — projects cross-file symbol edges to file-level `imports`
      // edges so the file dependency graph is as rich as the symbol graph.
      () => edgeResolver.resolveFileProjectionEdges(scope),
    ];
    for (const stage of stages) {
      await runInOwnTurn(stage);
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
  /** TRA-1576: injected incremental-discovery seam (real one by default). */
  private _incrementalDiscovery: IndexingPipelineDeps['incrementalDiscovery'] = undefined;
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
    // TRA-1752: an in-flight run can reach its tail after dispose() cleared
    // the timer — arming a fresh one here would fire post-stop against the
    // closed DB ("Deferred edge reconcile failed / database connection is
    // not open" in the shutdown window). Never schedule once disposed.
    if (this._disposed) return;
    if (this._reconcileTimer) clearTimeout(this._reconcileTimer);
    this._reconcileScheduledAt = Date.now();
    this._reconcileTimer = setTimeout(() => this.fireEdgeReconcile(), this._reconcileDebounceMs);
    // Never keep the process alive just for a pending reconcile.
    this._reconcileTimer.unref?.();
  }

  /** Timer body for the deferred reconcile — chains the full pass onto the pipeline lock. */
  private fireEdgeReconcile(): void {
    this._reconcileTimer = null;
    // No detection reset here: the reconcile reuses whatever the latest run
    // persisted (a manifest change in the meantime already forced a
    // re-detect+persist on its own run via the runPipeline gate).
    const scheduledAt = this._reconcileScheduledAt;
    // TRA-1763: the deferred full pass runs after `status: ready` on the
    // pipeline lock — outside every in-flight window TRA-1125 created. Hold
    // the mark for the run so `projects_indexing` covers it. Released on
    // settle; early returns (disposed, superseded) release the same way.
    const endReindex = beginReindex(this.rootPath);
    const run = this._lock.then(async () => {
      if (this._disposed) return;
      // A full pass already ran after this was scheduled (forced reindex,
      // large-batch fallback) — the graph is already reconciled.
      if (this._lastFullResolveMs >= scheduledAt) return;
      const start = Date.now();
      await this.runEdgeResolvers(undefined);
      // TRA-1017: a full-scope resolve rebuilds every edge, which is exactly
      // what clears an interrupted run's incomplete mark — even though this
      // path never went through runPipeline's entry marking.
      this.clearPostprocessIncomplete();
      invalidatePageRankCache();
      invalidateSearchCache(this.store.db);
      logger.info({ durationMs: Date.now() - start }, 'Deferred edge reconcile completed');
    });
    this._lock = run.catch((e) => {
      logger.warn({ error: e }, 'Deferred edge reconcile failed');
    });
    void run.then(endReindex, endReindex);
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

  /** Debounce window before the deferred coverage reconcile (TRA-231). */
  private static readonly COVERAGE_RECONCILE_DEBOUNCE_MS = 60_000;
  /**
   * Minimum candidate-vs-indexed file gap that counts as real drift. Below
   * this the incremental path is trusted — a handful of files is what the
   * watcher reliably delivers, and reacting to a gap of 1 would re-walk the
   * tree after every ordinary edit.
   *
   * ponytail: a plain count heuristic, not a set diff. Files the walk finds
   * but indexing legitimately drops (parse errors, binary content) inflate
   * the gap; the cooldown below keeps that from looping. Upgrade to a real
   * path-set diff if the count ever proves too blunt.
   */
  private static readonly COVERAGE_DRIFT_MIN_FILES = 10;
  /** Minimum quiet period between two coverage reconciles. */
  private static readonly COVERAGE_RECONCILE_COOLDOWN_MS = 5 * 60_000;
  private _coverageDebounceMs: number = IndexingPipeline.COVERAGE_RECONCILE_DEBOUNCE_MS;
  private _coverageTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastCoverageReconcileMs = 0;

  /**
   * Schedule a coalesced coverage check. Registration indexes the tree once;
   * everything after that arrives as watcher-driven `indexFiles()` calls, so a
   * project whose on-disk shape changes drastically (a repo cloned into an
   * already-registered workdir) settles at whatever fraction of the tree the
   * watcher managed to report — TRA-231. The check walks the include globs and
   * compares the candidate count to the indexed file count; a real gap kicks a
   * hash-gated `indexAll()`, which is what `reindex({force:true})` used to be
   * needed for. Coalesced onto a single trailing timer so an edit storm costs
   * one walk, not N.
   */
  private scheduleCoverageReconcile(): void {
    // TRA-1752: same guard as scheduleEdgeReconcile — a run draining through
    // dispose() must not arm a timer that fires against the closed DB.
    if (this._disposed) return;
    if (this._coverageTimer) clearTimeout(this._coverageTimer);
    this._coverageTimer = setTimeout(() => this.fireCoverageReconcile(), this._coverageDebounceMs);
    // Never keep the process alive just for a pending coverage check.
    this._coverageTimer.unref?.();
  }

  /** Timer body — walks the tree and reindexes only when coverage actually drifted. */
  private fireCoverageReconcile(): void {
    this._coverageTimer = null;
    // TRA-1763: same mark as the edge reconcile — the drift walk and the
    // `indexAll` it can trigger both run at `status: ready`.
    const endReindex = beginReindex(this.rootPath);
    const run = (async () => {
      if (this._disposed) return;
      if (
        Date.now() - this._lastCoverageReconcileMs <
        IndexingPipeline.COVERAGE_RECONCILE_COOLDOWN_MS
      ) {
        return;
      }
      const onDisk = (await this.collectFiles()).files.length;
      if (this._disposed) return;
      const indexed = this.store.getStats().totalFiles;
      const gap = onDisk - indexed;
      if (gap < IndexingPipeline.COVERAGE_DRIFT_MIN_FILES) return;
      this._lastCoverageReconcileMs = Date.now();
      logger.info(
        { root: this.rootPath, onDisk, indexed, gap },
        'Coverage drift detected — running a full hash-gated reindex',
      );
      await this.indexAll();
    })();
    void run.catch((e) => {
      logger.warn({ error: e }, 'Deferred coverage reconcile failed');
    });
    void run.then(endReindex, endReindex);
    this._coverageReconcileRun = run.catch(() => {});
  }

  private _coverageReconcileRun: Promise<unknown> = Promise.resolve();

  /**
   * Test hook: fire a pending coverage reconcile immediately and await it.
   * No-op when nothing is scheduled.
   */
  async __flushCoverageReconcileForTests(): Promise<void> {
    if (!this._coverageTimer) return;
    clearTimeout(this._coverageTimer);
    this.fireCoverageReconcile();
    await this._coverageReconcileRun;
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

  /**
   * Pass 3b: SCIP ingestion — upgrade edges to the compiler-grade
   * `scip_resolved` tier (ranked above lsp_resolved) by running an offline SCIP
   * indexer (or ingesting a pre-built index_path). Opt-in via `scip.enabled`.
   * Skips the watcher hot path like LSP enrichment does.
   */
  private async runScipIngestion(): Promise<void> {
    if (!this.config.scip?.enabled) return;
    if (this._isIncremental) return;

    try {
      const { ScipBridge } = await import('../scip/bridge.js');
      const bridge = new ScipBridge(this.store, this.config, this.rootPath);
      await bridge.ingest();
    } catch (e) {
      logger.warn({ error: e }, 'SCIP ingestion failed — continuing without SCIP edges');
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

  /**
   * Register every active framework plugin's edge types in the store.
   *
   * Async with a fair yield before the bulk write (TRA-922): workspace
   * detection above (`getWorkspaceFrameworkPlugins`) plus the SQLite write
   * below would otherwise form one span on a many-workspace root. Per-plugin
   * and per-workspace breathing during the heavier edge-resolution pass
   * lives in EdgeResolver.resolveEdges; this yield covers the registration
   * half of the same wedge.
   */
  private async registerFrameworkEdgeTypes(): Promise<void> {
    // TRA-1543: collect every (name, category, description) first, then write
    // them in ONE transaction. This used to be one autocommit WAL transaction
    // per edge type (root actives + every workspace's plugins — hundreds on a
    // monorepo fixture), all for rows that already exist (INSERT OR IGNORE).
    // Same statements, same order, one commit — output-identical.
    const pending: Array<{ name: string; category: string; description: string }> = [];
    const registerSchema = (plugins: FrameworkPlugin[]) => {
      for (const plugin of plugins) {
        const schema = plugin.registerSchema();
        if (schema.edgeTypes) {
          for (const et of schema.edgeTypes) {
            pending.push({
              name: et.name,
              category: et.category,
              description: et.description ?? '',
            });
          }
        }
      }
    };

    // Root-level plugins
    const ctx = this.buildProjectContext();
    const activeResult = this.registry.getActiveFrameworkPlugins(ctx);
    if (activeResult.isOk()) registerSchema(activeResult.value);

    // Workspace-level plugins (may detect frameworks not visible at root)
    const wsPluginsByPath = this.getWorkspaceFrameworkPlugins();
    for (const ws of this.workspaces) {
      registerSchema(wsPluginsByPath.get(ws.path) ?? []);
    }

    if (pending.length === 0) return;
    // TRA-922: separate the detection span above from the write span below
    // so pending I/O gets a turn between them on many-workspace roots.
    await yieldToEventLoopFair();
    const insert = this.store.db.prepare(
      'INSERT OR IGNORE INTO edge_types (name, category, directed, description) VALUES (?, ?, 1, ?)',
    );
    this.store.db.transaction(() => {
      for (const et of pending) insert.run(et.name, et.category, et.description);
    })();
  }

  /**
   * TRA-1543: detect framework plugins per workspace, shared across the
   * phases of a run (registration, extraction, resolution — which used to
   * detect the same ~44 workspaces × ~100 plugins three times) and reloaded
   * from repo_metadata by fresh instances when the runPipeline gate holds
   * (bench harness, CLI one-shots and daemon restarts all construct a new
   * pipeline per run — an instance-only memo would never hit for them).
   * The workspace signature check heals structural drift even when the gate
   * misfires; manifest drift fails the gate itself. A newly added framework
   * therefore surfaces no later than the run that carries its manifest — and
   * failing that, at the next periodic verification full walk.
   */
  private getWorkspaceFrameworkPlugins(): Map<string, FrameworkPlugin[]> {
    const sig = this.workspaceSignature();
    if (this._wsFrameworkPlugins && this._wsFrameworkPluginsKey === sig) {
      return this._wsFrameworkPlugins;
    }
    if (!this._wsPluginsForceRedetect) {
      const persisted = this.loadPersistedWorkspacePlugins(sig);
      if (persisted) {
        this._wsFrameworkPlugins = persisted;
        this._wsFrameworkPluginsKey = sig;
        return persisted;
      }
    }
    this._wsPluginsForceRedetect = false;
    const m = new Map<string, FrameworkPlugin[]>();
    for (const ws of this.workspaces) {
      const wsRoot = path.join(this.rootPath, ws.path);
      const wsCtx = buildProjectContext(wsRoot);
      m.set(
        ws.path,
        this.registry.getAllFrameworkPlugins().filter((p) => p.detect(wsCtx)),
      );
    }
    this._wsFrameworkPlugins = m;
    this._wsFrameworkPluginsKey = sig;
    this.persistWorkspacePlugins(m);
    return m;
  }

  /**
   * Fingerprint of the registered framework plugin set (names + versions).
   * Any plugin added, removed or bumped invalidates the persisted detection —
   * code updates must never silently reuse a stale plugin map (post-update
   * passes run with force=true and re-detect anyway; this is the backstop).
   */
  private frameworkPluginFingerprint(): string {
    return this.registry
      .getAllFrameworkPlugins()
      .map((p) => `${p.manifest.name}@${p.manifest.version}`)
      .sort()
      .join(',');
  }

  /** Resolve persisted plugin names to live instances, preserving registry order. */
  private loadPersistedWorkspacePlugins(sig: string): Map<string, FrameworkPlugin[]> | null {
    try {
      const raw = this.store.getRepoMetadata(META_WS_PLUGINS);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        fingerprint?: unknown;
        workspaces?: unknown;
        map?: unknown;
      };
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        parsed.fingerprint !== this.frameworkPluginFingerprint() ||
        parsed.workspaces !== sig ||
        typeof parsed.map !== 'object' ||
        parsed.map === null
      ) {
        return null;
      }
      const byName = new Map(
        this.registry.getAllFrameworkPlugins().map((p) => [p.manifest.name, p] as const),
      );
      const out = new Map<string, FrameworkPlugin[]>();
      for (const [wsPath, names] of Object.entries(parsed.map as Record<string, unknown>)) {
        if (!Array.isArray(names)) return null;
        const plugins: FrameworkPlugin[] = [];
        for (const n of names) {
          const p = typeof n === 'string' ? byName.get(n) : undefined;
          if (!p) return null;
          plugins.push(p);
        }
        out.set(wsPath, plugins);
      }
      // Every current workspace must be covered — a partially-matching map
      // means structural drift the signature check should have caught; fail
      // closed (re-detect) rather than resolve with a subset.
      for (const ws of this.workspaces) {
        if (!out.has(ws.path)) return null;
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Best-effort persist of the detection map (names only — instances don't serialize). */
  private persistWorkspacePlugins(m: Map<string, FrameworkPlugin[]>): void {
    try {
      const map: Record<string, string[]> = {};
      for (const [wsPath, plugins] of m) {
        map[wsPath] = plugins.map((p) => p.manifest.name);
      }
      this.store.setRepoMetadata(
        META_WS_PLUGINS,
        JSON.stringify({
          fingerprint: this.frameworkPluginFingerprint(),
          workspaces: this.workspaceSignature(),
          map,
        }),
      );
    } catch {
      /* best-effort — a missed write just means "detect again next run" */
    }
  }

  private workspaceSignature(): string {
    return this.workspaces
      .map((w) => w.path)
      .sort()
      .join('\0');
  }

  /**
   * Whether the workspace→plugin map may be reused (from the instance memo
   * or repo_metadata) for a run over `relPaths` (POSIX repo-relative). True
   * only with positive proof nothing relevant changed: no path in scope is a
   * framework manifest. Structural drift is caught independently by the
   * workspace-signature check, plugin-set drift by the fingerprint. Stale
   * reuse can only over-detect (a removed framework's plugin scans but
   * matches nothing framework-specific — wasted ms, never lost edges);
   * under-detection needs a manifest change, which fails this gate by
   * construction. Blind spot (benign, same direction): manifests in the
   * `deleted` set never reach relPaths, so a lone manifest *deletion* reuses
   * the map — over-detect until the next verification full walk.
   */
  private canReuseWorkspacePlugins(relPaths: string[]): boolean {
    for (const p of relPaths) {
      const base = p.slice(p.lastIndexOf('/') + 1);
      if (isFrameworkManifestBasename(base)) return false;
    }
    return true;
  }

  private buildResolveContext(scope?: ChangeScope): ResolveContext {
    const store = this.store;
    // TRA-1602: Pass 2 (framework plugins) re-scans the whole corpus on every
    // incremental run — plugins ignore ChangeScope, so a 1-file change still
    // costs N-file getAllFiles mappings plus one disk read per file per
    // plugin (~6k reads on the perf fixture). Neither the file list nor file
    // contents change mid-pass, so memoize per context (one context = one
    // pass). Same bytes, same order, same per-caller array semantics:
    // - file list: one SELECT + map; each caller gets a fresh array copy
    //   (plugins may sort/filter in place — elements are only ever read).
    // - contents: first read pays disk, repeats hit memory. Bounded by
    //   RESOLVE_CONTENT_CACHE_CHARS so huge repos can't balloon transient
    //   RSS; over budget the cache stops filling and reads pass through
    //   (correctness is identical either way — only speed differs).
    //   `_fileContentCache` (extraction-fresh) still wins on every lookup.
    let allFiles: Array<{ id: number; path: string; language: string | null }> | undefined;
    const contentCache = new Map<string, string>();
    let contentCacheChars = 0;
    return {
      rootPath: this.rootPath,
      changeScope: scope,
      getAllFiles: () => {
        allFiles ??= store.getAllFiles().map((f) => ({
          id: f.id,
          path: f.path,
          language: f.language,
        }));
        return allFiles.slice();
      },
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
        return s ? { id: s.id, symbolId: s.symbol_id, name: s.name, kind: s.kind } : undefined;
      },
      getNodeId: (nodeType: string, refId: number) => store.getNodeId(nodeType, refId),
      createNodeIfNeeded: (nodeType: string, refId: number) => store.createNode(nodeType, refId),
      readFile: (relPath: string) => {
        const cached = this._fileContentCache.get(relPath);
        if (cached !== undefined) return cached;
        const memo = contentCache.get(relPath);
        if (memo !== undefined) return memo;
        let content: string | undefined;
        try {
          content = fs.readFileSync(path.resolve(this.rootPath, relPath), 'utf-8');
        } catch {
          return undefined;
        }
        if (contentCacheChars + content.length <= IndexingPipeline.RESOLVE_CONTENT_CACHE_CHARS) {
          contentCache.set(relPath, content);
          contentCacheChars += content.length;
        }
        return content;
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
   * TRA-1537: adaptive via `resolveWorkerThreshold()` — 100 normally,
   * 200 on weak machines (<4 GB / ≤2 CPU), overridable via
   * TRACE_MCP_WORKER_THRESHOLD. Kept as a static for call sites that need a
   * compile-time constant; the live gate is `maybeGetExtractPool`.
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
   * TRA-1602: bound for the per-pass readFile memo in buildResolveContext
   * (string chars ≈ half the transient UTF-16 bytes, so 32M chars ≈ 64MB).
   * The perf fixture holds ~15M chars — fully memoizable; a repo past this
   * budget still resolves correctly, it just re-reads past the cap.
   */
  private static readonly RESOLVE_CONTENT_CACHE_CHARS = 32_000_000;

  /**
   * Lazy-init the extract worker pool, gated by batch size and the
   * `TRACE_MCP_WORKERS=0` env opt-out. Returns null when workers are
   * unavailable in the current runtime (e.g. tsx dev, vitest) — caller must
   * fall back to in-process extraction.
   */
  private maybeGetExtractPool(batchSize: number): ExtractPool | null {
    // TRA-1537: adaptive gate — weak machines need a bigger batch to justify
    // worker spawn (each worker ~50-60 MB RSS). TRACE_MCP_WORKERS=0 opts out.
    if (batchSize < resolveWorkerThreshold()) return null;
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

  /**
   * Wait for in-flight locked work (`_coverageReconcileRun`, then `_lock`),
   * bounded by `timeoutMs` (TRA-1017). Returns true when the drain completed,
   * false on timeout. The timer is always cleared before returning so a fast
   * drain never holds the event loop open for the remainder of the timeout.
   */
  private async drainLockedWork(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drain = (async (): Promise<true> => {
        await this._coverageReconcileRun;
        await this._lock;
        return true;
      })();
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      return await Promise.race([drain, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Shut down the worker pool. Safe to call repeatedly. Pools that were
   *  injected (daemon-shared) are NOT terminated here — the daemon owns them.
   *
   *  Also clears the TaskDag's idempotency cache when it is owned by this
   *  pipeline (in-memory default). Injected caches (e.g. `SqliteTaskCache`)
   *  belong to the caller and are left untouched — closing the underlying
   *  database is the caller's responsibility.
   *
   *  TRA-1752: drains in-flight pipeline work before returning. An
   *  already-fired deferred reconcile (edge pass chained onto `_lock`, or a
   *  coverage run on `_coverageReconcileRun`) may still be executing against
   *  this store when dispose() is called — stopProject() closes the DB right
   *  after dispose() returns, so returning early lets the run's next
   *  statement throw "The database connection is not open" from inside an
   *  async continuation. Both chains are non-rejecting by construction (every
   *  assignment goes through `.catch`), so awaiting them cannot throw.
   *  Queued-but-unstarted work bails via the `_disposed` checks instead of
   *  starting new DB traffic.
   *
   *  TRA-1017: the drain is bounded by `PIPELINE_DISPOSE_DRAIN_MS`. An
   *  in-flight `indexAll` that was asked to stop (via its `AbortSignal`)
   *  bails at its next batch/phase boundary, so the drain is normally
   *  instant — but a run wedged inside a synchronous phase (a multi-second
   *  edge-resolution pass holds the event loop and cannot observe the
   *  abort) would otherwise wedge disposal past the daemon's 20s shutdown
   *  deadline. On timeout dispose() logs and returns anyway: the detached
   *  run's next DB statement throws inside its own error handling, and the
   *  daemon-wide forced exit remains the ultimate backstop. */
  async dispose(): Promise<void> {
    this._disposed = true;
    // Drop any pending deferred reconcile — it must never fire against a
    // torn-down store (daemon stopProject closes the DB right after this).
    if (this._reconcileTimer) {
      clearTimeout(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    if (this._coverageTimer) {
      clearTimeout(this._coverageTimer);
      this._coverageTimer = null;
    }
    // Drain what already fired: the coverage run first, since its tail can
    // chain an indexAll() onto `_lock` that a `_lock`-only wait would miss.
    // TRA-1017: bounded — see the doc comment above.
    const drained = await this.drainLockedWork(PIPELINE_DISPOSE_DRAIN_MS);
    if (!drained) {
      logger.warn(
        { root: this.rootPath, drainTimeoutMs: PIPELINE_DISPOSE_DRAIN_MS },
        'pipeline.dispose: drain timed out — continuing teardown with indexing work still in flight',
      );
    }
    if (this._extractPool && this._poolIsOwned) {
      await this._extractPool.terminate();
    }
    this._extractPool = undefined;
    if (!this._taskCacheIsExternal) {
      this._dag.clearCache();
    }
  }

  /** The active `.gitignore` matcher, or undefined when `ignore.gitignore` is
   *  off. Built on demand — `collectFiles()` runs before `runPipeline()`
   *  refreshes the matchers, and on a first index there is nothing to refresh. */
  private gitignoreMatcher(): GitignoreMatcher | undefined {
    if (this.config.ignore?.gitignore === false) return undefined;
    this._gitignore ??= new GitignoreMatcher(this.rootPath);
    return this._gitignore;
  }

  private async collectFiles(): Promise<CollectFilesResult> {
    // Built here rather than read from the field: on a first index
    // `runPipeline` has not run yet, so `_traceignore` was undefined and the
    // opening walk silently ignored .traceignore entirely.
    this._traceignore = new TraceignoreMatcher(this.rootPath, this.config.ignore);
    // Rebuilt per walk so an edit to .gitignore takes effect on this run, not
    // the next one.
    this._gitignore = new GitignoreMatcher(this.rootPath);
    return collectFilesImpl({
      config: this.config,
      rootPath: this.rootPath,
      workspaces: this.workspaces,
      traceignore: this._traceignore,
      gitignore: this.gitignoreMatcher(),
      maxFiles: this.config.security?.max_files ?? IndexingPipeline.DEFAULT_MAX_FILES,
    });
  }
}
