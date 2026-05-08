/**
 * Tests for the graph snapshot + diff machinery.
 *
 * Contracts the rest of the codebase relies on:
 *   - captureSnapshot stamps a row with a stable schema
 *   - listSnapshots returns most-recent first
 *   - diffSnapshots compares files/symbols/edges with consistent +/- math
 *   - missing snapshots return null instead of throwing
 *   - re-capturing the same name overwrites in place (idempotent)
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import {
  captureSnapshot,
  deleteSnapshot,
  diffSnapshots,
  listSnapshots,
} from '../../src/tools/analysis/graph-snapshot.js';

function fixture(): Store {
  const db = initializeDatabase(':memory:');
  return new Store(db);
}

describe('captureSnapshot', () => {
  it('returns the documented top-level fields on an empty repo', () => {
    const store = fixture();
    const r = captureSnapshot(store, 'empty');
    expect(r.name).toBe('empty');
    expect(r.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.summary.files).toBe(0);
    expect(r.summary.symbols).toBe(0);
    expect(r.summary.symbols_by_kind).toEqual({});
    expect(r.summary.edges_by_type).toEqual({});
    expect(r.summary.top_files).toEqual([]);
    expect(r.summary.communities).toEqual([]);
    expect(r.summary.exported_symbols).toBe(0);
  });

  it('counts symbols by kind', () => {
    const store = fixture();
    const fileId = store.insertFile('src/x.ts', 'typescript', 'h', 100);
    store.insertSymbol(fileId, {
      symbolId: 's1',
      name: 'A',
      kind: 'class',
      fqn: 'A',
      byteStart: 0,
      byteEnd: 1,
    });
    store.insertSymbol(fileId, {
      symbolId: 's2',
      name: 'b',
      kind: 'function',
      fqn: 'b',
      byteStart: 0,
      byteEnd: 1,
    });

    const r = captureSnapshot(store, 'snap1');
    expect(r.summary.symbols_by_kind.class).toBe(1);
    expect(r.summary.symbols_by_kind.function).toBe(1);
    expect(r.summary.files).toBe(1);
    expect(r.summary.symbols).toBe(2);
  });

  it('is idempotent — re-capturing the same name overwrites', () => {
    const store = fixture();
    captureSnapshot(store, 'point');
    const second = captureSnapshot(store, 'point');
    const all = listSnapshots(store);
    expect(all.filter((s) => s.name === 'point')).toHaveLength(1);
    expect(second.id).toBeDefined();
  });
});

describe('listSnapshots', () => {
  it('returns most-recent first', async () => {
    const store = fixture();
    captureSnapshot(store, 'old');
    await new Promise((r) => setTimeout(r, 10));
    captureSnapshot(store, 'new');
    const all = listSnapshots(store);
    expect(all[0].name).toBe('new');
    expect(all[1].name).toBe('old');
  });
});

describe('deleteSnapshot', () => {
  it('removes the named snapshot', () => {
    const store = fixture();
    captureSnapshot(store, 'temp');
    expect(deleteSnapshot(store, 'temp')).toBe(true);
    expect(listSnapshots(store)).toHaveLength(0);
  });

  it('returns false when the snapshot does not exist', () => {
    const store = fixture();
    expect(deleteSnapshot(store, 'never-existed')).toBe(false);
  });
});

describe('diffSnapshots', () => {
  it('returns null when either snapshot is missing', () => {
    const store = fixture();
    captureSnapshot(store, 'only');
    expect(diffSnapshots(store, 'only', 'missing')).toBeNull();
    expect(diffSnapshots(store, 'missing', 'only')).toBeNull();
  });

  it('reports positive net for additions', () => {
    const store = fixture();
    captureSnapshot(store, 'before');
    const fileId = store.insertFile('src/new.ts', 'typescript', 'h', 100);
    store.insertSymbol(fileId, {
      symbolId: 's',
      name: 'NewClass',
      kind: 'class',
      fqn: 'NewClass',
      byteStart: 0,
      byteEnd: 1,
    });
    captureSnapshot(store, 'after');

    const d = diffSnapshots(store, 'before', 'after')!;
    expect(d.files.net).toBe(1);
    expect(d.files.added).toBe(1);
    expect(d.files.removed).toBe(0);
    expect(d.symbols.net).toBe(1);
    expect(d.symbols_by_kind.class.delta).toBe(1);
  });

  it('reports community add/remove deltas', () => {
    const store = fixture();
    // Manually create the communities table with a row so the first
    // snapshot has it. The schema is whatever the production code
    // expects — three columns: id, label, file_count.
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS communities (id INTEGER PRIMARY KEY, label TEXT, file_count INTEGER, cohesion REAL, internal_edges INTEGER, external_edges INTEGER)',
    );
    store.db
      .prepare(
        'INSERT INTO communities (id, label, file_count, cohesion, internal_edges, external_edges) VALUES (1, ?, 5, 0.8, 10, 2)',
      )
      .run('auth');
    captureSnapshot(store, 'snap1');

    store.db.prepare("DELETE FROM communities WHERE label = 'auth'").run();
    store.db
      .prepare(
        'INSERT INTO communities (id, label, file_count, cohesion, internal_edges, external_edges) VALUES (2, ?, 3, 0.9, 7, 1)',
      )
      .run('payments');
    captureSnapshot(store, 'snap2');

    const d = diffSnapshots(store, 'snap1', 'snap2')!;
    expect(d.communities.added).toContain('payments');
    expect(d.communities.removed).toContain('auth');
  });
});
