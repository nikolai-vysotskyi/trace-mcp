/**
 * Lazy background embedding indexer.
 * Finds symbols without embeddings and indexes them in batches.
 */
import type Database from 'better-sqlite3';
import type { Store } from '../db/store.js';
import { logger } from '../logger.js';
import type { ProgressState } from '../progress.js';
import { warnIfCloudEmbeddingProvider } from './cloud-warning.js';
import type { EmbeddingService, VectorStore } from './interfaces.js';
import { DimensionMismatchError, ProviderMismatchError } from './vector-store.js';

const DEFAULT_BATCH_SIZE = 50;
/** Trip the circuit breaker after this many consecutive batch failures. */
const FAILURE_THRESHOLD = 2;
/** How long to skip embedding work after the breaker trips. */
const COOLDOWN_MS = 10 * 60 * 1000;
/** `server_state` row holding the breaker state so it survives daemon restarts. */
const BREAKER_STATE_KEY = 'embedding_breaker';

/**
 * Circuit-breaker state as persisted in `server_state`. In-memory only, the
 * breaker resets on every process start — which under a restart loop (TRA-809)
 * turns an unreachable embedding endpoint into a permanent retry storm against
 * it (TRA-812). Persisting it makes the cooldown mean what it says.
 */
export interface EmbeddingBreakerState {
  /** Epoch ms until which embedding work is skipped. */
  disabledUntilMs: number;
  /** Consecutive failed batches at the time of writing. */
  consecutiveFailures: number;
  /** Epoch ms of the most recent batch failure. */
  lastFailureAt: number;
  /** Message from the most recent batch failure. */
  lastError?: string;
}

/**
 * Read the persisted breaker state, or null when there is none (clean history,
 * pre-migration DB without `server_state`, or an unparseable row).
 */
export function readEmbeddingBreakerState(db: Database.Database): EmbeddingBreakerState | null {
  try {
    const row = db.prepare('SELECT value FROM server_state WHERE key = ?').get(BREAKER_STATE_KEY) as
      | { value: string }
      | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as Partial<EmbeddingBreakerState>;
    if (typeof parsed?.disabledUntilMs !== 'number') return null;
    return {
      disabledUntilMs: parsed.disabledUntilMs,
      consecutiveFailures: parsed.consecutiveFailures ?? 0,
      lastFailureAt: parsed.lastFailureAt ?? 0,
      lastError: parsed.lastError,
    };
  } catch {
    return null;
  }
}

/**
 * Failure diagnostics for a single {@link EmbeddingPipeline} run, so callers
 * (embed_repo) can surface *why* nothing was embedded instead of silently
 * reporting "completed" with 0 coverage.
 */
export interface EmbeddingRunDiagnostics {
  /** Count of batches that threw during this run. */
  failedBatches: number;
  /** True when the circuit breaker tripped (>= FAILURE_THRESHOLD failures). */
  breakerTripped: boolean;
  /** Message from the most recent batch failure, if any. */
  lastError?: string;
  /**
   * True when every failure was a dimension mismatch — the most actionable
   * case (config dim != model dim). Lets embed_repo point at the exact fix.
   */
  dimensionMismatch: boolean;
}

/** Construction-time knobs for {@link EmbeddingPipeline}. */
export interface EmbeddingPipelineOptions {
  /**
   * When true (default), provider/model/dim drift between the on-disk index
   * and the active embedding service causes ensureConsistent() to drop the
   * vector store and re-embed under the new config (with a loud warn log).
   * When false, the same drift throws {@link ProviderMismatchError} — useful
   * when the operator wants a hard gate against silent model swaps.
   */
  autoRebuildOnProviderMismatch?: boolean;
}

export class EmbeddingPipeline {
  private consistent = false;
  /** Set while indexUnembedded is running; rapid re-triggers (file watcher) are no-ops. */
  private inFlight = false;
  /** Consecutive batch failures since last success — drives the circuit breaker. */
  private consecutiveFailures = 0;
  /** Wall-clock until which indexUnembedded short-circuits to 0. */
  private disabledUntilMs = 0;
  /** Whether we've already logged the breaker trip (to avoid log spam). */
  private breakerNotified = false;
  /** Resolved auto-rebuild flag — defaults to true for back-compat. */
  private readonly autoRebuild: boolean;
  /** Failure accounting for the current/last run — surfaced to embed_repo. */
  private diagnostics: EmbeddingRunDiagnostics = {
    failedBatches: 0,
    breakerTripped: false,
    dimensionMismatch: false,
  };
  /** Per-run latch: set once a non-dimension-mismatch failure is seen. */
  private sawNonMismatchFailure = false;
  /** Once-per-process latch for the "breaker still open" skip log. */
  private skipNotified = false;

  /**
   * Forget any open cooldown so the next run actually calls the provider.
   * For explicit user-driven runs (embed_repo) — a persisted breaker must not
   * make "embed now" a silent no-op for the rest of the cooldown window.
   */
  resetCircuitBreaker(): void {
    this.consecutiveFailures = 0;
    this.disabledUntilMs = 0;
    this.breakerNotified = false;
    this.skipNotified = false;
    this.clearBreakerState();
  }

  /** Snapshot of why the last run embedded fewer symbols than expected. */
  getLastRunDiagnostics(): EmbeddingRunDiagnostics {
    return { ...this.diagnostics };
  }

  constructor(
    private store: Store,
    private embeddingService: EmbeddingService,
    private vectorStore: VectorStore,
    private progress?: ProgressState,
    options?: EmbeddingPipelineOptions,
  ) {
    this.autoRebuild = options?.autoRebuildOnProviderMismatch ?? true;
    // Resume an open cooldown from a previous process. Without this the breaker
    // is worthless in the daemon: every restart re-attempts the whole backlog.
    const persisted = readEmbeddingBreakerState(store.db);
    if (persisted && persisted.disabledUntilMs > Date.now()) {
      this.disabledUntilMs = persisted.disabledUntilMs;
      this.consecutiveFailures = persisted.consecutiveFailures;
      // Already announced by the process that tripped it — don't re-log the trip.
      this.breakerNotified = true;
    } else if (persisted && Date.now() - persisted.lastFailureAt < COOLDOWN_MS) {
      // A run stops at its first failed batch, so a single run can only ever
      // add one to the counter. Starting from zero every process meant that
      // under a restart loop the counter never reached FAILURE_THRESHOLD and
      // the breaker never tripped at all — 36 full-backlog retries in 40 hours.
      this.consecutiveFailures = persisted.consecutiveFailures;
    }
  }

  /** Persist the breaker so the cooldown outlives this process. Best-effort. */
  private persistBreakerState(): void {
    try {
      this.store.db.prepare('INSERT OR REPLACE INTO server_state (key, value) VALUES (?, ?)').run(
        BREAKER_STATE_KEY,
        JSON.stringify({
          disabledUntilMs: this.disabledUntilMs,
          consecutiveFailures: this.consecutiveFailures,
          lastFailureAt: Date.now(),
          lastError: this.diagnostics.lastError,
        } satisfies EmbeddingBreakerState),
      );
    } catch (e) {
      // Pre-migration DB without server_state, or a read-only store. The
      // in-memory breaker still works for this process.
      logger.debug({ error: e }, 'Failed to persist embedding breaker state');
    }
  }

  /** Drop the persisted breaker after a successful batch. Best-effort. */
  private clearBreakerState(): void {
    try {
      this.store.db.prepare('DELETE FROM server_state WHERE key = ?').run(BREAKER_STATE_KEY);
    } catch {
      /* see persistBreakerState */
    }
  }

  /**
   * Verify the stored vectors match the current embedding model + dimensionality.
   * On mismatch, drops the vector table and re-stamps the meta. The follow-up
   * indexUnembedded call will repopulate. Idempotent and cached after first run.
   */
  private async ensureConsistent(): Promise<void> {
    if (this.consistent) return;
    // Let providers that can't reliably default their dimension (Ollama) probe
    // the model's real output length before we stamp the vector store. Skipped
    // when the dimension is already known (explicit config or a prior probe).
    if (this.embeddingService.probeDimensions) {
      await this.embeddingService.probeDimensions();
    }
    const dim = this.embeddingService.dimensions();
    const model = this.embeddingService.modelName();
    const provider = this.embeddingService.providerName?.() ?? 'unknown';
    // Skip for fallback/no-op services — they produce no vectors.
    if (dim === 0) {
      this.consistent = true;
      return;
    }

    // One-shot stderr warning before the first cloud-bound embedding leaves
    // the machine. Suppressed by TRACE_MCP_ACCEPT_CLOUD_EMBEDDINGS=1 and
    // never fires for local providers (ollama, onnx, fallback).
    warnIfCloudEmbeddingProvider(provider);

    const meta = this.vectorStore.getMeta();
    if (!meta) {
      // Post-migration or first run: stamp without reindexing. Any existing
      // vectors are assumed to match the current config (the invariant starts
      // being enforced from this point forward).
      this.vectorStore.setMeta(model, dim, provider);
    } else if (
      meta.model !== model ||
      meta.dim !== dim ||
      // Only enforce provider mismatch when the index has it stamped — legacy
      // indexes without the column are accepted and will be backfilled below.
      (meta.provider !== undefined && meta.provider !== provider)
    ) {
      // P0.1: auto-rebuild is opt-out via ai.autoRebuildOnProviderMismatch.
      // When disabled, raise ProviderMismatchError so the operator notices
      // before the index gets silently rewritten.
      if (!this.autoRebuild) {
        throw new ProviderMismatchError(
          {
            provider: meta.provider ?? 'unknown',
            model: meta.model,
          },
          { provider, model },
        );
      }
      logger.warn(
        { old: meta, new: { model, dim, provider } },
        'Embedding provider/model/dim changed — dropping vector index for reindex',
      );
      this.vectorStore.clear();
      this.vectorStore.setMeta(model, dim, provider);
    } else if (meta.provider === undefined) {
      // Legacy index missing the provider column — backfill in place.
      this.vectorStore.setMeta(model, dim, provider);
    }
    this.consistent = true;
  }

  async indexSymbol(symbolId: number, text: string): Promise<void> {
    await this.ensureConsistent();
    const embedding = await this.embeddingService.embed(text);
    if (embedding.length > 0) {
      this.vectorStore.insert(symbolId, embedding);
    }
  }

  /**
   * Find symbols that don't have embeddings yet and embed them in a loop.
   * Reports progress and returns the total number of newly embedded symbols.
   *
   * Self-guarded: skips work when a previous run is still in flight (rapid
   * file-watcher re-triggers) or when the circuit breaker is open (embedding
   * service has been failing for several consecutive batches).
   */
  async indexUnembedded(batchSize = DEFAULT_BATCH_SIZE, signal?: AbortSignal): Promise<number> {
    if (this.inFlight) return 0;
    if (this.disabledUntilMs > Date.now()) {
      // Say it once per process. Silence here is what let a 3 445-symbol
      // backlog sit undrained for two days with nothing in the log but
      // "embedding completed: 0 items" (TRA-812).
      if (!this.skipNotified) {
        this.skipNotified = true;
        logger.info(
          {
            queued: this.store.countUnembeddedSymbols(),
            retryAfter: new Date(this.disabledUntilMs).toISOString(),
          },
          'Embedding paused — service failed recently, backlog is not being drained',
        );
      }
      return 0;
    }
    if (signal?.aborted) return 0;

    this.inFlight = true;
    // Reset per-run failure accounting so getLastRunDiagnostics() reflects only
    // this run. The breaker counters (consecutiveFailures/disabledUntilMs) are
    // intentionally NOT reset — they persist across runs by design.
    this.diagnostics = {
      failedBatches: 0,
      breakerTripped: false,
      dimensionMismatch: false,
    };
    this.sawNonMismatchFailure = false;
    try {
      await this.ensureConsistent();
      const totalToEmbed = this.store.countUnembeddedSymbols();
      if (totalToEmbed === 0) return 0;

      this.progress?.update('embedding', {
        phase: 'running',
        processed: 0,
        total: totalToEmbed,
        startedAt: Date.now(),
        completedAt: 0,
      });

      let totalIndexed = 0;

      try {
        let batch: number;
        do {
          // Cooperative cancellation between batches — owner disposed.
          if (signal?.aborted) break;
          batch = await this.embedBatch(batchSize, signal);
          totalIndexed += batch;
          if (batch > 0) {
            this.progress?.update('embedding', { processed: totalIndexed });
          }
          // Stop the loop if the breaker tripped during this batch.
          if (this.disabledUntilMs > Date.now()) break;
        } while (batch > 0);

        // A run that embedded nothing *because every batch failed* is not a
        // completion. Reporting it as one made a two-day outage read as
        // "embedding completed: 0 items in 2s" at info level (TRA-812).
        if (totalIndexed === 0 && this.diagnostics.failedBatches > 0) {
          this.progress?.update('embedding', {
            phase: 'error',
            processed: 0,
            completedAt: Date.now(),
            error: this.diagnostics.lastError ?? 'all embedding batches failed',
          });
        } else {
          this.progress?.update('embedding', {
            phase: 'completed',
            processed: totalIndexed,
            completedAt: Date.now(),
          });
        }
      } catch (e) {
        this.progress?.update('embedding', {
          phase: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }

      return totalIndexed;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Embed a single batch of unembedded symbols.
   * Returns the number of symbols embedded in this batch.
   */
  private async embedBatch(batchSize: number, signal?: AbortSignal): Promise<number> {
    const unembedded = this.store.db
      .prepare(`
      SELECT s.id, s.name, s.fqn, s.kind, s.signature, s.summary
      FROM symbols s
      LEFT JOIN symbol_embeddings se ON se.symbol_id = s.id
      WHERE se.symbol_id IS NULL
      LIMIT ?
    `)
      .all(batchSize) as {
      id: number;
      name: string;
      fqn: string | null;
      kind: string;
      signature: string | null;
      summary: string | null;
    }[];

    if (unembedded.length === 0) return 0;
    if (signal?.aborted) return 0;

    const texts = unembedded.map((s) => buildEmbeddingText(s));
    let indexed = 0;

    try {
      const embeddings = await this.embeddingService.embedBatch(texts, undefined, signal);
      for (let i = 0; i < embeddings.length; i++) {
        if (embeddings[i].length > 0) {
          this.vectorStore.insert(unembedded[i].id, embeddings[i]);
          indexed++;
        }
      }
      // Reset breaker on any successful batch.
      if (this.consecutiveFailures > 0 || this.breakerNotified) {
        if (this.breakerNotified) {
          logger.info('Embedding service recovered — resuming background embedding');
        }
        this.consecutiveFailures = 0;
        this.breakerNotified = false;
        this.disabledUntilMs = 0;
        this.skipNotified = false;
        this.clearBreakerState();
      }
    } catch (e) {
      logger.error({ error: e }, 'Embedding batch failed');
      // Record the failure so embed_repo can surface it instead of reporting a
      // silent "completed with 0 embedded".
      this.diagnostics.failedBatches++;
      this.diagnostics.lastError = e instanceof Error ? e.message : String(e);
      // dimensionMismatch means "every failure this run was a dimension
      // mismatch" — a single non-mismatch failure clears it permanently.
      if (e instanceof DimensionMismatchError) {
        if (!this.sawNonMismatchFailure) this.diagnostics.dimensionMismatch = true;
      } else {
        this.sawNonMismatchFailure = true;
        this.diagnostics.dimensionMismatch = false;
      }
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= FAILURE_THRESHOLD && !this.breakerNotified) {
        this.diagnostics.breakerTripped = true;
        this.disabledUntilMs = Date.now() + COOLDOWN_MS;
        this.breakerNotified = true;
        logger.warn(
          {
            consecutiveFailures: this.consecutiveFailures,
            cooldownMinutes: COOLDOWN_MS / 60_000,
          },
          'Embedding service unreachable — pausing background embedding',
        );
      } else if (this.breakerNotified) {
        // Already tripped; just extend the cooldown so a still-broken service
        // doesn't get probed the moment the previous window ends.
        this.disabledUntilMs = Date.now() + COOLDOWN_MS;
      }
      // Record the failure (and any cooldown) for the next process and for
      // get_index_health to surface.
      this.persistBreakerState();
    }

    logger.debug({ indexed, total: unembedded.length }, 'Indexed unembedded symbols');
    return indexed;
  }

  /**
   * Re-embed all symbols (deletes existing embeddings first).
   * Also re-stamps meta with the current model + dimensionality so the invariant
   * holds going forward. Returns the number of embedded symbols.
   */
  async reindexAll(): Promise<number> {
    this.vectorStore.clear();
    const dim = this.embeddingService.dimensions();
    if (dim > 0) {
      this.vectorStore.setMeta(
        this.embeddingService.modelName(),
        dim,
        this.embeddingService.providerName?.() ?? 'unknown',
      );
    }
    this.consistent = true;
    this.resetCircuitBreaker();
    return this.indexUnembedded(DEFAULT_BATCH_SIZE);
  }
}

function buildEmbeddingText(symbol: {
  name: string;
  fqn: string | null;
  kind: string;
  signature: string | null;
  summary: string | null;
}): string {
  const parts = [symbol.kind, symbol.fqn ?? symbol.name];
  if (symbol.signature) parts.push(symbol.signature);
  if (symbol.summary) parts.push(symbol.summary);
  return parts.join(' ');
}
