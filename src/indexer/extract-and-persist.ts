import type { Store } from '../db/store.js';
import { disableFts5Triggers, enableFts5Triggers, ensureFts5Triggers } from '../db/schema.js';
import { logger } from '../logger.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { ProjectContext } from '../plugin-api/types.js';
import { yieldToEventLoopFair } from '../utils/event-loop.js';
import { throwIfIndexAborted } from './index-abort.js';
import type { GitignoreMatcher } from '../utils/gitignore.js';
import { EdgeResolver } from './edge-resolver.js';
import type { ExtractPool, ExtractRequest } from './extract-pool.js';
import { logFrameworkExtractStats, resetFrameworkExtractStats } from '../plugin-api/executor.js';
import { selectChangedFiles } from './change-prefilter.js';
import { findPackageJsonEntries } from './package-entries.js';
import { FileExtractor } from './file-extractor.js';
import { FilePersister } from './file-persister.js';
import type { WorkspaceInfo } from './monorepo.js';
import { detectRenames } from './rename-detector.js';
import { renameTreeCacheFile } from '../parser/tree-cache.js';
import type { FileExtraction, PipelineState } from './pipeline-state.js';

/** Mirrors `IndexingResult` in pipeline.ts (kept as a structural subset here,
 *  not a re-export, to avoid a circular import between this module and
 *  pipeline.ts — pipeline.ts imports `extractAndPersist` from here). */
export interface ExtractAndPersistResult {
  indexed: number;
  skipped: number;
  errors: number;
}

/** Inputs `extractAndPersist` needs, extracted out of `IndexingPipeline` so the
 *  extract+persist batch runner can be unit tested without the surrounding
 *  class's other lifecycle state. */
export interface ExtractAndPersistParams {
  store: Store;
  registry: PluginRegistry;
  rootPath: string;
  workspaces: WorkspaceInfo[];
  gitignore: GitignoreMatcher | undefined;
  fileContentCache: Map<string, string>;
  buildProjectContext: () => ProjectContext;
  /** Builds the shared PipelineState used by the batch's EdgeResolver/FilePersister. */
  getPipelineState: () => PipelineState;
  /** Lazily resolves (or spawns) the worker pool for this batch size; null falls back in-process. */
  maybeGetExtractPool: (batchSize: number) => ExtractPool | null;
  /** FTS-rebuild threshold — batches above it drop+rebuild FTS5 triggers instead of per-row firing. */
  ftsRebuildThreshold: number;
  /** Progress reporter; optional (CLI one-shot runs may not wire one up). */
  progress?: { update: (phase: 'indexing', patch: Record<string, unknown>) => void };
  /** In-place sort so files of the same extension cluster together (parser-cache locality). */
  sortByExtension: (relPaths: string[]) => string[];
  /**
   * Cooperative cancellation (TRA-1017). Checked at batch boundaries — the
   * run throws `IndexAbortedError` at the next boundary after abort, between
   * (never inside) persist transactions.
   */
  signal?: AbortSignal;
  /**
   * Per-file force (TRA-1017): members are extracted even when their stored
   * hash says "current". Repair runs pass the files an interrupted run
   * persisted without resolving, so their extraction state (`pendingImports`)
   * is rebuilt and the next resolution restores their edges.
   */
  forcePaths?: Set<string>;
  /**
   * Called after each batch's persist transaction commits, with that batch's
   * extraction rel-paths (TRA-1017). The pipeline records them durably as
   * repair scope, so an abort between batches still knows exactly which
   * files were rewritten without resolution.
   */
  onPersisted?: (relPaths: string[]) => void;
}

/** Result of a run: the persister's per-batch symbol-name churn, exposed so the
 *  caller can refresh its `_lastNewSymbolNames` / `_lastDeletedSymbolNames` snapshot. */
export interface ExtractAndPersistOutcome {
  newSymbolNames: Map<string, Set<number>>;
  deletedSymbolNames: Map<string, Set<number>>;
  /**
   * Whether this run took the trigger-drop + FTS rebuild path (TRA-1541).
   * That path rebuilds both FTS families without running ANALYZE, so the
   * caller uses this to decide a statistics refresh — gating on indexed
   * counts alone would miss rebuild runs where many candidates skipped.
   */
  usedFtsRebuild: boolean;
}

/**
 * Pass 1: extract symbols from files and persist in batched transactions.
 *
 * Moved out of `IndexingPipeline.extractAndPersist` verbatim (2026-07
 * complexity reduction pass) — behavior must stay byte-identical to the
 * original private method; only `this.*` field reads became explicit
 * parameters/callbacks, and `result` mutation stays on the caller-owned
 * `IndexingResult` object.
 */
export async function extractAndPersist(
  params: ExtractAndPersistParams,
  relPaths: string[],
  force: boolean,
  result: ExtractAndPersistResult,
): Promise<ExtractAndPersistOutcome> {
  const {
    store,
    registry,
    rootPath,
    workspaces,
    gitignore,
    fileContentCache,
    buildProjectContext,
    getPipelineState,
    maybeGetExtractPool,
    ftsRebuildThreshold,
    progress,
    sortByExtension,
  } = params;

  // TRA-1017: a stop request aborts the run at the next batch boundary, never
  // mid-transaction.
  throwIfIndexAborted(params.signal, rootPath);

  // TRA-1537 §3 (review fix): reset the per-plugin timing map at run start
  // when profiling is on — otherwise a long-lived daemon dumps totals since
  // process start instead of per-run numbers.
  if (process.env.TRACE_MCP_PROFILE_PLUGINS === '1') resetFrameworkExtractStats();

  // Preload all existing file rows in one IN-query so per-file extract()
  // calls hit a Map instead of issuing a SELECT each.
  let existingFiles = store.getFilesByPaths(relPaths);

  // Detect renames before extraction. Without this pass a refactor that
  // moves N files to new paths re-extracts every byte, even though the
  // content is identical to known DB rows. graphify v0.7.0 fixed the same
  // wasted work by keying its cache on content alone.
  const { renamed, pairs: renamePairs } = detectRenames(store, rootPath, relPaths, existingFiles);
  if (renamed > 0) {
    // Renamed paths are now keyed under their new path in the DB; refresh
    // the lookup map so the extractor sees them as "existing".
    existingFiles = store.getFilesByPaths(relPaths);
    logger.info({ renamed }, 'Detected renames — reused existing symbols');
    // TRA-1577: move the per-file tree-sitter entries along the rename.
    // Content is identical, so the moved entry parses the new path as an
    // identical hit instead of a cold miss (and the old key can't leak).
    for (const { from, to } of renamePairs) {
      renameTreeCacheFile(rootPath, from, to);
    }
  }

  // TRA-1536: mtime+size prefilter BEFORE any extract() dispatch. The old
  // code called extract() once per file in the whole corpus so the
  // content-hash gate could decide what changed — 1903 dispatches (worker
  // IPC round-trips or in-process extract overhead each) for a 1-file
  // change. One lstatSync per file against the preloaded map answers the
  // same question for every file whose mtime floor and byte size both
  // match; only the remainder reaches the extract loop below (which keeps
  // its own read+hash gate for mtime-drifted-but-identical content).
  const { candidates, skipped: prefiltered } = selectChangedFiles(
    rootPath,
    relPaths,
    existingFiles,
    force,
    params.forcePaths,
  );
  result.skipped += prefiltered;
  if (prefiltered > 0) {
    logger.debug(
      { total: relPaths.length, skipped: prefiltered, candidates: candidates.length },
      'Change prefilter skipped unchanged files before extraction',
    );
  }
  // Force-include set: package.json#main/module/bin/exports must always be
  // indexed regardless of file-size cap. Without this, lodash-class
  // monolithic libraries (single-file UMD/IIFE declared as `main`) drop
  // out of the index and every published method looks dead.
  const forceIncludePaths = findPackageJsonEntries(rootPath);

  const extractor = new FileExtractor({
    store,
    registry,
    rootPath,
    workspaces,
    gitignore,
    fileContentCache,
    buildProjectContext,
    existingFiles,
    forceIncludePaths,
    // TRA-1543: share the pipeline's per-run workspace detection so
    // extraction doesn't re-detect what registration already did.
    wsFrameworkPlugins: getPipelineState().wsFrameworkPlugins,
  });

  // Cluster same-language files so each worker hits its parser cache instead
  // of paying ~50-100 ms WASM Language.load on every extension switch.
  // Sorted over the prefilter candidates (not the full walk): unchanged
  // files never reach extraction, so clustering them is wasted work.
  sortByExtension(candidates);

  // FTS5 trigger disable+rebuild is only worth it on bulk indexing.
  // For small (incremental) batches the per-row trigger fire is cheaper than
  // rebuilding the entire FTS index from all symbols at the end.
  // Sized by extract candidates, not the walk: a 1903-file walk with 1
  // changed file must take the incremental path, not the bulk one (TRA-1536).
  const useFtsRebuild = candidates.length > ftsRebuildThreshold;
  if (useFtsRebuild) {
    disableFts5Triggers(store.db);
  } else {
    // Incremental path relies on the AFTER INSERT/DELETE/UPDATE triggers to
    // keep symbols_fts in sync. If a prior bulk run crashed between
    // disableFts5Triggers() and its rebuild, the triggers were left dropped
    // and every incremental symbol write since has silently skipped FTS —
    // making edited symbols unsearchable by name. Re-arm the triggers here
    // (idempotent no-op when present; no rebuild) so the incremental writes
    // below always propagate to FTS.
    ensureFts5Triggers(store.db);
  }

  const BATCH_SIZE = Math.min(500, Math.max(100, Math.ceil(candidates.length / 20)));

  // Worker pool: only worth the spawn cost (~150-300 ms × N) for bigger
  // batches. Below the threshold or when unavailable (env disable, dev mode,
  // tests), we fall through to in-process extraction.
  // Sized by extract candidates (TRA-1536): the prefilter above shrinks a
  // 1903-file walk with 1 change to a 1-file batch, which must NOT pay the
  // pool spawn cost — in-process extraction wins for exactly these runs.
  const pool = maybeGetExtractPool(candidates.length);

  // Single shared persister/resolver — no need to recreate per batch.
  const state = getPipelineState();
  const persistEdgeResolver = new EdgeResolver(state);
  const persister = new FilePersister(state, (edges) => persistEdgeResolver.storeRawEdges(edges));

  // try/finally so a throw mid-batch (worker error, FK constraint failure in
  // persistBatch, etc.) can never leave the FTS triggers dropped. Leaving
  // them dropped would silently desync symbols_fts on every subsequent
  // incremental write until a manual rebuild — the durability bug this guards
  // against. enableFts5Triggers rebuilds from the current symbols table, so
  // running it on the error path also re-syncs FTS to the partial state.
  try {
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      // TRA-1017: cooperative cancellation — stop between batches, where the
      // persisted state is consistent, not inside a batch's transaction.
      throwIfIndexAborted(params.signal, rootPath);
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const extractions: FileExtraction[] = [];
      // TRA-1017: per-file force for repair scope — a dirty file's stored
      // hash says "current", so both the prefilter above and the extractor's
      // own content gate would skip rebuilding its extraction state.
      const fileForce = (relPath: string): boolean =>
        force || (params.forcePaths?.has(relPath) ?? false);

      if (pool) {
        // Continuous dispatch: spawn `pool.size` consumers that each pull
        // from a shared queue. Keeps every worker fed without chunk barriers.
        const queue = batch.slice();
        await Promise.all(
          Array.from({ length: pool.size }, async () => {
            while (queue.length > 0) {
              // TRA-1017: a batch is up to 500 files of pure IPC awaits —
              // check per file so the abort lands inside the batch, not after.
              throwIfIndexAborted(params.signal, rootPath);
              const relPath = queue.shift();
              if (!relPath) return;
              const existing = existingFiles.get(relPath) ?? null;
              const gitignored = gitignore?.isIgnored(relPath) ?? false;
              const r = await pool.extract({
                relPath,
                rootPath,
                force: fileForce(relPath),
                existing,
                gitignored,
                workspaces,
              } as ExtractRequest);
              if (r.kind === 'skipped') {
                result.skipped++;
                continue;
              }
              if (r.kind === 'mtime_updated') {
                // WHY: workers have no DB handle — apply the deferred mtime
                // update on the main thread so the next run hits the cheap
                // mtime fast-path instead of re-hashing every file.
                store.updateFileMtime(r.fileId, r.newMtimeMs);
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
        // TRA-1828: in-process extraction parses on the main thread, so the
        // synchronous unit is bounded to ONE file per fair turn — not a chunk
        // of CONCURRENCY files. A chunk of 8 large-file parses back-to-back
        // held the loop past the 500 ms /health client timeout; per-file
        // turns keep every unit to a single parse. Sequential here costs no
        // parallelism: the work was single-threaded either way.
        for (const relPath of batch) {
          // TRA-1017: the in-process path parses on the main thread, so a
          // large batch without a pool is the longest stretch without a
          // boundary — check per file as well.
          throwIfIndexAborted(params.signal, rootPath);
          await yieldToEventLoopFair();
          const ext = await extractor.extract(relPath, fileForce(relPath));
          if (ext.kind === 'skipped') {
            result.skipped++;
            continue;
          }
          if (ext.kind === 'mtime_updated') {
            // WHY: in-process path normally writes via the in-extractor
            // store handle; this branch is defensive for callers that
            // construct a FileExtractor without a store.
            store.updateFileMtime(ext.fileId, ext.newMtimeMs);
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

      if (extractions.length > 0) {
        // TRA-1828: persistBatch commits in 50-file transactions with a fair
        // yield between chunks (see PERSIST_WRITE_CHUNK) and takes its own
        // first turn internally — no runInOwnTurn wrapper needed here. Awaiting
        // the full batch: churn maps are only valid once every chunk landed.
        await persister.persistBatch(extractions);
        result.indexed += extractions.length;
        // TRA-1017: record exactly what this transaction rewrote, durably and
        // now — an abort at the next boundary must still know this batch's
        // files were persisted without resolution.
        params.onPersisted?.(extractions.map((ext) => ext.relPath));
      } else {
        // Nothing to persist, but the batch still did work — keep the
        // once-per-batch boundary the old unconditional yield gave.
        await yieldToEventLoopFair();
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
        fileContentCache.delete(ext.relPath);
      }

      const processed = result.indexed + result.skipped + result.errors;
      progress?.update('indexing', { processed });
    }
  } finally {
    // Always restore FTS triggers + rebuild if we dropped them for the bulk
    // path — even if a batch threw above. Without this, a mid-run throw
    // leaves the triggers dropped and desyncs symbols_fts on every later
    // incremental write. No-op on the incremental path (triggers stayed live
    // and were re-armed via ensureFts5Triggers before the loop).
    if (useFtsRebuild) enableFts5Triggers(store.db);
  }

  // Phase 4 phantom-rebind: expose the persister's diff maps so the caller can
  // refresh its own _lastNewSymbolNames / _lastDeletedSymbolNames snapshot,
  // read later by buildChangeScope().
  // TRA-1537 §3: opt-in per-plugin timing dump for weak-machine triage.
  if (process.env.TRACE_MCP_PROFILE_PLUGINS === '1') logFrameworkExtractStats();
  return {
    newSymbolNames: persister.newSymbolNames,
    deletedSymbolNames: persister.deletedSymbolNames,
    usedFtsRebuild: useFtsRebuild,
  };
}
