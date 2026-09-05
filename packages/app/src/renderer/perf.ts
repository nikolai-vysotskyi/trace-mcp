/**
 * Time to first *useful* paint, per screen (TRA-934).
 *
 * The harness already records `app-first-content` — the moment React commits
 * anything under #root. That is the shell: sidebar, header, skeletons. It says
 * nothing about when the user can read an answer, which is the number the
 * product is actually judged on.
 *
 * Each screen declares its own "useful" here: the first commit that renders
 * data rather than a placeholder, cached data included. A screen that opens on
 * a stale snapshot IS useful at that moment — that is the whole point of
 * keeping the snapshot — so `useUsefulPaint` fires then, not when the
 * revalidation lands.
 *
 * Read by `scripts/perf-screens.mjs` over CDP; `window.__traceUseful` exists so
 * the harness does not have to correlate `performance.mark` entries across a
 * navigation it did not cause.
 */
import { useEffect } from 'react';

export interface UsefulPaints {
  [screen: string]: number;
}

declare global {
  interface Window {
    __traceUseful?: UsefulPaints | undefined;
  }
}

const marked = new Set<string>();

/** Record the first useful paint of `screen`. Idempotent per window. */
export function markUseful(screen: string): void {
  if (marked.has(screen)) return;
  marked.add(screen);
  const at = performance.now();
  performance.mark(`useful:${screen}`);
  window.__traceUseful = { ...(window.__traceUseful ?? {}), [screen]: at };
}

/** Test seam — the mark is once-per-window, which a test suite is not. */
export function resetUsefulPaints(): void {
  marked.clear();
  window.__traceUseful = undefined;
}

/**
 * Mark `screen` useful the first time `ready` is true. In an effect rather
 * than in render: an effect runs after the commit that produced the frame, so
 * the timestamp belongs to content that exists, and StrictMode's double render
 * cannot record the same screen twice.
 */
export function useUsefulPaint(screen: string, ready: boolean): void {
  useEffect(() => {
    if (ready) markUseful(screen);
  }, [screen, ready]);
}
