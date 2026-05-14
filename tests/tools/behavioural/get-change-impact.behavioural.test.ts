/**
 * Behavioural coverage for `getChangeImpact()`. Uses an in-memory Store with
 * hand-built file + symbol + edge fixtures so we can assert output contract
 * (risk, dependents, totalAffected, depth, maxDependents) without relying on
 * the indexing pipeline.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getChangeImpact } from '../../../src/tools/analysis/impact.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
  targetSymbolId: string;
  isolatedSymbolId: string;
}

/**
 * Build a tiny dependency chain:
 *   targetSymbol (in target.ts)
 *     ← depth-1 dependents in callerA.ts, callerB.ts, callerC.ts
 *   isolatedSymbol (in isolated.ts) has no incoming edges.
 */
function seed(): Fixture {
  const store = createTestStore();

  const targetFile = store.insertFile('src/target.ts', 'typescript', 'h-target', 200);
  const targetSym = store.insertSymbol(targetFile, {
    symbolId: 'src/target.ts::Target#function',
    name: 'Target',
    kind: 'function',
    fqn: 'Target',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 10,
  });
  const targetNid = store.getNodeId('symbol', targetSym);

  for (const name of ['callerA', 'callerB', 'callerC']) {
    const fid = store.insertFile(`src/${name}.ts`, 'typescript', `h-${name}`, 150);
    const sym = store.insertSymbol(fid, {
      symbolId: `src/${name}.ts::${name}#function`,
      name,
      kind: 'function',
      fqn: name,
      byteStart: 0,
      byteEnd: 60,
      lineStart: 1,
      lineEnd: 8,
    });
    const nid = store.getNodeId('symbol', sym);
    if (nid != null && targetNid != null) {
      store.insertEdge(nid, targetNid, 'calls', true, undefined, false, 'ast_resolved');
    }
  }

  // Isolated leaf: a different file with no callers.
  const isoFile = store.insertFile('src/isolated.ts', 'typescript', 'h-iso', 100);
  store.insertSymbol(isoFile, {
    symbolId: 'src/isolated.ts::lonely#function',
    name: 'lonely',
    kind: 'function',
    fqn: 'lonely',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 5,
  });

  return {
    store,
    targetSymbolId: 'src/target.ts::Target#function',
    isolatedSymbolId: 'src/isolated.ts::lonely#function',
  };
}

describe('getChangeImpact() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('returns risk + dependents + totalAffected on a basic symbolId query', () => {
    const result = getChangeImpact(ctx.store, { symbolId: ctx.targetSymbolId });
    expect(result.isOk()).toBe(true);
    const impact = result._unsafeUnwrap();
    expect(impact.risk).toBeDefined();
    expect(['low', 'medium', 'high', 'critical']).toContain(impact.risk.level);
    expect(Array.isArray(impact.dependents)).toBe(true);
    expect(typeof impact.totalAffected).toBe('number');
    expect(impact.totalAffected).toBe(impact.dependents.length);
  });

  it('finds the wired callers as dependents (>=3)', () => {
    const result = getChangeImpact(ctx.store, { symbolId: ctx.targetSymbolId });
    expect(result.isOk()).toBe(true);
    const dep = result._unsafeUnwrap().dependents;
    const paths = dep.map((d) => d.path);
    expect(paths).toContain('src/callerA.ts');
    expect(paths).toContain('src/callerB.ts');
    expect(paths).toContain('src/callerC.ts');
  });

  it('depth=1 result is a (non-strict) subset of depth=3 result', () => {
    const shallow = getChangeImpact(ctx.store, { symbolId: ctx.targetSymbolId }, 1);
    const deep = getChangeImpact(ctx.store, { symbolId: ctx.targetSymbolId }, 3);
    expect(shallow.isOk() && deep.isOk()).toBe(true);
    const shallowSet = new Set(shallow._unsafeUnwrap().dependents.map((d) => d.path));
    const deepSet = new Set(deep._unsafeUnwrap().dependents.map((d) => d.path));
    for (const p of shallowSet) {
      expect(deepSet.has(p)).toBe(true);
    }
  });

  it('respects maxDependents cap', () => {
    const result = getChangeImpact(ctx.store, { symbolId: ctx.targetSymbolId }, 3, 1);
    expect(result.isOk()).toBe(true);
    const impact = result._unsafeUnwrap();
    expect(impact.dependents.length).toBeLessThanOrEqual(1);
  });

  it('isolated symbol returns empty dependents and low risk', () => {
    const result = getChangeImpact(ctx.store, { symbolId: ctx.isolatedSymbolId });
    expect(result.isOk()).toBe(true);
    const impact = result._unsafeUnwrap();
    expect(impact.dependents).toEqual([]);
    expect(impact.totalAffected).toBe(0);
    expect(impact.risk.level).toBe('low');
  });
});
