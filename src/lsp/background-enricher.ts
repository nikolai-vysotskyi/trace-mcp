/**
 * BackgroundLspEnricher — debounced, scoped LSP enrichment for incremental
 * edits.
 *
 * After Phase 1, watcher / hook / register_edit runs default to
 * postprocess='minimal' so LSP enrichment never fires on the hot path. That
 * keeps single-file edits fast (the inline path was the source of 3-11s
 * outliers in daemon.log) but it means LSP-tier call/heritage edges
 * progressively drift on incremental indexes until the next full `indexAll`.
 *
 * This class closes that gap. It accumulates touched file IDs from watcher
 * bursts and runs a scoped LSP enrichment N seconds after the burst ends —
 * "scoped" meaning only the changed files' callable symbols are queried via
 * LSP. The cost is paid off the hot path and proportional to the burst
 * size, not the project size.
 *
 * Lifecycle is owned by ProjectManager (and LocalBackend for the non-daemon
 * path). Background work MUST NEVER throw out — every error path logs and
 * continues so a tsserver hiccup can't take the daemon down.
 */

import type { TraceMcpConfig } from '../config.js';
import type { Store } from '../db/store.js';
import { logger } from '../logger.js';
import { trailingDebounce } from '../util/debounce.js';
import type { EnrichmentResult } from './enrichment.js';

/**
 * Coalescing window for watcher bursts. 8 seconds chosen because:
 *   - a typical Claude Code edit burst is 3-5 files in <2s; 8s captures
 *     the burst plus a small tail without the user having to wait long
 *     for fresh LSP edges before their next query
 *   - shorter (≤3s) thrashes when a refactor lands across many files in
 *     waves separated by ~5s
 *   - longer (>15s) makes interactive workflows feel stale
 */
export const BACKGROUND_LSP_DEBOUNCE_MS = 8_000;

/**
 * Run a single scoped LSP enrichment pass for the given file IDs.
 * Exposed as a function type so tests can inject a fake without spinning
 * up a real LSP server.
 */
export type LspEnrichmentRunner = (input: {
  changedFileIds: Set<number>;
  signal: AbortSignal;
}) => Promise<EnrichmentResult | void>;

export interface BackgroundLspEnricherOptions {
  store: Store;
  config: TraceMcpConfig;
  rootPath: string;
  /** Override the default 8s debounce — primarily for tests. */
  debounceMs?: number;
  /**
   * Test seam: replace the real LspBridge invocation with a fake. Production
   * callers leave this undefined — the default runner constructs an
   * LspBridge, calls enrich() with the file filter, and shuts it down.
   */
  runner?: LspEnrichmentRunner;
}

/**
 * Default runner — constructs an LspBridge per flush so tsserver process
 * lifetime is bounded to the enrichment window. The bridge handles "no
 * LSP servers available" gracefully (returns an empty result), so this
 * path is safe even when the user has no language servers installed.
 */
async function defaultRunner(
  store: Store,
  config: TraceMcpConfig,
  rootPath: string,
  input: { changedFileIds: Set<number>; signal: AbortSignal },
): Promise<EnrichmentResult | void> {
  if (!config.lsp?.enabled) return;
  const { LspBridge } = await import('./bridge.js');
  const bridge = new LspBridge(store, config, rootPath);
  try {
    return await bridge.enrich({
      fileIdFilter: input.changedFileIds,
      signal: input.signal,
    });
  } finally {
    await bridge.shutdown();
  }
}

export class BackgroundLspEnricher {
  private readonly store: Store;
  private readonly config: TraceMcpConfig;
  private readonly rootPath: string;
  private readonly debounceMs: number;
  private readonly runner: LspEnrichmentRunner;
  private readonly debounced: ReturnType<typeof trailingDebounce>;

  /** Files queued for the next debounced flush. */
  private pendingFileIds = new Set<number>();
  /**
   * Files that arrived WHILE a flush was in progress. Drained into
   * pendingFileIds after the in-flight run finishes; if non-empty the
   * enricher re-arms immediately so no edit goes unenriched.
   */
  private pendingDuringRun = new Set<number>();
  private inFlight = false;
  /** AbortController for the current in-flight runner invocation. */
  private currentController: AbortController | null = null;
  private disposed = false;

  constructor(opts: BackgroundLspEnricherOptions) {
    this.store = opts.store;
    this.config = opts.config;
    this.rootPath = opts.rootPath;
    this.debounceMs = opts.debounceMs ?? BACKGROUND_LSP_DEBOUNCE_MS;
    this.runner =
      opts.runner ?? ((input) => defaultRunner(this.store, this.config, this.rootPath, input));
    this.debounced = trailingDebounce(() => this.flushInternal(), this.debounceMs);
  }

  /**
   * Queue a set of file IDs for enrichment and (re-)arm the debounce timer.
   * Safe to call repeatedly during a watcher burst — IDs accumulate, the
   * timer resets on each call, and a single flush runs after the burst ends.
   */
  scheduleEnrichment(changedFileIds: Iterable<number>): void {
    if (this.disposed) return;
    let added = 0;
    for (const id of changedFileIds) {
      if (this.inFlight) {
        if (!this.pendingDuringRun.has(id)) {
          this.pendingDuringRun.add(id);
          added++;
        }
      } else {
        if (!this.pendingFileIds.has(id)) {
          this.pendingFileIds.add(id);
          added++;
        }
      }
    }
    if (added === 0) return;
    // (Re-)arm the trailing-debounce timer. If a flush is in flight the
    // debounce still ticks — when it fires, flushInternal() sees inFlight
    // and the timer effectively no-ops until the run finishes; that's
    // acceptable because the re-entry guard at the end of flushInternal
    // will arm a fresh flush anyway.
    this.debounced();
  }

  /**
   * Drain the current pendingFileIds and run one enrichment pass.
   * Public so tests (and a future "force enrich now" tool) can bypass the
   * debounce. Never throws — errors are logged and swallowed.
   */
  async flush(): Promise<void> {
    if (this.disposed) return;
    this.debounced.cancel();
    // cancel() also aborts the trailingDebounce's signal — re-arm by calling
    // flushInternal directly. We do NOT use this.debounced.flush() because
    // its signal would already be aborted.
    await this.flushInternal();
  }

  /**
   * Cancel any pending or in-flight enrichment. Pending IDs are dropped.
   * Idempotent — safe to call from stopProject() and again from shutdown().
   */
  cancel(): void {
    this.disposed = true;
    try {
      this.debounced.cancel();
    } catch {
      /* best-effort */
    }
    this.pendingFileIds.clear();
    this.pendingDuringRun.clear();
    if (this.currentController) {
      try {
        this.currentController.abort();
      } catch {
        /* best-effort */
      }
    }
  }

  /** Test-only inspector — number of pending IDs not yet flushed. */
  get pendingSize(): number {
    return this.pendingFileIds.size + this.pendingDuringRun.size;
  }

  /** Test-only inspector — true between flush start and flush end. */
  get isRunning(): boolean {
    return this.inFlight;
  }

  private async flushInternal(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) return; // a flush is already running; re-entry guard

    const ids = this.pendingFileIds;
    if (ids.size === 0) return;
    // Atomically swap so any IDs that arrive during the run land in
    // pendingDuringRun, not the set we're about to consume.
    this.pendingFileIds = new Set<number>();
    this.inFlight = true;
    const controller = new AbortController();
    this.currentController = controller;
    const start = Date.now();

    try {
      const result = await this.runner({ changedFileIds: ids, signal: controller.signal });
      if (result && typeof result === 'object') {
        logger.info(
          {
            event: 'background-lsp-enrichment',
            scopedFiles: ids.size,
            upgraded: result.edgesUpgraded,
            added: result.edgesAdded,
            failed: result.edgesFailed,
            queried: result.symbolsQueried,
            durationMs: Date.now() - start,
            servers: result.serverStatuses,
          },
          'Background LSP enrichment completed',
        );
      }
    } catch (err) {
      // Background work must NEVER throw out — every error path logs and
      // continues so a tsserver hiccup can't take the daemon down.
      logger.warn(
        { err, scopedFiles: ids.size, durationMs: Date.now() - start },
        'Background LSP enrichment failed (non-fatal)',
      );
    } finally {
      this.inFlight = false;
      this.currentController = null;
      // Drain anything that arrived during the run. If non-empty, re-arm a
      // fresh debounce — keeps the no-drop guarantee without recursing
      // synchronously.
      if (this.pendingDuringRun.size > 0 && !this.disposed) {
        for (const id of this.pendingDuringRun) this.pendingFileIds.add(id);
        this.pendingDuringRun.clear();
        this.debounced();
      }
    }
  }
}
