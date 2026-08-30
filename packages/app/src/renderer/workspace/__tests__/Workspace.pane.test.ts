/**
 * TRA-325: the Workspace has to survive the smallest window the app allows —
 * `minWidth: 640, minHeight: 420` in `main/tray.ts`. Measured on the running
 * renderer at 640×420 before this landed: the KPI grid was 357px tall, the
 * toolbar's top edge sat at y=401 with its bottom 33px past the window, and the
 * project list was 1px tall at y=465. No ancestor was scrollable, so none of it
 * could be reached.
 *
 * Both thresholds are read off the pane, not the window: the sidebar is
 * resizable 180–320px and collapsible, so window width says little about how
 * much room this surface actually has.
 */
import { describe, expect, it } from 'vitest';
import { TABLE_MIN_PANE_W, isDensePane, isNarrowPane, kpiStripHeight } from '../Workspace';

/** Pane geometry for a window, with the default 220px sidebar and 44px header. */
const pane = (winW: number, winH: number) => ({ w: winW - 220, h: winH - 44 });

describe('kpiStripHeight', () => {
  it('reproduces the strip measured at the minimum window', () => {
    // 640 − 220 = a 420px pane: two tiles per row, three rows of 112px.
    expect(kpiStripHeight(420)).toBe(396);
  });

  it('is one row of tiles once the pane fits all six', () => {
    expect(kpiStripHeight(1060)).toBe(112 + 28);
  });

  it('never divides by a zero-width pane', () => {
    expect(kpiStripHeight(0)).toBe(6 * 112 + 5 * 16 + 28);
  });
});

describe('isNarrowPane', () => {
  it('treats an unmeasured pane as wide', () => {
    // The first paint runs before ResizeObserver reports. Guessing "narrow"
    // there would flash Compact on every launch of a full-size window.
    expect(isNarrowPane(0)).toBe(false);
  });

  it('is narrow at the app minimum window', () => {
    expect(isNarrowPane(pane(640, 420).w)).toBe(true);
  });

  it('leaves the table alone at ordinary window sizes', () => {
    for (const w of [800, 960, 1280, 1680]) {
      expect(isNarrowPane(pane(w, 700).w)).toBe(false);
    }
  });

  it('follows the pane, not the window — a widened sidebar narrows it too', () => {
    // 800px window with the sidebar dragged to its 320px maximum.
    expect(isNarrowPane(800 - 320)).toBe(true);
  });

  it('switches exactly at the threshold', () => {
    expect(isNarrowPane(TABLE_MIN_PANE_W - 1)).toBe(true);
    expect(isNarrowPane(TABLE_MIN_PANE_W)).toBe(false);
  });

  it('leaves the table a scroll window worth scrolling when it does allow it', () => {
    // checkbox 32 + Project 240 + Actions 100 are pinned and never scroll.
    expect(TABLE_MIN_PANE_W - 32 - (32 + 240 + 100)).toBeGreaterThanOrEqual(160);
  });
});

describe('isDensePane', () => {
  it('is dense at the app minimum window', () => {
    const p = pane(640, 420);
    // 376 − 52 toolbar − 396 strip is negative: the list had nowhere to be.
    expect(isDensePane(p.w, p.h)).toBe(true);
  });

  it('is dense on a pane too short for the strip however wide it is', () => {
    expect(isDensePane(1200, 200)).toBe(true);
  });

  it('is not dense at the default 960×700 window', () => {
    const p = pane(960, 700);
    expect(isDensePane(p.w, p.h)).toBe(false);
  });

  it('is not dense at ordinary window sizes', () => {
    for (const [w, h] of [
      [800, 600],
      [1280, 800],
      [1680, 1050],
    ] as const) {
      const p = pane(w, h);
      expect(isDensePane(p.w, p.h)).toBe(false);
    }
  });

  it('treats an unmeasured pane as roomy', () => {
    expect(isDensePane(0, 0)).toBe(false);
  });

  it('always leaves two project rows when it declines to collapse', () => {
    for (let winW = 640; winW <= 1600; winW += 40) {
      for (let winH = 420; winH <= 1200; winH += 40) {
        const p = pane(winW, winH);
        if (isDensePane(p.w, p.h)) continue;
        expect(p.h - 52 - kpiStripHeight(p.w)).toBeGreaterThanOrEqual(92);
      }
    }
  });
});
