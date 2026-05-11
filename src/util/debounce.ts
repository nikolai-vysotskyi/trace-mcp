/**
 * Trailing-edge debouncer. Each call resets the timer; the wrapped
 * function fires once after `waitMs` of quiet. The returned function
 * also exposes `.flush()` (fire now if pending) and `.cancel()`.
 */
export function trailingDebounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void | Promise<void>,
  waitMs: number,
): {
  (...args: TArgs): void;
  flush: () => void;
  cancel: () => void;
} {
  let timer: NodeJS.Timeout | null = null;
  let lastArgs: TArgs | null = null;

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
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, waitMs);
    timer.unref?.();
  }) as {
    (...args: TArgs): void;
    flush: () => void;
    cancel: () => void;
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
  };

  return wrapped;
}
