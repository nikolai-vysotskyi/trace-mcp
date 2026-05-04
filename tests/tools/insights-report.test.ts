import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { generateInsightsReport } from '../../src/tools/analysis/insights-report.js';
import { createTestStore } from '../test-utils.js';

function addSymbol(
  store: Store,
  opts: { filePath: string; name: string; kind: string },
): { fileId: number; nodeId: number } {
  const file = store.getFile(opts.filePath);
  const fileId = file ? file.id : store.insertFile(opts.filePath, 'typescript', null, null);
  const symbolDbId = store.insertSymbol(fileId, {
    symbolId: `${opts.filePath}::${opts.name}#${opts.kind}`,
    name: opts.name,
    kind: opts.kind as any,
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 10,
  });
  return { fileId, nodeId: store.getNodeId('symbol', symbolDbId)! };
}

describe('generate_insights_report', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    store.ensureEdgeType('calls', 'code', 'Function calls');
  });

  it('returns a structured report on an empty index', () => {
    const result = generateInsightsReport(store);
    expect(result.isOk()).toBe(true);
    const r = result._unsafeUnwrap();

    expect(r.totals).toEqual({ files: 0, symbols: 0, edges: 0 });
    expect(r.resolution_tiers).toEqual({
      lsp_resolved: 0,
      ast_resolved: 0,
      ast_inferred: 0,
      text_matched: 0,
      text_matched_pct: 0,
    });
    expect(r.god_files).toEqual([]);
    expect(r.bridges).toEqual([]);
    expect(typeof r.markdown).toBe('string');
    expect(r.markdown).toContain('# Project insights');
  });

  it('counts edges by resolution tier and computes text_matched_pct', () => {
    const a = addSymbol(store, { filePath: 'src/a.ts', name: 'A', kind: 'function' });
    const b = addSymbol(store, { filePath: 'src/b.ts', name: 'B', kind: 'function' });
    const c = addSymbol(store, { filePath: 'src/c.ts', name: 'C', kind: 'function' });
    const d = addSymbol(store, { filePath: 'src/d.ts', name: 'D', kind: 'function' });

    store.insertEdge(a.nodeId, b.nodeId, 'calls', true, undefined, false, 'lsp_resolved');
    store.insertEdge(b.nodeId, c.nodeId, 'calls', true, undefined, false, 'ast_resolved');
    store.insertEdge(c.nodeId, d.nodeId, 'calls', false, undefined, false, 'text_matched');
    store.insertEdge(d.nodeId, a.nodeId, 'calls', false, undefined, false, 'text_matched');

    const result = generateInsightsReport(store);
    expect(result.isOk()).toBe(true);
    const r = result._unsafeUnwrap();

    expect(r.resolution_tiers.lsp_resolved).toBe(1);
    expect(r.resolution_tiers.ast_resolved).toBe(1);
    expect(r.resolution_tiers.text_matched).toBe(2);
    expect(r.resolution_tiers.text_matched_pct).toBe(50);
    expect(r.markdown).toContain('text_matched');
    expect(r.markdown).toMatch(/⚠.*text_matched/);
  });

  it('includes markdown sections for god files, bridges, hotspots, gaps', () => {
    const result = generateInsightsReport(store);
    expect(result.isOk()).toBe(true);
    const md = result._unsafeUnwrap().markdown;

    expect(md).toContain('## Edge resolution');
    expect(md).toContain('## God files');
    expect(md).toContain('## Architectural bridges');
    expect(md).toContain('## Risk hotspots');
    expect(md).toContain('## Gaps');
  });

  it('respects topN parameter', () => {
    const result = generateInsightsReport(store, { topN: 3 });
    expect(result.isOk()).toBe(true);
    const r = result._unsafeUnwrap();
    expect(r.god_files.length).toBeLessThanOrEqual(3);
    expect(r.bridges.length).toBeLessThanOrEqual(3);
    expect(r.hotspots.length).toBeLessThanOrEqual(3);
    expect(r.gaps.dead_exports_examples.length).toBeLessThanOrEqual(3);
  });
});
