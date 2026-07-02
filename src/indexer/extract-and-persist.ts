import { cpus } from 'node:os';
import type { Store } from '../db/store.js';
import { disableFts5Triggers, enableFts5Triggers, ensureFts5Triggers } from '../db/schema.js';
import { logger } from '../logger.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { ProjectContext } from '../plugin-api/types.js';
import type { GitignoreMatcher } from '../utils/gitignore.js';
import { EdgeResolver } from './edge-resolver.js';
import type { ExtractPool, ExtractRequest } from './extract-pool.js';
import { findPackageJsonEntries } from './package-entries.js';
import { FileExtractor } from './file-extractor.js';
import { FilePersister } from './file-persister.js';
import type { WorkspaceInfo } from './monorepo.js';
import { detectRenames } from './rename-detector.js';
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
}

/** Result of a run: the persister's per-batch symbol-name churn, exposed so the
 *  caller can refresh its `_lastNewSymbolNames` / `_lastDeletedSymbolNames` snapshot. */
export interface ExtractAndPersistOutcome {
  newSymbolNames: Map<string, Set<number>>;
  deletedSymbolNames: Map<string, Set<number>>;
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

  // Preload all existing file rows in one IN-query so per-file extract()
  // calls hit a Map instead of issuing a SELECT each.
  let existingFiles = store.getFilesByPaths(relPaths);

  // Detect renames before extraction. Without this pass a refactor that
  // moves N files to new paths re-extracts every byte, even though the
  // content is identical to known DB rows. graphify v0.7.0 fixed the same
  // wasted work by keying its cache on content alone.
  const renamed = detectRenames(store, rootPath, relPaths, existingFiles);
  if (renamed > 0) {
    // Renamed paths are now keyed under their new path in the DB; refresh
    // the lookup map so the extractor sees them as "existing".
    existingFiles = store.getFilesByPaths(relPaths);
    logger.info({ renamed }, 'Detected renames — reused existing symbols');
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
  });

  // Cluster same-language files so each worker hits its parser cache instead
  // of paying ~50-100 ms WASM Language.load on every extension switch.
  sortByExtension(relPaths);

  // FTS5 trigger disable+rebuild is only worth it on bulk indexing.
  // For small (incremental) batches the per-row trigger fire is cheaper than
  // rebuilding the entire FTS index from all symbols at the end.
  const useFtsRebuild = relPaths.length > ftsRebuildThreshold;
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

  const BATCH_SIZE = Math.min(500, Math.max(100, Math.ceil(relPaths.length / 20)));

  // Worker pool: only worth the spawn cost (~150-300 ms × N) for bigger
  // batches. Below the threshold or when unavailable (env disable, dev mode,
  // tests), we fall through to in-process extraction.
  const pool = maybeGetExtractPool(relPaths.length);
  const CONCURRENCY = pool ? pool.size : Math.min(8, cpus().length);

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
              const gitignored = gitignore?.isIgnored(relPath) ?? false;
              const r = await pool.extract({
                relPath,
                rootPath,
                force,
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
        fileContentCache.delete(ext.relPath);
      }

      const processed = result.indexed + result.skipped + result.errors;
      progress?.update('indexing', { processed });
      // persistBatch is one synchronous SQLite transaction over up to 500
      // files — stacked back-to-back across batches it starves the event
      // loop, /health stops answering, and the desktop app's watchdog kills
      // the daemon mid-warm-up. One macrotask turn per batch keeps the
      // process responsive at negligible cost.
      await new Promise<void>((r) => setImmediate(r));
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
  return {
    newSymbolNames: persister.newSymbolNames,
    deletedSymbolNames: persister.deletedSymbolNames,
  };
}
