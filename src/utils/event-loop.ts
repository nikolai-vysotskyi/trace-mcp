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
import { execFileSync } from 'node:child_process';

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
  /** Monotonic clock, injectable for deterministic timer tests. */
  now?: () => number;
  /** Wall clock, injectable for deterministic timer tests. */
  wallNow?: () => number;
  /** Cumulative OS-confirmed sleep time; null if unsupported. */
  sleepOffsetMs?: () => number | null;
  /** Last OS-confirmed sleep interval; null means no trustworthy signal. */
  sleepInterval?: () => { startMs: number; endMs: number } | null;
}

function macSleepOffsetMs(): number | null {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return null;
  try {
    // At the last wake, continuous minus absolute Mach time is cumulative
    // suspended time. The values are ticks; hw.tbfrequency converts to ms.
    const output = execFileSync(
      '/usr/sbin/sysctl',
      ['-n', 'machdep.wake_abstime', 'machdep.wake_conttime', 'hw.tbfrequency'],
      { encoding: 'utf8', timeout: 100, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const values = output.trim().split('\n').map(Number);
    if (values.length !== 3 || values.some((value) => !Number.isSafeInteger(value))) return null;
    const [absolute, continuous, frequency] = values as [number, number, number];
    if (frequency <= 0 || continuous < absolute) return null;
    return ((continuous - absolute) * 1000) / frequency;
  } catch {
    return null;
  }
}

function macLastSleepInterval(): { startMs: number; endMs: number } | null {
  if (process.platform !== 'darwin') return null;
  try {
    const output = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.sleeptime', 'kern.waketime'], {
      encoding: 'utf8',
      timeout: 100,
      maxBuffer: 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const times = [...output.matchAll(/\{ sec = (\d+), usec = (\d+) \}/g)].map(
      ([, seconds, microseconds]) => Number(seconds) * 1000 + Number(microseconds) / 1000,
    );
    if (times.length !== 2 || times[1]! <= times[0]!) return null;
    return { startMs: times[0]!, endMs: times[1]! };
  } catch {
    return null;
  }
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
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly sleepOffsetMs: () => number | null;
  private readonly sleepInterval: () => { startMs: number; endMs: number } | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private lastWallTick = 0;
  private lastSleepOffset: number | null = null;
  private stalls = 0;
  private maxLag = 0;

  private sampleClocks(): { now: number; sleepOffset: number | null } {
    let before = this.now();
    let sleepOffset = this.sleepOffsetMs();
    let now = this.now();
    // A system sleep can occur while sysctl is reading several values. If
    // the read itself spans >100 ms, retry after the machine has woken.
    if (now - before > 100) {
      before = now;
      sleepOffset = this.sleepOffsetMs();
      now = this.now();
      if (now - before > 100) sleepOffset = null;
    }
    return { now, sleepOffset };
  }

  constructor(opts: EventLoopLagMonitorOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.thresholdMs = opts.thresholdMs ?? 1000;
    this.onStall = opts.onStall;
    this.onTick = opts.onTick;
    this.now = opts.now ?? (() => performance.now());
    this.wallNow = opts.wallNow ?? (() => Date.now());
    this.sleepOffsetMs = opts.sleepOffsetMs ?? macSleepOffsetMs;
    this.sleepInterval = opts.sleepInterval ?? macLastSleepInterval;
  }

  start(): void {
    if (this.timer) return;
    const initial = this.sampleClocks();
    this.lastSleepOffset = initial.sleepOffset;
    this.lastTick = initial.now;
    this.lastWallTick = this.wallNow();
    this.timer = setInterval(() => {
      const { now, sleepOffset } = this.sampleClocks();
      const wallNow = this.wallNow();
      let lag = now - this.lastTick - this.intervalMs;
      this.lastTick = now;
      const previousWallTick = this.lastWallTick;
      this.lastWallTick = wallNow;
      const previousSleepOffset = this.lastSleepOffset;
      const sleptMs =
        sleepOffset != null && previousSleepOffset != null && sleepOffset >= previousSleepOffset
          ? sleepOffset - previousSleepOffset
          : 0;
      this.lastSleepOffset = sleepOffset;
      lag = Math.max(0, lag - sleptMs);
      try {
        this.onTick?.();
      } catch {
        /* observing must never break the loop it watches */
      }
      if (lag >= this.thresholdMs) {
        // Apple Silicon exposes cumulative sleep time through the difference
        // between continuous and absolute time at the last wake. On older
        // Macs, use the last OS-confirmed sleep interval as a fallback.
        if (sleepOffset == null || previousSleepOffset == null) {
          const sleep = this.sleepInterval();
          if (
            sleep &&
            sleep.startMs >= previousWallTick - 2000 &&
            sleep.startMs <= wallNow + 2000 &&
            sleep.endMs <= wallNow + 2000
          ) {
            const overlapMs = Math.max(
              0,
              Math.min(wallNow, sleep.endMs) - Math.max(previousWallTick, sleep.startMs),
            );
            lag = Math.max(0, lag - overlapMs);
          }
        }
        if (lag < this.thresholdMs) return;
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
