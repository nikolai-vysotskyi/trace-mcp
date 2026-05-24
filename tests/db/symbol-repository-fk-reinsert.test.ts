import { describe, expect, it } from 'vitest';
import { createTestStore } from '../test-utils.js';

// Regression: hermes-agent project hit
// "Force-reindex after FK recovery still failed: FOREIGN KEY constraint failed"
// because INSERT OR REPLACE on a symbol that has children does DELETE+INSERT
// under the hood, and SQLite's NO ACTION default refuses to orphan the
// children's `parent_id` FK during the DELETE step. The fix switches
// insertSymbol to `INSERT ... ON CONFLICT(symbol_id) DO UPDATE SET ...
// RETURNING id`, which preserves the row id so child FKs stay valid.

describe('SymbolRepository.insertSymbol — re-insert preserves id, no FK violation', () => {
  it('re-inserting a parent symbol that has children does not violate parent_id FK', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/foo.ts', 'typescript', 'hash1', 100, undefined, 0);

    // Parent + child in one batch.
    const ids = store.insertSymbols(fileId, [
      {
        symbolId: 'src/foo.ts::Parent#class',
        name: 'Parent',
        kind: 'class',
        byteStart: 0,
        byteEnd: 100,
        signature: 'class Parent',
      },
      {
        symbolId: 'src/foo.ts::Parent::child#method',
        name: 'child',
        kind: 'method',
        byteStart: 10,
        byteEnd: 90,
        signature: 'child(): void',
        parentSymbolId: 'src/foo.ts::Parent#class',
      },
    ]);
    expect(ids).toHaveLength(2);
    const parentIdV1 = ids[0];
    const childId = ids[1];

    // Sanity: child's parent_id points at the parent.
    const childRow = store.getSymbolById(childId);
    expect(childRow?.parent_id).toBe(parentIdV1);

    // Re-insert the parent — pre-fix this used to fire INSERT OR REPLACE,
    // which DELETE+INSERTs the row. The DELETE step would fail with
    // "FOREIGN KEY constraint failed" because the child's parent_id still
    // pointed at the original row.
    expect(() => {
      store.insertSymbols(fileId, [
        {
          symbolId: 'src/foo.ts::Parent#class',
          name: 'Parent',
          kind: 'class',
          byteStart: 0,
          byteEnd: 120, // changed
          signature: 'class Parent extends Base', // changed
        },
      ]);
    }).not.toThrow();

    // Post-fix invariant: the parent's id MUST be preserved so the child's
    // parent_id continues to be valid. INSERT OR REPLACE would have
    // re-issued the auto-increment id.
    const parentRow = store.getSymbolBySymbolId('src/foo.ts::Parent#class');
    expect(parentRow?.id).toBe(parentIdV1);
    expect(parentRow?.signature).toBe('class Parent extends Base');
    expect(parentRow?.byte_end).toBe(120);

    // Child must still link to the same parent_id.
    const childRowAfter = store.getSymbolById(childId);
    expect(childRowAfter?.parent_id).toBe(parentIdV1);
  });

  it('re-insert that changes file_id and metadata still preserves the row id', () => {
    const store = createTestStore();
    const fileA = store.insertFile('src/a.ts', 'typescript', 'h_a', 50, undefined, 0);
    const fileB = store.insertFile('src/b.ts', 'typescript', 'h_b', 50, undefined, 0);

    const [id1] = store.insertSymbols(fileA, [
      {
        symbolId: 'shared::Foo#class',
        name: 'Foo',
        kind: 'class',
        byteStart: 0,
        byteEnd: 10,
      },
    ]);

    // Same symbol_id in a different file (e.g. file was moved). Pre-fix the
    // REPLACE branch would re-assign the id; post-fix the UPDATE branch
    // keeps it stable.
    const [id2] = store.insertSymbols(fileB, [
      {
        symbolId: 'shared::Foo#class',
        name: 'Foo',
        kind: 'class',
        byteStart: 0,
        byteEnd: 20,
      },
    ]);
    expect(id2).toBe(id1);

    const row = store.getSymbolBySymbolId('shared::Foo#class');
    expect(row?.file_id).toBe(fileB);
    expect(row?.byte_end).toBe(20);
  });

  it('node row for the symbol is not duplicated after a re-insert (UNIQUE(node_type, ref_id))', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/n.ts', 'typescript', 'h', 50, undefined, 0);

    const [symbolId] = store.insertSymbols(fileId, [
      {
        symbolId: 'src/n.ts::N#class',
        name: 'N',
        kind: 'class',
        byteStart: 0,
        byteEnd: 10,
      },
    ]);

    store.insertSymbols(fileId, [
      {
        symbolId: 'src/n.ts::N#class',
        name: 'N',
        kind: 'class',
        byteStart: 0,
        byteEnd: 15,
      },
    ]);

    const nodeCount = store.db
      .prepare("SELECT COUNT(*) AS c FROM nodes WHERE node_type='symbol' AND ref_id = ?")
      .get(symbolId) as { c: number };
    expect(nodeCount.c).toBe(1);
  });
});
