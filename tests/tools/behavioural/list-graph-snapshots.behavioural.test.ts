/**
 * Behavioural coverage for `listSnapshots()`. Verifies empty-store contract,
 * captured-at-desc ordering, entry shape, and equivalence with `captureSnapshot()`
 * return values.
 */

import { describe, expect, it } from 'vitest';
import { captureSnapshot, listSnapshots } from '../../../src/tools/analysis/graph-snapshot.js';
import { createTestStore } from '../../test-utils.js';

describe('listSnapshots() — behavioural contract', () => {
  it('returns empty array when no snapshots have been captured', () => {
    const store = createTestStore();
    const all = listSnapshots(store);
    expect(all).toEqual([]);
  });

  it('returns all captured snapshots, sorted by captured_at desc', async () => {
    const store = createTestStore();
    captureSnapshot(store, 'first');
    // Sleep a few ms so captured_at differs reliably (ISO string compare).
    await new Promise((r) => setTimeout(r, 10));
    captureSnapshot(store, 'second');
    await new Promise((r) => setTimeout(r, 10));
    captureSnapshot(store, 'third');

    const all = listSnapshots(store);
    expect(all).toHaveLength(3);
    // Most recent first.
    expect(all[0].name).toBe('third');
    expect(all[2].name).toBe('first');
    // Strictly non-increasing captured_at (ISO strings compare lexicographically).
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].captured_at >= all[i].captured_at).toBe(true);
    }
  });

  it('each entry has { id, name, captured_at, summary }', () => {
    const store = createTestStore();
    captureSnapshot(store, 'shape');

    const all = listSnapshots(store);
    expect(all).toHaveLength(1);
    const entry = all[0];
    expect(typeof entry.id).toBe('number');
    expect(typeof entry.name).toBe('string');
    expect(typeof entry.captured_at).toBe('string');
    expect(entry.summary).toBeDefined();
    expect(typeof entry.summary.files).toBe('number');
    expect(typeof entry.summary.symbols).toBe('number');
    expect(typeof entry.summary.symbols_by_kind).toBe('object');
    expect(typeof entry.summary.edges_by_type).toBe('object');
    expect(Array.isArray(entry.summary.top_files)).toBe(true);
    expect(Array.isArray(entry.summary.communities)).toBe(true);
    expect(typeof entry.summary.exported_symbols).toBe('number');
  });

  it('summary matches what captureSnapshot returned', () => {
    const store = createTestStore();
    const fid = store.insertFile('src/x.ts', 'typescript', 'h-x', 100);
    store.insertSymbol(fid, {
      symbolId: 'src/x.ts::fnX#function',
      name: 'fnX',
      kind: 'function',
      fqn: 'fnX',
      byteStart: 0,
      byteEnd: 30,
      lineStart: 1,
      lineEnd: 3,
    });

    const captured = captureSnapshot(store, 'eq');
    const listed = listSnapshots(store);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe(captured.name);
    expect(listed[0].captured_at).toBe(captured.captured_at);
    expect(listed[0].summary.files).toBe(captured.summary.files);
    expect(listed[0].summary.symbols).toBe(captured.summary.symbols);
    expect(listed[0].summary.symbols_by_kind).toEqual(captured.summary.symbols_by_kind);
  });

  it('re-stamping under the same name keeps the list at one entry per name', () => {
    const store = createTestStore();
    captureSnapshot(store, 'reused');
    captureSnapshot(store, 'reused');
    captureSnapshot(store, 'reused');

    const all = listSnapshots(store);
    const reusedEntries = all.filter((s) => s.name === 'reused');
    expect(reusedEntries).toHaveLength(1);
  });
});
