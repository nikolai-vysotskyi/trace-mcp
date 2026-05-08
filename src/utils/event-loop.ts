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
