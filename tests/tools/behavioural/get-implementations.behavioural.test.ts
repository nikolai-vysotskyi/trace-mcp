/**
 * Behavioural coverage for `getImplementations()`. Seeds class/interface
 * symbols with `extends` / `implements` metadata and asserts the returned
 * shape — { target, implementors, total } — including relation tagging.
 *
 * NOTE: The brief calls the array `implementations` and the field set
 * `{ symbol_id, name, kind, file, line }`, but the live contract returns
 * `implementors` with `{ symbol_id, name, kind, signature, file, line,
 * relation, via }`. We assert against the live contract, not the brief.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getImplementations } from '../../../src/tools/analysis/introspect.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

/**
 * Seed:
 *   interface IBase
 *   class ImplA implements IBase
 *   class ImplB implements IBase
 *   class Base                                  (base class with 2 subclasses)
 *   class SubX extends Base
 *   class SubY extends Base
 */
function seed(): Fixture {
  const store = createTestStore();

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

  const aFid = store.insertFile('src/ImplA.ts', 'typescript', 'h-ia', 100);
  store.insertSymbol(aFid, {
    symbolId: 'src/ImplA.ts::ImplA#class',
    name: 'ImplA',
    kind: 'class',
    fqn: 'ImplA',
    byteStart: 0,
    byteEnd: 60,
    lineStart: 1,
    lineEnd: 6,
    metadata: { implements: ['IBase'] },
  });

  const bFid = store.insertFile('src/ImplB.ts', 'typescript', 'h-ib2', 100);
  store.insertSymbol(bFid, {
    symbolId: 'src/ImplB.ts::ImplB#class',
    name: 'ImplB',
    kind: 'class',
    fqn: 'ImplB',
    byteStart: 0,
    byteEnd: 60,
    lineStart: 7,
    lineEnd: 12,
    metadata: { implements: ['IBase'] },
  });

  const baseFid = store.insertFile('src/Base.ts', 'typescript', 'h-base', 100);
  store.insertSymbol(baseFid, {
    symbolId: 'src/Base.ts::Base#class',
    name: 'Base',
    kind: 'class',
    fqn: 'Base',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 8,
  });

  const xFid = store.insertFile('src/SubX.ts', 'typescript', 'h-sx', 100);
  store.insertSymbol(xFid, {
    symbolId: 'src/SubX.ts::SubX#class',
    name: 'SubX',
    kind: 'class',
    fqn: 'SubX',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
    metadata: { extends: 'Base' },
  });

  const yFid = store.insertFile('src/SubY.ts', 'typescript', 'h-sy', 100);
  store.insertSymbol(yFid, {
    symbolId: 'src/SubY.ts::SubY#class',
    name: 'SubY',
    kind: 'class',
    fqn: 'SubY',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 6,
    lineEnd: 10,
    metadata: { extends: 'Base' },
  });

  return { store };
}

describe('getImplementations() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('interface with two implementing classes returns both, tagged as implements', () => {
    const result = getImplementations(ctx.store, 'IBase');
    expect(result.target).toBe('IBase');
    expect(result.total).toBe(2);
    const names = result.implementors.map((i) => i.name).sort();
    expect(names).toEqual(['ImplA', 'ImplB']);
    for (const item of result.implementors) {
      expect(item.relation).toBe('implements');
    }
  });

  it('base class with two subclasses returns both, tagged as extends', () => {
    const result = getImplementations(ctx.store, 'Base');
    expect(result.target).toBe('Base');
    expect(result.total).toBe(2);
    const names = result.implementors.map((i) => i.name).sort();
    expect(names).toEqual(['SubX', 'SubY']);
    for (const item of result.implementors) {
      expect(item.relation).toBe('extends');
    }
  });

  it('unknown name returns empty implementors list with total=0', () => {
    const result = getImplementations(ctx.store, 'NotARealName');
    expect(result.target).toBe('NotARealName');
    expect(result.total).toBe(0);
    expect(result.implementors).toEqual([]);
  });

  it('each implementor has { symbol_id, name, kind, file, line, relation }', () => {
    const result = getImplementations(ctx.store, 'IBase');
    expect(result.implementors.length).toBeGreaterThan(0);
    for (const item of result.implementors) {
      expect(typeof item.symbol_id).toBe('string');
      expect(item.symbol_id.length).toBeGreaterThan(0);
      expect(typeof item.name).toBe('string');
      expect(typeof item.kind).toBe('string');
      expect(typeof item.file).toBe('string');
      // line is number | null per the interface
      expect(item.line === null || typeof item.line === 'number').toBe(true);
      expect(['implements', 'extends']).toContain(item.relation);
    }
  });

  it('output shape: { target, implementors, total }', () => {
    const result = getImplementations(ctx.store, 'IBase');
    expect(Object.keys(result).sort()).toEqual(['implementors', 'target', 'total']);
    expect(result.total).toBe(result.implementors.length);
  });
});
