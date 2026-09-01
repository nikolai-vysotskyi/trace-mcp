/*
 * A file row shows its location whole, or not at all.
 *
 * The row is `<name><location>` on one flex line where the location absorbs
 * essentially all of the shrink, so the filename survives a 180–320px row
 * (TRA-503). What that leaves is the case where the filename alone fills the
 * row: the location does not disappear, it shrinks to a sliver —
 * `GraphExplorerGPU.t…  t  47` at the 220px default, and a clipped glyph
 * fragment at the 180px minimum, which reads as a rendering artifact rather
 * than as text. A lone `t` between a filename and a right-aligned count looks
 * like a status letter and carries no information either way (TRA-504).
 *
 * CSS has no "whole or nothing". A fixed `7ch` cap makes short filenames pay
 * (`types.ts` → `type…`) and `direction: rtl` head-elision is a no-op under
 * `unicode-bidi: plaintext` — both were measured and rejected in TRA-503. The
 * missing piece is one bit CSS cannot derive: whether the location fits. So it
 * gets measured here and spent on a class.
 */

import { type RefObject, useLayoutEffect } from 'react';

/**
 * Mark every `.ws-sb-path` under `host` whose location cannot render whole, and
 * unmark the rows where it fits again.
 *
 * The class comes off before the measurement because the measurement is only
 * meaningful with the location visible: a hidden element reports itself as
 * fitting, so a row that kept its class would flip state on every pass.
 */
export function syncWholeLocation(host: HTMLElement): void {
  for (const path of host.querySelectorAll<HTMLElement>('.ws-sb-path')) {
    const dir = path.querySelector<HTMLElement>('.dir');
    if (!dir) continue;
    path.classList.remove('is-loc-clipped');
    if (dir.scrollWidth > dir.clientWidth) path.classList.add('is-loc-clipped');
  }
}

/** Run `syncWholeLocation` over a container of rows whenever they, or its width, change. */
export function useWholeLocation(ref: RefObject<HTMLElement | null>): void {
  /* No dependency array on purpose: re-rendering is what changes which rows are
     in the container, and a ResizeObserver reports size only. Layout, not
     effect — the class has to be on before the first paint. */
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const sync = () => syncWholeLocation(host);
    sync();
    // jsdom has no ResizeObserver; the tests drive `syncWholeLocation` directly.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(sync);
    ro.observe(host);
    return () => ro.disconnect();
  });
}
