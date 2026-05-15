/**
 * Behavioural coverage for `captureSnapshot()`. Seeds a small file/symbol/edge
 * fixture and verifies snapshot capture shape, idempotency on name reuse,
 * empty-graph zero-counts envelope, and multi-snapshot coexistence.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { captureSnapshot, listSnapshots } from '../../../src/tools/analysis/graph-snapshot.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

function seed(): Fixture {
  const store = createTestStore();
  const aId = store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
  const bId = store.insertFile('src/b.ts', 'typescript', 'h-b', 100);

  store.insertSymbol(aId, {
    symbolId: 'src/a.ts::funcA#function',
    name: 'funcA',
    kind: 'function',
    fqn: 'funcA',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 3,
  });
  store.insertSymbol(bId, {
    symbolId: 'src/b.ts::ClassB#class',
    name: 'ClassB',
    kind: 'class',
    fqn: 'ClassB',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
  });

  const aNode = store.getNodeId('file', aId)!;
  const bNode = store.getNodeId('file', bId)!;
  store.insertEdge(aNode, bNode, 'esm_imports', true, undefined, false, 'ast_resolved');

  return { store };
}

describe('captureSnapshot() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('returns { id, name, captured_at, summary } for a seeded graph', () => {
    const snap = captureSnapshot(ctx.store, 'baseline');
    expect(typeof snap.id).toBe('number');
    expect(snap.id).toBeGreaterThan(0);
    expect(snap.name).toBe('baseline');
    expect(typeof snap.captured_at).toBe('string');
    // ISO 8601-ish
    expect(snap.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snap.summary).toBeDefined();
    expect(snap.summary.files).toBe(2);
    expect(snap.summary.symbols).toBe(2);
  });

  it('same name re-stamps the snapshot (idempotent — single row, not duplicates)', () => {
    const first = captureSnapshot(ctx.store, 'reuse');
    const second = captureSnapshot(ctx.store, 'reuse');

    // INSERT OR REPLACE — id may or may not be reused, but the row count must stay 1.
    const all = listSnapshots(ctx.store);
    const matching = all.filter((s) => s.name === 'reuse');
    expect(matching).toHaveLength(1);

    // captured_at should be the latest call's timestamp.
    expect(matching[0].captured_at).toBe(second.captured_at);
    // first/second describe the same name slot.
    expect(first.name).toBe(second.name);
  });

  it('empty graph returns a snapshot with zero counts', () => {
    const empty = createTestStore();
    const snap = captureSnapshot(empty, 'empty');
    expect(snap.summary.files).toBe(0);
    expect(snap.summary.symbols).toBe(0);
    expect(snap.summary.exported_symbols).toBe(0);
    expect(snap.summary.symbols_by_kind).toEqual({});
    expect(snap.summary.edges_by_type).toEqual({});
    expect(snap.summary.top_files).toEqual([]);
    expect(snap.summary.communities).toEqual([]);
  });

  it('summary has stable shape: files + symbols + symbols_by_kind + top_files', () => {
    const snap = captureSnapshot(ctx.store, 'shape');
    expect(typeof snap.summary.files).toBe('number');
    expect(typeof snap.summary.symbols).toBe('number');
    expect(typeof snap.summary.symbols_by_kind).toBe('object');
    expect(typeof snap.summary.edges_by_type).toBe('object');
    expect(Array.isArray(snap.summary.top_files)).toBe(true);
    expect(Array.isArray(snap.summary.communities)).toBe(true);

    // Symbols-by-kind reflects seeded mix: 1 function + 1 class.
    expect(snap.summary.symbols_by_kind.function).toBe(1);
    expect(snap.summary.symbols_by_kind.class).toBe(1);

    // Edges-by-type reflects seeded esm_imports edge.
    expect(snap.summary.edges_by_type.esm_imports).toBe(1);

    // top_files entries have { file, in_degree }.
    for (const t of snap.summary.top_files) {
      expect(typeof t.file).toBe('string');
      expect(typeof t.in_degree).toBe('number');
    }
  });

  it('multiple distinct names coexist as separate rows', () => {
    captureSnapshot(ctx.store, 'before');
    captureSnapshot(ctx.store, 'after');
    captureSnapshot(ctx.store, 'release-v1');

    const all = listSnapshots(ctx.store);
    const names = new Set(all.map((s) => s.name));
    expect(names.has('before')).toBe(true);
    expect(names.has('after')).toBe(true);
    expect(names.has('release-v1')).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(3);
  });
});
