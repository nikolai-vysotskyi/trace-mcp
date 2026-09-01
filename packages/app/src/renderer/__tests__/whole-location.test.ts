// @vitest-environment jsdom
/* TRA-504. `.dir` absorbs all of the row's shrink, so a filename that fills the
   row leaves it a sliver rather than nothing: `GraphExplorerGPU.t…  t  47` at
   the 220px default, a clipped glyph fragment at the 180px minimum. The rule is
   whole or not at all, and the only thing CSS cannot supply is whether it fits.

   jsdom lays nothing out, so the widths are stubbed. `clientWidth` reports 0
   once the row carries the class, the way `display: none` does — that is what
   makes the second call in "does not flip" a real check rather than a repeat. */

import { describe, expect, it } from 'vitest';
import { syncWholeLocation } from '../whole-location';

/** One `.ws-sb-path` row whose location wants `wants` px and is given `given`. */
function row(host: HTMLElement, name: string, dir: string, wants: number, given: number): void {
  const path = document.createElement('span');
  path.className = 'ws-sb-path';
  path.innerHTML = `<span class="name">${name}</span><span class="dir">${dir}</span>`;
  const el = path.querySelector('.dir') as HTMLElement;
  Object.defineProperty(el, 'scrollWidth', { get: () => wants });
  Object.defineProperty(el, 'clientWidth', {
    get: () => (path.classList.contains('is-loc-clipped') ? 0 : given),
  });
  host.append(path);
}

function locations(host: HTMLElement): boolean[] {
  return [...host.querySelectorAll('.ws-sb-path')].map(
    (p) => !p.classList.contains('is-loc-clipped'),
  );
}

describe('syncWholeLocation', () => {
  it('hides a location that does not fit and keeps one that does', () => {
    const host = document.createElement('div');
    row(host, 'Settings.tsx', 'tabs', 28, 28); // fits exactly
    row(host, 'GraphExplorerGPU.tsx', 'tabs', 28, 6); // one glyph left
    row(host, 'MemoryExplorer.tsx', 'tabs', 28, 0); // squeezed to nothing
    syncWholeLocation(host);
    expect(locations(host)).toEqual([true, false, false]);
  });

  it('does not flip a hidden location back on, pass after pass', () => {
    const host = document.createElement('div');
    row(host, 'GraphExplorerGPU.tsx', 'tabs', 28, 6);
    syncWholeLocation(host);
    syncWholeLocation(host);
    expect(locations(host)).toEqual([false]);
  });

  it('shows the location again once the row is widened', () => {
    const host = document.createElement('div');
    const path = document.createElement('span');
    path.className = 'ws-sb-path';
    path.innerHTML = '<span class="name">Settings.tsx</span><span class="dir">tabs</span>';
    const el = path.querySelector('.dir') as HTMLElement;
    let given = 6;
    Object.defineProperty(el, 'scrollWidth', { get: () => 28 });
    Object.defineProperty(el, 'clientWidth', {
      get: () => (path.classList.contains('is-loc-clipped') ? 0 : given),
    });
    host.append(path);

    syncWholeLocation(host);
    expect(locations(host)).toEqual([false]);
    given = 28;
    syncWholeLocation(host);
    expect(locations(host)).toEqual([true]);
  });

  // A file at the project root renders no `.dir` at all (TRA-503).
  it('leaves a row without a location alone', () => {
    const host = document.createElement('div');
    host.innerHTML = '<span class="ws-sb-path"><span class="name">README.md</span></span>';
    expect(() => syncWholeLocation(host)).not.toThrow();
    expect(locations(host)).toEqual([true]);
  });
});
