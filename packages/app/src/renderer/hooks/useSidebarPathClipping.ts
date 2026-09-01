/* useSidebarPathClipping.ts — hides the file row's location (.dir) when the
   filename (.name) alone fills the row (TRA-504).

   In styles/sidebar.css, .ws-sb-path gives .dir `flex-shrink: 999` and .name
   `flex-shrink: 1`. When the filename alone is wide enough to truncate, flexbox
   shrinks .dir to a 0–1 glyph sliver (e.g. `t`, `c`, `⌐`) instead of dropping
   it entirely.

   CSS has no "whole or nothing" condition, so this layout effect measures
   `nameEl.scrollWidth > nameEl.clientWidth` under the initial layout. When the
   filename is clipped, it adds `.is-name-clipped` to `.ws-sb-path`, which applies
   `display: none` to `.dir` so the filename takes the full row width cleanly. */

import { type DependencyList, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Scan a container for `.ws-sb-path` elements and toggle `.is-name-clipped`
 * when `.name` overflows its client width with `.dir` present.
 */
export function updateSidebarPathClipping(container: HTMLElement | null): void {
  if (!container) return;
  const paths = container.classList.contains('ws-sb-path')
    ? [container]
    : Array.from(container.querySelectorAll<HTMLElement>('.ws-sb-path'));

  if (paths.length === 0) return;

  // Step 1: remove is-name-clipped to let .dir participate in flex layout
  for (const path of paths) {
    path.classList.remove('is-name-clipped');
  }

  // Step 2: if .name truncated, hide .dir under .is-name-clipped
  for (const path of paths) {
    const nameEl = path.querySelector<HTMLElement>('.name');
    const dirEl = path.querySelector<HTMLElement>('.dir');
    if (!nameEl || !dirEl) continue;
    if (nameEl.scrollWidth > nameEl.clientWidth) {
      path.classList.add('is-name-clipped');
    }
  }
}

/**
 * Hook that maintains path clipping on a container ref across renders and resizes.
 */
export function useSidebarPathClipping<T extends HTMLElement = HTMLDivElement>(
  deps: DependencyList = [],
) {
  const ref = useRef<T | null>(null);

  useLayoutEffect(() => {
    updateSidebarPathClipping(ref.current);
    // biome-ignore lint/correctness/useExhaustiveDependencies: custom deps list provided by caller
  }, deps);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      updateSidebarPathClipping(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return ref;
}
