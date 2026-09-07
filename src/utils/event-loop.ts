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
