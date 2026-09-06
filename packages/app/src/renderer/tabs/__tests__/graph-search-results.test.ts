/* TRA-1058 #4 — the Graph search-results dropdown ("Select all N matches" +
   file matches) used `.viz-glass`, the canvas's translucent overlay material.
   Over the graph's own dark labels-on-light-tiles, that turned the list into
   a double exposure — readable neither as graph nor as list. It also sat at
   z-40 while the Filter popover sits at z-60, so opening Filter while search
   results were showing buried "Select all N matches" and the first row under
   the filter panel. Read the same way graph-overlays.test.ts does: the source
   file's inline <style> block, since rendering needs a live WebGL context. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../GraphExplorerGPU.tsx', import.meta.url)), 'utf8');

function rule(selector: string): string {
  const m = src.match(new RegExp(`\\.${selector}\\s*\\{([^{}]*)\\}`));
  if (!m) throw new Error(`no rule found for .${selector}`);
  return m[1];
}

describe('graph search-results dropdown', () => {
  it('is not the canvas glass material', () => {
    expect(src).toMatch(/cosmos-gpu-search-results[^"]*"\s*\n\s*style=\{\{ borderRadius: 'var\(--radius-popover\)'/);
    expect(src).not.toMatch(/viz-glass absolute z-40/);
  });

  it('renders opaque, no blur', () => {
    const body = rule('cosmos-gpu-search-results');
    expect(body).toMatch(/background:\s*var\(--surface-raised\)/);
    expect(body).not.toMatch(/backdrop-filter:\s*blur/);
  });

  it('stacks above the Filter popover', () => {
    const resultsZ = Number(rule('cosmos-gpu-search-results').match(/z-index:\s*(\d+)/)?.[1]);
    const popoverZ = Number(rule('cosmos-gpu-popover').match(/z-index:\s*(\d+)/)?.[1]);
    expect(resultsZ).toBeGreaterThan(popoverZ);
  });
});
