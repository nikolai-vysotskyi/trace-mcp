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
 */

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { FileRow } from '../db/types.js';
import { logger } from '../logger.js';
import type { WorkspaceInfo } from './monorepo.js';
import type { FileExtraction } from './pipeline-state.js';

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

export class ExtractPool {
  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private queue: InternalRequest[] = [];
  private pending = new Map<
    number,
    { resolve: (r: ExtractResponse) => void; reject: (e: Error) => void }
  >();
  private nextId = 0;
  private terminated = false;
  private workerEntry: URL | null;
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
    return this.workerEntry !== null && !this.terminated;
  }

  private ensureStarted(): void {
    if (this.workers.length > 0 || this.terminated || !this.workerEntry) return;
    for (let i = 0; i < this.size; i++) {
      this.spawn(i);
    }
    logger.info({ size: this.size }, 'Extract worker pool started');
  }

  private spawn(idx: number): void {
    if (!this.workerEntry) return;
    const w = new Worker(this.workerEntry);
    w.on('message', (msg: InternalResponse) => this.onMessage(idx, msg));
    w.on('error', (err) => this.onError(idx, err));
    this.workers[idx] = w;
    this.busy[idx] = false;
  }

  async extract(req: ExtractRequest): Promise<ExtractResponse> {
    if (!this.workerEntry) throw new Error('Extract worker pool unavailable in this runtime');
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.ensureStarted();
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
    await Promise.all(workers.map((w) => w.terminate().catch(() => 0)));
  }

  private dispatch(req: InternalRequest): void {
    const idx = this.busy.findIndex((b) => !b);
    if (idx === -1) {
      this.queue.push(req);
      return;
    }
    this.busy[idx] = true;
    this.workers[idx].postMessage(req);
  }

  private onMessage(workerIdx: number, msg: InternalResponse): void {
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
    logger.error({ err, workerIdx }, 'Extract worker crashed — restarting');
    // Reject all in-flight requests; the parent will retry in-process.
    for (const [id, p] of this.pending) {
      p.reject(err);
      this.pending.delete(id);
    }
    try {
      this.workers[workerIdx]?.terminate().catch(() => {});
    } catch {
      /* ignore */
    }
    if (!this.terminated) this.spawn(workerIdx);
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const workers = this.workers;
    this.workers = [];
    this.busy = [];
    for (const p of this.pending.values()) p.reject(new Error('Pool terminated'));
    this.pending.clear();
    this.queue = [];
    await Promise.all(workers.map((w) => w.terminate().catch(() => 0)));
  }
}
