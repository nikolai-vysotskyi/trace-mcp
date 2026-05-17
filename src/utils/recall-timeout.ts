/**
 * Hard recall timeout for memory-recall tools.
 *
 * Memory tools (`get_wake_up`, `query_decisions`, `get_feature_context`) can
 * block on slow IO: SQLite contention, embedding provider latency, FTS5 index
 * rebuilds. Without a wall-clock budget the MCP client hangs and the agent's
 * turn never returns. This helper races the work against a `setTimeout` and,
 * on timeout, resolves with a caller-supplied fallback so the agent always
 * gets a response — degraded but never blocking.
 *
 * Errors thrown by the wrapped function are NOT swallowed; the timeout is for
 * slowness, not for failures.
 *
 * @example
 *   const result = await withRecallTimeout(
 *     () => assembleWakeUp(store, root),
 *     { timeoutMs: 5000, fallback: EMPTY_WAKEUP, toolName: 'get_wake_up' }
 *   );
 */
import { logger } from '../logger.js';

export interface RecallTimeoutOptions<T> {
  /** Wall-clock budget in milliseconds. */
  timeoutMs: number;
  /** Value to return when the budget is exceeded. */
  fallback: T;
  /** Tool name for structured logging + counter labeling. */
  toolName?: string;
}

/**
 * Race a (possibly sync) function against a hard timeout.
 *
 * On timeout: logs a structured warning, emits a `recall_timeouts_total`
 * counter event via the logger, and resolves with `fallback`. The underlying
 * work promise is left to settle on its own — Node has no Promise.cancel().
 *
 * On error: re-throws. Slowness is recoverable; bugs should surface.
 */
export async function withRecallTimeout<T>(
  fn: () => Promise<T> | T,
  opts: RecallTimeoutOptions<T>,
): Promise<T> {
  const { timeoutMs, fallback, toolName } = opts;

  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        logger.warn(
          {
            toolName: toolName ?? 'unknown',
            timeoutMs,
            counter: 'recall_timeouts_total',
          },
          'Recall timeout exceeded — returning fallback',
        );
        resolve(fallback);
      },
      Math.max(0, timeoutMs),
    );
    // Don't keep the event loop alive solely for this timer.
    timer.unref?.();
  });

  // `Promise.resolve().then(fn)` lifts sync return values and also catches
  // sync throws inside `fn`. We attach a noop catch eagerly so that, on
  // timeout, an eventual rejection from the abandoned work promise does not
  // bubble up as an unhandled rejection.
  const work = Promise.resolve().then(fn);
  let workSettled = false;
  let workError: unknown;
  const tracked = work.then(
    (value) => {
      workSettled = true;
      return value;
    },
    (err) => {
      workSettled = true;
      workError = err;
      // Re-throw so the race still sees the failure when work loses to nothing.
      throw err;
    },
  );

  try {
    const result = await Promise.race([tracked, timeoutPromise]);
    if (timedOut) return result;
    // The race resolved/rejected via `work`. If it threw, propagate.
    if (workSettled && workError !== undefined) throw workError;
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      // Swallow any subsequent rejection from the orphaned work promise so
      // it doesn't become an unhandled rejection.
      work.catch(() => {});
    }
  }
}
