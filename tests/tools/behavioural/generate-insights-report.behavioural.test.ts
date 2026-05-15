/**
 * Behavioural coverage for `generateInsightsReport()` in
 * `src/tools/analysis/insights-report.ts` (the implementation behind the
 * `generate_insights_report` MCP tool). Aggregates PageRank, hotspots,
 * edge bottlenecks, self-audit, and edge resolution tiers into one
 * narrative payload + Markdown rendering.
 *
 * Envelope: { generated_at, totals, resolution_tiers, god_files,
 * bridges, hotspots, gaps, markdown }
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { generateInsightsReport } from '../../../src/tools/analysis/insights-report.js';
import { createTestStore } from '../../test-utils.js';

function seed(store: Store): void {
  const a = store.insertFile('src/a.ts', 'typescript', 'h-a', 400);
  store.insertSymbol(a, {
    symbolId: 'src/a.ts::doA#function',
    name: 'doA',
    kind: 'function',
    byteStart: 0,
    byteEnd: 40,
    lineStart: 1,
    lineEnd: 5,
    signature: 'function doA()',
    metadata: { exported: 1 },
  });
  const b = store.insertFile('src/b.ts', 'typescript', 'h-b', 300);
  store.insertSymbol(b, {
    symbolId: 'src/b.ts::doB#function',
    name: 'doB',
    kind: 'function',
    byteStart: 0,
    byteEnd: 40,
    lineStart: 1,
    lineEnd: 5,
    signature: 'function doB()',
    metadata: { exported: 1 },
  });
}

describe('generateInsightsReport() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns the documented envelope shape', () => {
    seed(store);
    const result = generateInsightsReport(store);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const v = result.value;
    expect(typeof v.generated_at).toBe('string');
    expect(typeof v.totals).toBe('object');
    expect(typeof v.resolution_tiers).toBe('object');
    expect(Array.isArray(v.god_files)).toBe(true);
    expect(Array.isArray(v.bridges)).toBe(true);
    expect(Array.isArray(v.hotspots)).toBe(true);
    expect(typeof v.gaps).toBe('object');
    expect(typeof v.markdown).toBe('string');
  });

  it('generated_at is a valid ISO timestamp', () => {
    const result = generateInsightsReport(store);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(Number.isNaN(Date.parse(result.value.generated_at))).toBe(false);
    expect(result.value.generated_at).toMatch(/T/);
  });

  it('totals carry numeric file/symbol/edge counts', () => {
    seed(store);
    const result = generateInsightsReport(store);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const t = result.value.totals;
    expect(typeof t.files).toBe('number');
    expect(typeof t.symbols).toBe('number');
    expect(typeof t.edges).toBe('number');
    expect(t.files).toBeGreaterThanOrEqual(2);
    expect(t.symbols).toBeGreaterThanOrEqual(2);
  });

  it('resolution_tiers has lsp/ast/text fields + text_matched_pct', () => {
    const result = generateInsightsReport(store);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const r = result.value.resolution_tiers;
    expect(typeof r.lsp_resolved).toBe('number');
    expect(typeof r.ast_resolved).toBe('number');
    expect(typeof r.ast_inferred).toBe('number');
    expect(typeof r.text_matched).toBe('number');
    expect(typeof r.text_matched_pct).toBe('number');
  });

  it('topN respected per section (god_files/bridges/hotspots ≤ topN)', () => {
    // Seed several files so god_files actually has candidates to cap.
    for (let i = 0; i < 10; i++) {
      const f = store.insertFile(`src/x${i}.ts`, 'typescript', `h-x${i}`, 100);
      store.insertSymbol(f, {
        symbolId: `src/x${i}.ts::x${i}#function`,
        name: `x${i}`,
        kind: 'function',
        byteStart: 0,
        byteEnd: 20,
        lineStart: 1,
        lineEnd: 1,
        signature: `function x${i}()`,
      });
    }
    const result = generateInsightsReport(store, { topN: 2 });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.god_files.length).toBeLessThanOrEqual(2);
    expect(result.value.bridges.length).toBeLessThanOrEqual(2);
    expect(result.value.hotspots.length).toBeLessThanOrEqual(2);
    expect(result.value.gaps.dead_exports_examples.length).toBeLessThanOrEqual(2);
    expect(result.value.gaps.untested_examples.length).toBeLessThanOrEqual(2);
  });

  it('markdown contains documented section headers', () => {
    const result = generateInsightsReport(store);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const md = result.value.markdown;
    expect(md).toContain('# Project insights');
    expect(md).toContain('## Edge resolution');
    expect(md).toContain('## God files (PageRank)');
    expect(md).toContain('## Architectural bridges');
    expect(md).toContain('## Risk hotspots');
    expect(md).toContain('## Gaps');
  });

  it('empty index returns a valid envelope with empty sections', () => {
    const result = generateInsightsReport(store);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const v = result.value;
    expect(v.totals.files).toBe(0);
    expect(v.god_files).toEqual([]);
    expect(v.bridges).toEqual([]);
    expect(v.hotspots).toEqual([]);
    expect(v.gaps.dead_exports_examples).toEqual([]);
    expect(v.gaps.untested_examples).toEqual([]);
    // Markdown is still rendered with the section headers, just empty content.
    expect(v.markdown).toContain('# Project insights');
  });
});
