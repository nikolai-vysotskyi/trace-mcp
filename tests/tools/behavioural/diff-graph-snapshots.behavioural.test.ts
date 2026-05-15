/**
 * Behavioural coverage for `diffSnapshots()`. Captures two snapshots from
 * graphs of different sizes and verifies positive/zero deltas, missing-name
 * null contract, and the expected output shape sections.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { captureSnapshot, diffSnapshots } from '../../../src/tools/analysis/graph-snapshot.js';
import { createTestStore } from '../../test-utils.js';

function insertFileWithFn(store: Store, path: string, name: string): number {
  const fid = store.insertFile(path, 'typescript', `h-${path}`, 100);
  store.insertSymbol(fid, {
    symbolId: `${path}::${name}#function`,
    name,
    kind: 'function',
    fqn: name,
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 3,
  });
  return fid;
}

interface Fixture {
  store: Store;
}

function seedBase(): Fixture {
  const store = createTestStore();
  insertFileWithFn(store, 'src/a.ts', 'fnA');
  return { store };
}

describe('diffSnapshots() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seedBase();
  });

  it('head with more files/symbols → positive net deltas', () => {
    captureSnapshot(ctx.store, 'base');

    // Grow the graph for `head` snapshot.
    insertFileWithFn(ctx.store, 'src/b.ts', 'fnB');
    insertFileWithFn(ctx.store, 'src/c.ts', 'fnC');
    captureSnapshot(ctx.store, 'head');

    const diff = diffSnapshots(ctx.store, 'base', 'head');
    expect(diff).not.toBeNull();
    expect(diff!.files.net).toBe(2);
    expect(diff!.files.added).toBe(2);
    expect(diff!.files.removed).toBe(0);
    expect(diff!.symbols.net).toBe(2);
    expect(diff!.symbols.added).toBe(2);
  });

  it('diffing a snapshot against itself yields all-zero deltas', () => {
    captureSnapshot(ctx.store, 'self');
    const diff = diffSnapshots(ctx.store, 'self', 'self');
    expect(diff).not.toBeNull();
    expect(diff!.files.net).toBe(0);
    expect(diff!.symbols.net).toBe(0);
    expect(diff!.exported_symbols.delta).toBe(0);
    for (const v of Object.values(diff!.symbols_by_kind)) {
      expect(v.delta).toBe(0);
    }
    for (const v of Object.values(diff!.edges_by_type)) {
      expect(v.delta).toBe(0);
    }
    expect(diff!.communities.added).toEqual([]);
    expect(diff!.communities.removed).toEqual([]);
  });

  it('unknown snapshot name returns null (clear empty envelope)', () => {
    captureSnapshot(ctx.store, 'only');
    expect(diffSnapshots(ctx.store, 'only', 'missing')).toBeNull();
    expect(diffSnapshots(ctx.store, 'missing', 'only')).toBeNull();
    expect(diffSnapshots(ctx.store, 'no', 'such')).toBeNull();
  });

  it('output shape: base + head + files + symbols + by-kind + by-type + communities + top_files', () => {
    captureSnapshot(ctx.store, 'one');
    insertFileWithFn(ctx.store, 'src/b.ts', 'fnB');
    captureSnapshot(ctx.store, 'two');

    const diff = diffSnapshots(ctx.store, 'one', 'two');
    expect(diff).not.toBeNull();

    expect(diff!.base.name).toBe('one');
    expect(diff!.head.name).toBe('two');
    expect(typeof diff!.base.captured_at).toBe('string');
    expect(typeof diff!.head.captured_at).toBe('string');

    expect(typeof diff!.files.added).toBe('number');
    expect(typeof diff!.files.removed).toBe('number');
    expect(typeof diff!.files.net).toBe('number');
    expect(typeof diff!.symbols.added).toBe('number');
    expect(typeof diff!.symbols.removed).toBe('number');
    expect(typeof diff!.symbols.net).toBe('number');

    expect(typeof diff!.symbols_by_kind).toBe('object');
    expect(typeof diff!.edges_by_type).toBe('object');
    expect(Array.isArray(diff!.communities.added)).toBe(true);
    expect(Array.isArray(diff!.communities.removed)).toBe(true);
    expect(Array.isArray(diff!.top_files.rose)).toBe(true);
    expect(Array.isArray(diff!.top_files.fell)).toBe(true);

    expect(typeof diff!.exported_symbols.base).toBe('number');
    expect(typeof diff!.exported_symbols.head).toBe('number');
    expect(typeof diff!.exported_symbols.delta).toBe('number');
  });

  it('symbols_by_kind tracks per-kind base/head/delta correctly', () => {
    captureSnapshot(ctx.store, 'k1');
    // Add a class to head.
    const fid = ctx.store.insertFile('src/cls.ts', 'typescript', 'h-cls', 100);
    ctx.store.insertSymbol(fid, {
      symbolId: 'src/cls.ts::MyClass#class',
      name: 'MyClass',
      kind: 'class',
      fqn: 'MyClass',
      byteStart: 0,
      byteEnd: 30,
      lineStart: 1,
      lineEnd: 3,
    });
    captureSnapshot(ctx.store, 'k2');

    const diff = diffSnapshots(ctx.store, 'k1', 'k2');
    expect(diff).not.toBeNull();
    expect(diff!.symbols_by_kind.class).toEqual({ base: 0, head: 1, delta: 1 });
    // Function count unchanged.
    expect(diff!.symbols_by_kind.function.delta).toBe(0);
  });
});
