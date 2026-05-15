/**
 * Trailing-edge debouncer. Each call resets the timer; the wrapped
 * function fires once after `waitMs` of quiet. The returned function
 * also exposes `.flush()` (fire now if pending), `.cancel()`, and
 * `.signal` (the AbortSignal for the current in-flight invocation).
 *
 * Cancellation semantics: each invocation owns a fresh AbortController.
 * `.cancel()` aborts the current controller, so a long-running async
 * wrapped function reading `.signal` can bail out instead of holding
 * references after the owner (e.g. ManagedProject) has been disposed.
 * The next invocation mints a new controller — aborting one invocation
 * does NOT poison later ones.
 */
export function trailingDebounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void | Promise<void>,
  waitMs: number,
): {
  (...args: TArgs): void;
  flush: () => void;
  cancel: () => void;
  /** Signal for the current in-flight invocation (or the most recent one). */
  readonly signal: AbortSignal;
} {
  let timer: NodeJS.Timeout | null = null;
  let lastArgs: TArgs | null = null;
  // Always-defined controller so `.signal` is never null. Replaced on the
  // first call after a cancel so a previously-aborted signal doesn't poison
  // the next invocation. `.cancel()` aborts the current controller — any
  // in-flight fn awaiting on this signal bails.
  let controller = new AbortController();

  const fire = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    if (args) {
      try {
        const ret = fn(...args);
        if (ret && typeof (ret as Promise<unknown>).then === 'function') {
          (ret as Promise<unknown>).catch(() => {});
        }
      } catch {
        /* swallow — debounced fns must not bring down the timer */
      }
    }
  };

  const wrapped = ((...args: TArgs) => {
    lastArgs = args;
    // A previously-aborted controller must not poison the next invocation —
    // mint a fresh one when scheduling after a cancel.
    if (controller.signal.aborted) {
      controller = new AbortController();
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, waitMs);
    timer.unref?.();
  }) as {
    (...args: TArgs): void;
    flush: () => void;
    cancel: () => void;
    readonly signal: AbortSignal;
  };

  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      fire();
    }
  };
  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
    // Abort the current controller so any in-flight async fn awaiting on
    // .signal can short-circuit. The next invocation will mint a fresh one.
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  Object.defineProperty(wrapped, 'signal', {
    get: () => controller.signal,
    enumerable: true,
  });

  return wrapped;
}
