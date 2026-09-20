/* TRA-1741 — Graph auto-fit must frame the point cloud, not the simulation space.
   fitView() frames cosmos.gl's [0, spaceSize] square, so a cloud settled in a
   fraction of it renders as a tiny central blob. All automatic camera fits
   (immediate post-render, throttled live-fit, final settle fit) must go through
   fitAllPoints, which fits over every point index. Rendering needs WebGL, so
   like graph-overlays.test.ts this guards declarations in source. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../GraphExplorerGPU.tsx', import.meta.url)), 'utf8');

describe('graph auto-fit (TRA-1741)', () => {
  it('defines a point-bbox fit helper', () => {
    expect(src).toMatch(/function fitAllPoints\(/);
    expect(src).toMatch(/fitViewByPointIndices/);
  });

  it('routes live-fit and final settle fit through the helper', () => {
    // onSimulationTick has two auto fits: final (800ms) + throttled live (0ms).
    const uses = src.match(/fitAllPoints\(g, nodesRef\.current\.length, (800|0), 0\.2\)/g) ?? [];
    expect(uses).toHaveLength(2);
  });

  it('routes the immediate post-render fit through the helper', () => {
    expect(src).toMatch(/fitAllPoints\(gg, nodesRef\.current\.length, 500, 0\.2\)/);
  });

  it('keeps the manual Fit button on the same helper', () => {
    expect(src).toMatch(/fitAllPoints\(g, nodesRef\.current\.length, 500, 0\.15\)/);
  });

  it('has no bare space-framing fits left on the auto paths', () => {
    // The only remaining .fitView( call is the empty-graph fallback inside
    // fitAllPoints itself (receiver named `graph`, not g/gg).
    expect(src).not.toMatch(/\bg\.fitView\(/);
    expect(src).not.toMatch(/\bgg\.fitView\(/);
  });
});
