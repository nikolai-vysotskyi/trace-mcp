import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { searchFts } from '../../src/db/fts.js';
import type { RawSymbol } from '../../src/plugin-api/types.js';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    const db = initializeDatabase(':memory:');
    store = new Store(db);
  });

  describe('files', () => {
    it('inserts and retrieves a file', () => {
      const id = store.insertFile('app/Models/User.php', 'php', 'abc123', 500);
      expect(id).toBeGreaterThan(0);

      const file = store.getFile('app/Models/User.php');
      expect(file).toBeDefined();
      expect(file!.language).toBe('php');
      expect(file!.content_hash).toBe('abc123');
    });

    it('returns undefined for non-existent file', () => {
      expect(store.getFile('nope.php')).toBeUndefined();
    });

    it('getAllFiles returns all inserted files', () => {
      store.insertFile('a.php', 'php', 'h1', 100);
      store.insertFile('b.ts', 'typescript', 'h2', 200);
      expect(store.getAllFiles()).toHaveLength(2);
    });
  });

  describe('symbols', () => {
    it('inserts and retrieves symbols', () => {
      const fileId = store.insertFile('test.php', 'php', 'hash', 100);
      const sym: RawSymbol = {
        symbolId: 'test.php::Foo#class',
        name: 'Foo',
        kind: 'class',
        fqn: 'App\\Foo',
        byteStart: 0,
        byteEnd: 50,
        lineStart: 1,
        lineEnd: 10,
        signature: 'class Foo',
      };

      const symId = store.insertSymbol(fileId, sym);
      expect(symId).toBeGreaterThan(0);

      const symbols = store.getSymbolsByFile(fileId);
      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe('Foo');
      expect(symbols[0].fqn).toBe('App\\Foo');
    });

    it('finds symbol by symbol_id', () => {
      const fileId = store.insertFile('test.php', 'php', 'hash', 100);
      store.insertSymbol(fileId, {
        symbolId: 'test.php::Bar#class',
        name: 'Bar',
        kind: 'class',
        byteStart: 0,
        byteEnd: 30,
      });

      const found = store.getSymbolBySymbolId('test.php::Bar#class');
      expect(found).toBeDefined();
      expect(found!.name).toBe('Bar');
    });

    it('finds symbol by FQN', () => {
      const fileId = store.insertFile('test.php', 'php', 'hash', 100);
      store.insertSymbol(fileId, {
        symbolId: 'test.php::Baz#class',
        name: 'Baz',
        kind: 'class',
        fqn: 'App\\Baz',
        byteStart: 0,
        byteEnd: 30,
      });

      const found = store.getSymbolByFqn('App\\Baz');
      expect(found).toBeDefined();
      expect(found!.name).toBe('Baz');
    });
  });

  describe('FTS5 search', () => {
    beforeEach(() => {
      const fileId = store.insertFile('test.php', 'php', 'hash', 100);
      store.insertSymbol(fileId, {
        symbolId: 'test.php::UserController#class',
        name: 'UserController',
        kind: 'class',
        fqn: 'App\\Http\\Controllers\\UserController',
        signature: 'class UserController extends Controller',
        byteStart: 0,
        byteEnd: 100,
      });
      store.insertSymbol(fileId, {
        symbolId: 'test.php::index#method',
        name: 'index',
        kind: 'method',
        signature: 'public function index(): Response',
        byteStart: 50,
        byteEnd: 90,
      });
    });

    it('finds by name', () => {
      const results = searchFts(store.db, 'UserController');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('UserController');
    });

    it('finds by FQN', () => {
      const results = searchFts(store.db, 'Controllers');
      expect(results.length).toBeGreaterThan(0);
    });

    it('finds by signature keyword', () => {
      const results = searchFts(store.db, 'extends Controller');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('nodes and edges', () => {
    it('creates nodes for files and symbols', () => {
      const fileId = store.insertFile('a.php', 'php', 'h', 10);
      const nodeId = store.getNodeId('file', fileId);
      expect(nodeId).toBeDefined();
    });

    it('creates and retrieves edges', () => {
      const f1 = store.insertFile('a.php', 'php', 'h1', 10);
      const f2 = store.insertFile('b.php', 'php', 'h2', 10);

      const sym1Id = store.insertSymbol(f1, {
        symbolId: 'a.php::A#class',
        name: 'A',
        kind: 'class',
        byteStart: 0,
        byteEnd: 10,
      });
      const sym2Id = store.insertSymbol(f2, {
        symbolId: 'b.php::B#class',
        name: 'B',
        kind: 'class',
        byteStart: 0,
        byteEnd: 10,
      });

      const n1 = store.getNodeId('symbol', sym1Id)!;
      const n2 = store.getNodeId('symbol', sym2Id)!;

      const result = store.insertEdge(n1, n2, 'imports');
      expect(result.isOk()).toBe(true);
    });
  });
});
