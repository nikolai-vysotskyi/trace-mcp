/**
 * Cooperative yield helper for long-running CPU-bound work.
 *
 * The MCP server runs on a single Node event loop. A synchronous loop that
 * runs for several seconds (Leiden community detection on 10k files, regex
 * codemod over a monorepo, AST clone hashing, taint analysis) blocks stdio:
 * the client request never gets a response and the user sees the MCP call
 * hang indefinitely.
 *
 * `yieldToEventLoop()` parks the current async function until the next macro
 * task — long enough for `setImmediate` / I/O / pending promise callbacks to
 * run, including stdin/stdout pumps. Sprinkle a call every N iterations of a
 * hot loop and the event loop stays responsive.
 *
 * Use `maybeYield(counter, every)` for the common case: increment a counter
 * inside the loop and yield only every `every` iterations to keep overhead
 * negligible.
 */

let yieldCount = 0;

/** Force a single macrotask boundary. Resolves on the next event-loop tick. */
export function yieldToEventLoop(): Promise<void> {
  yieldCount++;
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Yield only when `counter % every === 0` (and counter > 0). Cheap to call
 * inside tight loops — no promise allocation when not yielding.
 *
 * @example
 *   for (let i = 0; i < n; i++) {
 *     // ...heavy work...
 *     await maybeYield(i, 256);
 *   }
 */
export async function maybeYield(counter: number, every = 256): Promise<void> {
  if (counter > 0 && counter % every === 0) {
    await yieldToEventLoop();
  }
}

/** Test/diagnostic helper: how many times yieldToEventLoop fired in this process. */
export function getYieldCount(): number {
  return yieldCount;
}

/** Reset the yield counter — for tests only. */
export function _resetYieldCountForTests(): void {
  yieldCount = 0;
}

/**
 * TRA-1127: a *fair* macrotask boundary — only one caller's synchronous unit
 * runs per event-loop turn, process-wide.
 *
 * `yieldToEventLoop()` alone is not enough when several indexers run at once.
 * Node drains the whole check-phase queue before returning to poll, so N
 * concurrent workers that each "yield" between chunks still stack N chunks
 * into a single turn — measured on a plain HTTP server: 40 × 50 ms chunks give
 * a p50 request latency of 100 ms at N=1 and 2 100 ms at N=21, i.e. the
 * daemon's /health latency scales linearly with the number of projects
 * indexing. That is the starvation window this fixes.
 *
 * Callers queue behind each other, so each turn carries exactly one unit and
 * the wait a pending health check sees is bounded by the largest single unit
 * rather than by their sum. Total throughput is unchanged — they were sharing
 * one thread either way — only the interleaving is.
 *
 * The chain is one unscoped process-wide queue, which is what makes it work:
 * scoping it per project would restore the stacking it exists to prevent. The
 * cost is shared fate — a new caller from an unrelated subsystem (MCP request
 * handlers, LSP enrichment, the subproject scanner) queues behind indexing and
 * indexing queues behind it. Only adopt it for work that is already CPU-bound
 * on the main thread, and never for anything that awaits I/O inside its unit.
 */
let fairChain: Promise<void> = Promise.resolve();

export function yieldToEventLoopFair(): Promise<void> {
  const mine = fairChain.then(() => yieldToEventLoop());
  fairChain = mine.catch(() => {});
  return mine;
}

/**
 * Run one synchronous unit of work in an event-loop turn of its own.
 *
 * The yield must come *immediately before* the sync work, not after it: a
 * yield placed after the unit is only fair if nothing else can resume the
 * caller in between. Awaiting extraction workers does exactly that, which is
 * how two projects' persist transactions ended up in one turn even with the
 * fair yield in place. Wrapping the unit makes the invariant impossible to
 * get wrong at the call site.
 */
export async function runInOwnTurn<T>(fn: () => T): Promise<T> {
  await yieldToEventLoopFair();
  return fn();
}

/**
 * TRA-1828: event-loop lag monitor for the live daemon.
 *
 * Bulk reindex passes (~2700 files, 30–65 s) starved the daemon's only
 * thread while `daemon.log` stayed green: every connected stdio session
 * flipped proxy→local (`daemon-disappeared`, 391/day) because /health —
 * guarded by a 500 ms client timeout and a 30 s stability window — stopped
 * answering. Nothing on the daemon side measured the stall, so QA could not
 * tell "clients dropped" apart from "daemon busy".
 *
 * The monitor samples a `setInterval` tick and reports the drift
 * (`actualGap - intervalMs`) as lag. A tick delayed past `thresholdMs`
 * counts one stall: the stall counter + max lag are the "счётчик", the
 * `onStall` callback is where the daemon attaches its warn-log. The timer
 * is unref'd — it observes the loop, never holds it open.
 */
export interface EventLoopLagMonitorOptions {
  /** Sampling period (ms). Default 1000. */
  intervalMs?: number;
  /** Lag past which a tick counts as a stall (ms). Default 1000. */
  thresholdMs?: number;
  /** Called once per stalled tick with (lagMs, maxLagMs, stallCount). */
  onStall?: (lagMs: number, maxLagMs: number, stallCount: number) => void;
  /**
   * Called on every tick (including healthy ones). TRA-1957: the cross-thread
   * stall watchdog beats its heartbeat here — one call per event-loop turn.
   */
  onTick?: () => void;
}

export interface EventLoopLagStats {
  stallCount: number;
  maxLagMs: number;
}

export class EventLoopLagMonitor {
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly onStall?: (lagMs: number, maxLagMs: number, stallCount: number) => void;
  private readonly onTick?: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private stalls = 0;
  private maxLag = 0;

  constructor(opts: EventLoopLagMonitorOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.thresholdMs = opts.thresholdMs ?? 1000;
    this.onStall = opts.onStall;
    this.onTick = opts.onTick;
  }

  start(): void {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const lag = now - this.lastTick - this.intervalMs;
      this.lastTick = now;
      try {
        this.onTick?.();
      } catch {
        /* observing must never break the loop it watches */
      }
      if (lag >= this.thresholdMs) {
        this.stalls++;
        if (lag > this.maxLag) this.maxLag = lag;
        try {
          this.onStall?.(Math.round(lag), this.maxLag, this.stalls);
        } catch {
          /* observing must never break the loop it watches */
        }
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStats(): EventLoopLagStats {
    return { stallCount: this.stalls, maxLagMs: this.maxLag };
  }
}
