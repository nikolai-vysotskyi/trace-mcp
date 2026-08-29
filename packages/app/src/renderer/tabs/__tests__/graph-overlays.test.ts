/* TRA-349 — the Graph Explorer overlay layer.

   Rendering GraphExplorerGPU needs a live WebGL context, so these read the
   source the way styles/__tests__/tokens.test.ts reads the stylesheets: the
   things that regressed here are declarations, not behaviour. What they guard:
   the hotspots panel ran six font sizes of its own (9 / 9.5 / 10 / 10.5px) and
   dimmed every secondary value with `opacity`, which put four text pairs under
   AA; loading painted a scrim and the word over a drawn graph; and the error
   was a toast that erased itself after 7s and left an unexplained blank pane. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../GraphExplorerGPU.tsx', import.meta.url)), 'utf8');

/** The overlay layer's rules out of the component's inline <style> block. */
function overlayRules(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const [, selector, body] of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const s = selector.trim().split('\n').pop()?.trim() ?? '';
    if (/^\.cosmos-gpu-(bn|error|pane)/.test(s)) out.push({ selector: s, body });
  }
  return out;
}

describe('graph overlay layer', () => {
  it('has rules to check', () => {
    expect(overlayRules().length).toBeGreaterThan(10);
  });

  it('takes every type size from the scale, never a literal px', () => {
    const offenders = overlayRules()
      .filter(({ body }) => /font(-size)?:/.test(body))
      .filter(({ body }) => !/var\(--text-/.test(body))
      .map(({ selector }) => selector);
    expect(offenders).toEqual([]);
  });

  it('dims secondary values with --label-secondary, never with opacity', () => {
    const offenders = overlayRules()
      .filter(({ body }) => /(^|[;\s])opacity:/.test(body))
      .map(({ selector }) => selector);
    expect(offenders).toEqual([]);
  });

  it('paints no scrim and no centred word over the graph while loading', () => {
    expect(src).not.toMatch(/\{loading && \(/);
    // The sentence lives in the stats pill, which is chrome that is already there.
    expect(src).toMatch(/cosmos-gpu-stats[\s\S]{0,240}Building graph/);
  });

  it('never auto-dismisses the error', () => {
    expect(src).not.toMatch(/setTimeout\([^;]*setError\(null\)/);
  });

  it('offers a retry in both the empty pane and the over-graph panel', () => {
    expect(src.match(/onClick=\{loadGraph\}/g)).toHaveLength(2);
  });
});
