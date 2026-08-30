/**
 * @vitest-environment jsdom
 */
/* TRA-524 — a floating layer opened from a content pane must not slide over the
   sidebar. The graph's filter popover is wider than the Filter button it hangs
   off, so with `align="end"` its left edge lands well left of the anchor; the
   layer used to clamp that against the window, which put a content overlay on
   top of navigation chrome.
 *
 * jsdom does no layout, so the layer's box is stubbed (offsetWidth/Height) and
 * the pane reports a fixed rect — which is all clamp() actually reads. */

import { render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FloatingLayer } from '../FloatingLayer';

const LAYER_W = 700;
const LAYER_H = 120;
/** The pane the graph renders into: sidebar 260px wide, window 1200px. */
const PANE = { left: 260, right: 1180, width: 920 };

function stubBox(w: number, h: number): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => w,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => h,
  });
}

function paneEl(rect: { left: number; right: number; width: number }): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({ ...rect, top: 0, bottom: 800, x: rect.left, y: 0, toJSON: () => ({}) }) as DOMRect;
  return el;
}

beforeEach(() => {
  window.innerWidth = 1200;
  window.innerHeight = 800;
  stubBox(LAYER_W, LAYER_H);
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  stubBox(0, 0);
});

function renderLayer(bounds?: HTMLElement, anchorX = 860) {
  const ref = createRef<HTMLDivElement>();
  const boundsRef = { current: bounds ?? null };
  render(
    <FloatingLayer ref={ref} className="p" x={anchorX} y={100} align="end" boundsRef={boundsRef}>
      <span>filters</span>
    </FloatingLayer>,
  );
  return ref.current as HTMLDivElement;
}

describe('FloatingLayer bounds', () => {
  it('without bounds, an end-aligned wide layer runs left past the sidebar', () => {
    // Documents the old behaviour the graph popover was getting: 860 - 700 = 160,
    // which is inside a 260px-wide sidebar.
    const el = renderLayer(undefined);
    expect(Number.parseFloat(el.style.left)).toBe(160);
  });

  it('with a pane, the layer stays flush inside the pane instead', () => {
    const el = renderLayer(paneEl(PANE));
    const left = Number.parseFloat(el.style.left);
    expect(left).toBeGreaterThanOrEqual(PANE.left);
    expect(left + LAYER_W).toBeLessThanOrEqual(PANE.right);
  });

  it('caps the layer width to the pane so a narrow pane cannot be overflowed', () => {
    const narrow = { left: 260, right: 660, width: 400 };
    const el = renderLayer(paneEl(narrow), 640);
    expect(el.style.maxWidth).toBe(`${narrow.width - 16}px`);
  });

  it('leaves width uncapped and clamps to the window when no pane is given', () => {
    const el = renderLayer(undefined);
    expect(el.style.maxWidth).toBe('');
  });
});
