/**
 * Worker-thread pool for parallel file extraction.
 *
 * The Node main thread runs tree-sitter (WASM) synchronously, so a
 * `Promise.all` over `extract()` calls only ever uses one core. This pool
 * spawns N worker_threads — each with its own parser cache — so parsing of N
 * files actually proceeds in parallel.
 *
 * Lifecycle: lazy. The first `extract()` call spawns workers; `terminate()`
 * shuts them down. Worker spawn cost is non-trivial (~150-300 ms each because
 * of WASM init + plugin loading), so callers should gate use by batch size.
 *
 * Crash resilience: each slot has exponential backoff on respawn and a
 * consecutive-failure budget. After repeated failures (e.g. MODULE_NOT_FOUND
 * on a misinstalled bundle) the slot is permanently disabled. Once every slot
 * is dead the whole pool flips to unavailable and callers must fall back to
 * in-process extraction. Repeated identical errors are deduped to avoid
 * filling the daemon log with multi-MB stack-trace storms.
 */

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { FileRow } from '../db/types.js';
import { logger } from '../logger.js';
import type { WorkspaceInfo } from './monorepo.js';
import type { FileExtraction } from './pipeline-state.js';

/**
 * fileURLToPath that never throws. Used only for log lines: a malformed worker
 * entry URL (e.g. a Windows file URL with no drive letter) must not crash the
 * crash-handler that's trying to report it. Falls back to the raw href.
 */
function fileURLToPathSafe(url: URL): string {
  try {
    return fileURLToPath(url);
  } catch {
    return url.href;
  }
}

export interface ExtractRequest {
  relPath: string;
  rootPath: string;
  force: boolean;
  /** Pre-loaded existing FileRow (or null). Workers don't have DB access. */
  existing: FileRow | null;
  /** Pre-resolved gitignore status. Workers don't carry the matcher. */
  gitignored: boolean;
  workspaces: WorkspaceInfo[];
}

export type ExtractResponse =
  | { kind: 'skipped' }
  // WHY: hash-hit in the worker path — main thread must update mtime since
  // the worker has no DB handle. Without this the cheap mtime fast-path
  // never kicks in on the next run after a hash-hit.
  | { kind: 'mtime_updated'; fileId: number; newMtimeMs: number | null }
  | { kind: 'error' }
  | { kind: 'ok'; extraction: FileExtraction };

/**
 * Out-of-band control message from main → worker, distinct from the per-file
 * extract request. Currently only used for project eviction so workers can
 * drop their `FileExtractor` + `ProjectContext` caches when a project is
 * removed from the daemon. Without this, those Maps grow monotonically across
 * the daemon's lifetime in long-running deployments with churning projects.
 */
export interface DropProjectMessage {
  kind: 'drop_project';
  rootPath: string;
}

interface InternalRequest extends ExtractRequest {
  id: number;
}
interface InternalResponse {
  id: number;
  result: ExtractResponse;
}

const DEFAULT_WORKER_COUNT = Math.max(1, Math.min(8, os.cpus().length - 1));

/** Daemon-mode default: half cores, capped at 4. Lower than CLI because the
 *  daemon shares one pool across N projects — see plan-indexer-perf §2.1. */
const DEFAULT_KEEPALIVE_WORKER_COUNT = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));

export interface ExtractPoolOptions {
  size?: number;
  /** When true, skip idle teardown — daemon mode. CLI/tests pass false so the
   *  process can exit cleanly when the pool drains. */
  keepAlive?: boolean;
}

/**
 * Resolve the bundled worker entry. tsup emits `dist/extract-worker.js`
 * alongside `dist/cli.js`, so a relative URL from this module hits the right
 * place after bundling. In a non-bundled environment (e.g. tsx running source)
 * the .js file does not exist; in that case we report unavailable and the
 * caller falls back to in-process extraction.
 */
function resolveWorkerEntry(): URL | null {
  const url = new URL('./extract-worker.js', import.meta.url);
  try {
    if (fs.existsSync(fileURLToPath(url))) return url;
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * Idle teardown delay. After this long with no in-flight requests we
 * terminate workers so the parent process can exit naturally. Daemons stay
 * alive via their own listeners; idle re-spawn happens automatically on the
 * next `extract()` call.
 */
const IDLE_TERMINATE_MS = 200;

/** Crash-loop guard tunables. Defaults are conservative — five fast crashes
 *  in a row almost certainly mean the worker entry is unrecoverable (missing
 *  module, bad path, broken bundle). */
const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 30_000;
/** Dedup window for repeat-error summaries. */
const DEDUP_SUMMARY_INTERVAL_MS = 5_000;
const DEDUP_SUMMARY_COUNT = 100;

interface SlotState {
  /** Successive failures since the last successful message. Reset to 0 in onMessage. */
  consecutiveFailures: number;
  /** True once the slot exceeds MAX_CONSECUTIVE_FAILURES — never respawned again. */
  permanentlyDead: boolean;
  /** Pending respawn timer; cleared on terminate. */
  respawnTimer: NodeJS.Timeout | null;
  /** Dedup state for noisy error storms. */
  lastErrorKey: string | null;
  suppressedCount: number;
  suppressedSince: number;
}

export class ExtractPool {
  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private slots: SlotState[] = [];
  private queue: InternalRequest[] = [];
  private pending = new Map<
    number,
    { resolve: (r: ExtractResponse) => void; reject: (e: Error) => void }
  >();
  private nextId = 0;
  private terminated = false;
  private workerEntry: URL | null;
  /** Flipped to true once every slot is permanently dead; `available` returns false. */
  private poolDisabled = false;
  private idleTimer: NodeJS.Timeout | null = null;
  public readonly size: number;
  public readonly keepAlive: boolean;

  constructor(opts: ExtractPoolOptions | number = {}) {
    // Legacy positional-int signature kept so existing call sites that pass a
    // raw size still work — collapse into the options shape internally.
    const o: ExtractPoolOptions = typeof opts === 'number' ? { size: opts } : opts;
    this.keepAlive = o.keepAlive ?? false;
    this.size = o.size ?? (this.keepAlive ? DEFAULT_KEEPALIVE_WORKER_COUNT : DEFAULT_WORKER_COUNT);
    this.workerEntry = resolveWorkerEntry();
  }

  /** True when workers are usable in the current runtime (bundled build). */
  get available(): boolean {
    return this.workerEntry !== null && !this.terminated && !this.poolDisabled;
  }

  private ensureStarted(): void {
    if (this.workers.length > 0 || this.terminated || !this.workerEntry || this.poolDisabled)
      return;
    for (let i = 0; i < this.size; i++) {
      this.slots[i] = this.makeSlot();
      this.spawn(i);
    }
    logger.info({ size: this.size }, 'Extract worker pool started');
  }

  private makeSlot(): SlotState {
    return {
      consecutiveFailures: 0,
      permanentlyDead: false,
      respawnTimer: null,
      lastErrorKey: null,
      suppressedCount: 0,
      suppressedSince: 0,
    };
  }

  private spawn(idx: number): void {
    if (!this.workerEntry || this.terminated || this.poolDisabled) return;
    const slot = this.slots[idx];
    if (!slot || slot.permanentlyDead) return;
    let w: Worker;
    try {
      w = new Worker(this.workerEntry);
    } catch (err) {
      // Construction itself failed (e.g. invalid URL). Treat as a crash so the
      // backoff + max-retries machinery handles it instead of throwing here.
      this.onError(idx, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // Capture per-spawn 'exit' so an immediate bootstrap failure that emits
    // exit-without-error (some loader errors do this) still counts.
    w.on('message', (msg: InternalResponse) => this.onMessage(idx, msg));
    w.on('error', (err) => this.onError(idx, err));
    w.on('exit', (code) => this.onExit(idx, code));
    this.workers[idx] = w;
    this.busy[idx] = false;
  }

  async extract(req: ExtractRequest): Promise<ExtractResponse> {
    if (!this.available) throw new Error('Extract worker pool unavailable in this runtime');
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.ensureStarted();
    // ensureStarted may have synchronously disabled the pool if every spawn
    // failed (rare — usually failures come asynchronously). Re-check.
    if (!this.available) throw new Error('Extract worker pool unavailable in this runtime');
    const id = ++this.nextId;
    return new Promise<ExtractResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.dispatch({ ...req, id });
    });
  }

  /**
   * Broadcast a project-eviction notice to every live worker so they drop
   * their per-rootPath caches (`FileExtractor`, parsed `ProjectContext`).
   * Idempotent — workers ignore unknown rootPaths. Safe to call on a pool
   * that never started workers (no-op). The pool itself remains usable.
   *
   * Fire-and-forget: workers process the message asynchronously. The next
   * `extract()` for the same `rootPath` will lazily rebuild its cache.
   */
  dropProject(rootPath: string): void {
    if (this.terminated) return;
    const msg: DropProjectMessage = { kind: 'drop_project', rootPath };
    for (const w of this.workers) {
      if (!w) continue;
      try {
        w.postMessage(msg);
      } catch {
        /* worker may be mid-terminate; safe to ignore */
      }
    }
  }

  /**
   * Schedule a one-shot idle check; reset on each extract() call. After
   * IDLE_TERMINATE_MS with nothing in flight, soft-terminate workers so the
   * parent process can exit naturally. The pool remains usable — the next
   * extract() call re-spawns workers.
   */
  private scheduleIdleTeardown(): void {
    // Daemon mode: workers stay warm so the next bursty edit doesn't pay the
    // ~150-300 ms × N respawn cost. Explicit terminate() still works.
    if (this.keepAlive) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (
        this.pending.size === 0 &&
        this.queue.length === 0 &&
        !this.terminated &&
        this.workers.length > 0
      ) {
        this.idleTeardown().catch(() => 0);
      }
    }, IDLE_TERMINATE_MS);
    // Don't keep the parent process alive on the timer alone.
    this.idleTimer.unref();
  }

  private async idleTeardown(): Promise<void> {
    const workers = this.workers;
    this.workers = [];
    this.busy = [];
    // Slot state is reset on next ensureStarted(); keep nothing here.
    this.slots = [];
    await Promise.all(workers.map((w) => w.terminate().catch(() => 0)));
  }

  private dispatch(req: InternalRequest): void {
    // Skip slots that are busy, missing (mid-respawn), or permanently dead.
    let idx = -1;
    for (let i = 0; i < this.size; i++) {
      if (this.busy[i]) continue;
      if (!this.workers[i]) continue;
      if (this.slots[i]?.permanentlyDead) continue;
      idx = i;
      break;
    }
    if (idx === -1) {
      this.queue.push(req);
      return;
    }
    this.busy[idx] = true;
    this.workers[idx].postMessage(req);
  }

  private onMessage(workerIdx: number, msg: InternalResponse): void {
    // A successful message is the only signal that the worker is healthy —
    // reset the per-slot failure budget and dedup state.
    const slot = this.slots[workerIdx];
    if (slot) {
      slot.consecutiveFailures = 0;
      slot.lastErrorKey = null;
      slot.suppressedCount = 0;
      slot.suppressedSince = 0;
    }
    const p = this.pending.get(msg.id);
    if (p) {
      this.pending.delete(msg.id);
      p.resolve(msg.result);
    }
    this.busy[workerIdx] = false;
    const next = this.queue.shift();
    if (next) {
      this.busy[workerIdx] = true;
      this.workers[workerIdx].postMessage(next);
      return;
    }
    if (this.pending.size === 0) this.scheduleIdleTeardown();
  }

  private onError(workerIdx: number, err: Error): void {
    const slot = this.slots[workerIdx];
    if (!slot) return;
    slot.consecutiveFailures++;
    this.logCrash(workerIdx, slot, err);

    // Reject in-flight pending so callers don't hang waiting on this slot.
    // Pending is shared across slots, so this is over-eager — but the
    // alternative (tracking per-slot pending) requires re-architecting
    // dispatch. Callers retry at the batch level.
    for (const [id, p] of this.pending) {
      p.reject(err);
      this.pending.delete(id);
    }

    try {
      this.workers[workerIdx]?.terminate().catch(() => {});
    } catch {
      /* ignore */
    }
    // Clear the slot's worker handle so dispatch() routes around it until
    // respawn completes. busy stays false (the request was rejected).
    delete this.workers[workerIdx];
    this.busy[workerIdx] = false;

    if (this.terminated) return;

    if (slot.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      slot.permanentlyDead = true;
      const total = slot.consecutiveFailures + slot.suppressedCount;
      logger.warn(
        {
          workerIdx,
          totalFailures: total,
          lastError: err.message,
          workerEntry: this.workerEntry ? fileURLToPathSafe(this.workerEntry) : null,
        },
        `Extract worker ${workerIdx} permanently disabled after ${total} consecutive failures — worker entry could not load; falling back to in-process extraction`,
      );
      this.maybeDisablePool();
      return;
    }

    const delay = this.backoffFor(slot.consecutiveFailures);
    slot.respawnTimer = setTimeout(() => {
      slot.respawnTimer = null;
      if (this.terminated || this.poolDisabled || slot.permanentlyDead) return;
      this.spawn(workerIdx);
    }, delay);
    // Never keep the event loop alive on a respawn timer.
    slot.respawnTimer.unref();
  }

  /** Some loaders surface failure as exit-without-error; treat as a crash. */
  private onExit(workerIdx: number, code: number): void {
    if (this.terminated || this.poolDisabled) return;
    const slot = this.slots[workerIdx];
    if (!slot || slot.permanentlyDead) return;
    // A clean exit (code 0) after we already cleared the worker handle is the
    // normal terminate() path — ignore. Anything else routes through onError.
    if (code === 0 && !this.workers[workerIdx]) return;
    this.onError(workerIdx, new Error(`Extract worker exited unexpectedly with code ${code}`));
  }

  private backoffFor(failures: number): number {
    // 200ms, 400ms, 800ms, 1600ms, ... capped at BACKOFF_CAP_MS.
    const exp = BACKOFF_BASE_MS * 2 ** (failures - 1);
    return Math.min(BACKOFF_CAP_MS, exp);
  }

  /** Emit a full error log on first occurrence; afterward only periodic counts. */
  private logCrash(workerIdx: number, slot: SlotState, err: Error): void {
    const key = err.message ?? String(err);
    if (slot.lastErrorKey !== key) {
      // New error — flush any pending summary from the previous key, then
      // log the new error with its full stack.
      this.flushSuppressedSummary(workerIdx, slot);
      slot.lastErrorKey = key;
      slot.suppressedCount = 0;
      slot.suppressedSince = Date.now();
      logger.error({ err, workerIdx }, 'Extract worker crashed — restarting');
      return;
    }
    // Same error as last time — suppress full stack, increment counter.
    slot.suppressedCount++;
    const now = Date.now();
    const elapsed = now - slot.suppressedSince;
    if (slot.suppressedCount >= DEDUP_SUMMARY_COUNT || elapsed >= DEDUP_SUMMARY_INTERVAL_MS) {
      this.flushSuppressedSummary(workerIdx, slot);
      slot.suppressedSince = now;
      slot.suppressedCount = 0;
    }
  }

  private flushSuppressedSummary(workerIdx: number, slot: SlotState): void {
    if (slot.suppressedCount === 0) return;
    const seconds = Math.max(1, Math.round((Date.now() - slot.suppressedSince) / 1000));
    logger.warn(
      {
        workerIdx,
        repeatCount: slot.suppressedCount,
        errorKey: slot.lastErrorKey,
      },
      `Extract worker ${workerIdx} crashed ${slot.suppressedCount} more times with same error in last ${seconds}s`,
    );
  }

  private maybeDisablePool(): void {
    if (this.poolDisabled) return;
    if (!this.slots.every((s) => s?.permanentlyDead)) return;
    this.poolDisabled = true;
    logger.warn(
      { size: this.size },
      'Extract worker pool permanently disabled — all slots failed; falling back to in-process extraction',
    );
    // Reject anything still queued or pending so callers unwind cleanly.
    const err = new Error('Extract worker pool permanently disabled');
    for (const [id, p] of this.pending) {
      p.reject(err);
      this.pending.delete(id);
    }
    this.queue = [];
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const slot of this.slots) {
      if (slot?.respawnTimer) {
        clearTimeout(slot.respawnTimer);
        slot.respawnTimer = null;
      }
    }
    const workers = this.workers;
    this.workers = [];
    this.busy = [];
    this.slots = [];
    for (const p of this.pending.values()) p.reject(new Error('Pool terminated'));
    this.pending.clear();
    this.queue = [];
    await Promise.all(workers.map((w) => w?.terminate().catch(() => 0)));
  }
}
