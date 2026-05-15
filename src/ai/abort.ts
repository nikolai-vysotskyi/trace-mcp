/**
 * Combine multiple AbortSignals into one. The returned signal fires when ANY
 * input fires. `undefined` inputs are skipped — passing only one defined
 * signal returns it unchanged (cheap path).
 *
 * Used by AI providers to merge a caller-supplied cancellation signal (e.g.
 * from the daemon's per-project AbortController) with the per-request
 * timeout signal `AbortSignal.timeout(...)`.
 *
 * Falls back to a manual controller wiring when `AbortSignal.any` is not
 * available (older Node versions); the result is functionally identical.
 */
export function combineAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];

  // Prefer the native AbortSignal.any when available (Node 20.3+).
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') {
    return anyFn(defined);
  }

  // Manual fan-in: a single controller aborted by whichever input fires first.
  const controller = new AbortController();
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const s of defined) {
    if (s.aborted) {
      abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => abort(s.reason), { once: true });
  }
  return controller.signal;
}
