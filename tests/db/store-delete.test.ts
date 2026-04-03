/**
 * Tests for store deletion operations, particularly that deleteSymbolsByFile
 * correctly removes all symbol nodes (not leaving orphaned entries in `nodes`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import type { RawSymbol } from '../../src/plugin-api/types.js';

function makeSymbol(id: string, name: string): RawSymbol {
  return {
    symbolId: id,
    name,
    kind: 'function',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 5,
  };
}

describe('Store.deleteSymbolsByFile', () => {
  let store: Store;

  beforeEach(() => {
    const db = initializeDatabase(':memory:');
    store = new Store(db);
  });

  it('removes all symbols and their nodes in one operation', () => {
    const fileId = store.insertFile('src/foo.ts', 'typescript', 'abc', 100);
    store.insertSymbols(fileId, [
      makeSymbol('foo::a', 'a'),
      makeSymbol('foo::b', 'b'),
      makeSymbol('foo::c', 'c'),
    ]);

    // Verify symbols and nodes are present
    expect(store.getSymbolsByFile(fileId)).toHaveLength(3);
    const nodesBefore = store.db
      .prepare("SELECT COUNT(*) as n FROM nodes WHERE node_type = 'symbol'")
      .get() as { n: number };
    expect(nodesBefore.n).toBe(3);

    store.deleteSymbolsByFile(fileId);

    // Symbols gone
    expect(store.getSymbolsByFile(fileId)).toHaveLength(0);

    // Nodes also gone — no orphaned entries
    const nodesAfter = store.db
      .prepare("SELECT COUNT(*) as n FROM nodes WHERE node_type = 'symbol'")
      .get() as { n: number };
    expect(nodesAfter.n).toBe(0);
  });

  it('leaves symbols of other files intact', () => {
    const file1 = store.insertFile('src/a.ts', 'typescript', 'h1', 100);
    const file2 = store.insertFile('src/b.ts', 'typescript', 'h2', 100);

    store.insertSymbols(file1, [makeSymbol('a::x', 'x'), makeSymbol('a::y', 'y')]);
    store.insertSymbols(file2, [makeSymbol('b::z', 'z')]);

    store.deleteSymbolsByFile(file1);

    // file1 symbols gone, file2 intact
    expect(store.getSymbolsByFile(file1)).toHaveLength(0);
    expect(store.getSymbolsByFile(file2)).toHaveLength(1);

    // Only file2's node remains
    const nodesAfter = store.db
      .prepare("SELECT COUNT(*) as n FROM nodes WHERE node_type = 'symbol'")
      .get() as { n: number };
    expect(nodesAfter.n).toBe(1);
  });

  it('is a no-op for a file with no symbols', () => {
    const fileId = store.insertFile('src/empty.ts', 'typescript', 'h3', 0);
    // Should not throw
    expect(() => store.deleteSymbolsByFile(fileId)).not.toThrow();
    expect(store.getSymbolsByFile(fileId)).toHaveLength(0);
  });

  it('cleans up correctly so re-indexing inserts fresh symbols', () => {
    const fileId = store.insertFile('src/foo.ts', 'typescript', 'h4', 100);
    store.insertSymbols(fileId, [makeSymbol('foo::old', 'old')]);

    // Re-index: delete then insert new symbols
    store.deleteSymbolsByFile(fileId);
    store.insertSymbols(fileId, [
      makeSymbol('foo::new1', 'new1'),
      makeSymbol('foo::new2', 'new2'),
    ]);

    const symbols = store.getSymbolsByFile(fileId);
    expect(symbols).toHaveLength(2);
    expect(symbols.map((s) => s.name)).toContain('new1');
    expect(symbols.map((s) => s.name)).toContain('new2');
    expect(symbols.map((s) => s.name)).not.toContain('old');

    // Nodes: 2 symbol nodes + 1 file node
    const nodeCount = store.db
      .prepare("SELECT COUNT(*) as n FROM nodes WHERE node_type = 'symbol'")
      .get() as { n: number };
    expect(nodeCount.n).toBe(2);
  });
});
