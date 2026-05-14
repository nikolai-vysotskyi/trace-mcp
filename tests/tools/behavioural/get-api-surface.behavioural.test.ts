/**
 * Behavioural coverage for `getApiSurface()`. Seeds symbols with the
 * `metadata.exported = 1` marker (the contract used by getExportedSymbols)
 * and asserts file grouping, file_pattern filter, per-export shape, and
 * empty-store contract.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { getApiSurface } from '../../../src/tools/analysis/introspect.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

/**
 * Insert one exported function in src/a.ts, one exported class in src/b.ts,
 * and one non-exported helper in src/a.ts. The non-exported symbol must NOT
 * appear in the API surface.
 */
function seed(): Fixture {
  const store = createTestStore();

  const fidA = store.insertFile('src/a.ts', 'typescript', 'h-a', 200);
  store.insertSymbol(fidA, {
    symbolId: 'src/a.ts::publicFn#function',
    name: 'publicFn',
    kind: 'function',
    fqn: 'publicFn',
    signature: 'function publicFn(x: number): string',
    byteStart: 0,
    byteEnd: 60,
    lineStart: 1,
    lineEnd: 5,
    metadata: { exported: 1 },
  } as never);

  // Internal — should never appear in api surface.
  store.insertSymbol(fidA, {
    symbolId: 'src/a.ts::internalHelper#function',
    name: 'internalHelper',
    kind: 'function',
    fqn: 'internalHelper',
    byteStart: 70,
    byteEnd: 130,
    lineStart: 7,
    lineEnd: 12,
    // intentionally NO exported marker
  } as never);

  const fidB = store.insertFile('src/b.ts', 'typescript', 'h-b', 150);
  store.insertSymbol(fidB, {
    symbolId: 'src/b.ts::PublicClass#class',
    name: 'PublicClass',
    kind: 'class',
    fqn: 'PublicClass',
    signature: 'class PublicClass',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 10,
    metadata: { exported: 1 },
  } as never);

  // Different directory — filtered out by `src/*.ts` glob.
  const fidC = store.insertFile('lib/other.ts', 'typescript', 'h-c', 80);
  store.insertSymbol(fidC, {
    symbolId: 'lib/other.ts::libFn#function',
    name: 'libFn',
    kind: 'function',
    fqn: 'libFn',
    byteStart: 0,
    byteEnd: 40,
    lineStart: 1,
    lineEnd: 3,
    metadata: { exported: 1 },
  } as never);

  return { store };
}

describe('getApiSurface() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('groups exported symbols by file', () => {
    const result = getApiSurface(ctx.store);
    expect(result.files.length).toBe(3);
    const paths = result.files.map((f) => f.file).sort();
    expect(paths).toEqual(['lib/other.ts', 'src/a.ts', 'src/b.ts']);
    expect(result.total_symbols).toBe(3);
  });

  it('does NOT include non-exported symbols', () => {
    const result = getApiSurface(ctx.store);
    const allNames = result.files.flatMap((f) => f.exports.map((e) => e.name));
    expect(allNames).not.toContain('internalHelper');
    expect(allNames).toContain('publicFn');
    expect(allNames).toContain('PublicClass');
  });

  it('file_pattern filter narrows scope', () => {
    const result = getApiSurface(ctx.store, 'src/*');
    const paths = result.files.map((f) => f.file).sort();
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.file_pattern).toBe('src/*');
    expect(result.total_symbols).toBe(2);
  });

  it('each export has name + kind + signature + line + default fields', () => {
    const result = getApiSurface(ctx.store);
    for (const file of result.files) {
      for (const exp of file.exports) {
        expect(typeof exp.symbol_id).toBe('string');
        expect(typeof exp.name).toBe('string');
        expect(typeof exp.kind).toBe('string');
        // signature can be string OR null — both are valid per ApiSurfaceSymbol.
        expect(['string', 'object']).toContain(typeof exp.signature);
        expect(typeof exp.default).toBe('boolean');
      }
    }
    const fileA = result.files.find((f) => f.file === 'src/a.ts')!;
    const publicFn = fileA.exports.find((e) => e.name === 'publicFn')!;
    expect(publicFn.kind).toBe('function');
    expect(publicFn.signature).toBe('function publicFn(x: number): string');
  });

  it('empty store returns empty files list and zero total_symbols', () => {
    const emptyStore = createTestStore();
    const result = getApiSurface(emptyStore);
    expect(result.files).toEqual([]);
    expect(result.total_symbols).toBe(0);
    expect(result.file_pattern).toBeNull();
  });
});
