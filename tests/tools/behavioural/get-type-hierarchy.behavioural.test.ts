/**
 * Behavioural coverage for `getTypeHierarchy()`. Seeds class/interface symbols
 * with `extends` / `implements` metadata so the json_extract-driven SQL in
 * findImplementors lights up, then asserts ancestors + descendants walking.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getTypeHierarchy } from '../../../src/tools/analysis/introspect.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

/**
 * Build a small hierarchy:
 *   interface IBase                              (top of implements tree)
 *   class Base                                    (top of extends tree)
 *   class Mid extends Base implements IBase
 *   class Leaf extends Mid
 *   class Implementor implements IBase            (sibling to Mid via interface)
 */
function seed(): Fixture {
  const store = createTestStore();

  const baseFid = store.insertFile('src/Base.ts', 'typescript', 'h-base', 100);
  store.insertSymbol(baseFid, {
    symbolId: 'src/Base.ts::Base#class',
    name: 'Base',
    kind: 'class',
    fqn: 'Base',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
  });

  const ibaseFid = store.insertFile('src/IBase.ts', 'typescript', 'h-ib', 50);
  store.insertSymbol(ibaseFid, {
    symbolId: 'src/IBase.ts::IBase#interface',
    name: 'IBase',
    kind: 'interface',
    fqn: 'IBase',
    byteStart: 0,
    byteEnd: 20,
    lineStart: 1,
    lineEnd: 3,
  });

  const midFid = store.insertFile('src/Mid.ts', 'typescript', 'h-mid', 100);
  store.insertSymbol(midFid, {
    symbolId: 'src/Mid.ts::Mid#class',
    name: 'Mid',
    kind: 'class',
    fqn: 'Mid',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 8,
    metadata: { extends: 'Base', implements: ['IBase'] },
  });

  const leafFid = store.insertFile('src/Leaf.ts', 'typescript', 'h-leaf', 100);
  store.insertSymbol(leafFid, {
    symbolId: 'src/Leaf.ts::Leaf#class',
    name: 'Leaf',
    kind: 'class',
    fqn: 'Leaf',
    byteStart: 0,
    byteEnd: 60,
    lineStart: 1,
    lineEnd: 6,
    metadata: { extends: 'Mid' },
  });

  const implFid = store.insertFile('src/Implementor.ts', 'typescript', 'h-impl', 100);
  store.insertSymbol(implFid, {
    symbolId: 'src/Implementor.ts::Implementor#class',
    name: 'Implementor',
    kind: 'class',
    fqn: 'Implementor',
    byteStart: 0,
    byteEnd: 60,
    lineStart: 1,
    lineEnd: 6,
    metadata: { implements: ['IBase'] },
  });

  return { store };
}

describe('getTypeHierarchy() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('output shape: { root, ancestors, descendants }', () => {
    const result = getTypeHierarchy(ctx.store, 'Mid');
    expect(result).toBeDefined();
    expect(result.root).toBe('Mid');
    expect(Array.isArray(result.ancestors)).toBe(true);
    expect(Array.isArray(result.descendants)).toBe(true);
  });

  it('class Mid extends Base → Base appears in Mid.ancestors', () => {
    const result = getTypeHierarchy(ctx.store, 'Mid');
    const ancestorNames = result.ancestors.map((a) => a.name);
    expect(ancestorNames).toContain('Base');
    const baseNode = result.ancestors.find((a) => a.name === 'Base');
    expect(baseNode?.relation).toBe('extends');
  });

  it('class Mid extends Base → Mid appears in Base.descendants', () => {
    const result = getTypeHierarchy(ctx.store, 'Base');
    const descendantNames = result.descendants.map((d) => d.name);
    expect(descendantNames).toContain('Mid');
  });

  it('class Implementor implements IBase → Implementor in IBase.descendants', () => {
    const result = getTypeHierarchy(ctx.store, 'IBase');
    const descendantNames = result.descendants.map((d) => d.name);
    expect(descendantNames).toContain('Implementor');
    // Mid also implements IBase, so it should be there too.
    expect(descendantNames).toContain('Mid');
  });

  it('multi-level chain Leaf -> Mid -> Base: ancestors walk reaches Base', () => {
    const result = getTypeHierarchy(ctx.store, 'Leaf');
    const top = result.ancestors.find((a) => a.name === 'Mid');
    expect(top).toBeDefined();
    // Mid's children (i.e. Mid's parents) must contain Base.
    const midChildren = top!.children.map((c) => c.name);
    expect(midChildren).toContain('Base');
  });

  it('multi-level chain Base -> Mid -> Leaf: descendants walk reaches Leaf', () => {
    const result = getTypeHierarchy(ctx.store, 'Base');
    const mid = result.descendants.find((d) => d.name === 'Mid');
    expect(mid).toBeDefined();
    const midChildren = mid!.children.map((c) => c.name);
    expect(midChildren).toContain('Leaf');
  });

  it('unknown name returns empty ancestors + descendants (does not throw)', () => {
    const result = getTypeHierarchy(ctx.store, 'NotARealClass');
    expect(result.root).toBe('NotARealClass');
    expect(result.ancestors).toEqual([]);
    expect(result.descendants).toEqual([]);
  });
});
