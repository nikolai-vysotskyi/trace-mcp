import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { searchFts } from '../../src/db/fts.js';
import type { RawSymbol } from '../../src/plugin-api/types.js';
import type { RawOrmModel, RawRnScreen } from '../../src/plugin-api/types.js';

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

  describe('ORM models', () => {
    it('inserts and retrieves an ORM model by name', () => {
      const fileId = store.insertFile('models/user.ts', 'typescript', 'h1', 100);
      const model: RawOrmModel = {
        name: 'User',
        orm: 'mongoose',
        collectionOrTable: 'users',
        fields: [{ name: 'email', type: 'String' }],
        metadata: { virtuals: ['fullName'] },
      };
      const modelId = store.insertOrmModel(model, fileId);
      expect(modelId).toBeGreaterThan(0);

      const found = store.getOrmModelByName('User');
      expect(found).toBeDefined();
      expect(found!.name).toBe('User');
      expect(found!.orm).toBe('mongoose');
      expect(found!.collection_or_table).toBe('users');
    });

    it('returns undefined for unknown model', () => {
      expect(store.getOrmModelByName('Nonexistent')).toBeUndefined();
    });

    it('retrieves models by ORM', () => {
      const fileId = store.insertFile('models/post.ts', 'typescript', 'h2', 100);
      store.insertOrmModel({ name: 'Post', orm: 'mongoose' }, fileId);
      store.insertOrmModel({ name: 'User', orm: 'mongoose' }, fileId);
      store.insertOrmModel({ name: 'Order', orm: 'sequelize' }, fileId);

      const mongooseModels = store.getOrmModelsByOrm('mongoose');
      expect(mongooseModels.length).toBe(2);
      expect(mongooseModels.map((m) => m.name)).toContain('Post');
      expect(mongooseModels.map((m) => m.name)).toContain('User');

      const seqModels = store.getOrmModelsByOrm('sequelize');
      expect(seqModels.length).toBe(1);
      expect(seqModels[0].name).toBe('Order');
    });

    it('retrieves all ORM models', () => {
      const fileId = store.insertFile('models/x.ts', 'typescript', 'h3', 100);
      store.insertOrmModel({ name: 'A', orm: 'mongoose' }, fileId);
      store.insertOrmModel({ name: 'B', orm: 'sequelize' }, fileId);

      const all = store.getAllOrmModels();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('stores and parses JSON fields', () => {
      const fileId = store.insertFile('models/cat.ts', 'typescript', 'h4', 50);
      store.insertOrmModel(
        {
          name: 'Cat',
          orm: 'mongoose',
          fields: [{ name: 'name', type: 'String', required: true }],
          metadata: { indexes: [{ field: 'name' }] },
        },
        fileId,
      );

      const found = store.getOrmModelByName('Cat');
      expect(found).toBeDefined();
      const fields = JSON.parse(found!.fields!);
      expect(fields[0].name).toBe('name');
      expect(fields[0].required).toBe(true);
      const meta = JSON.parse(found!.metadata!);
      expect(meta.indexes[0].field).toBe('name');
    });

    it('creates a node for each ORM model', () => {
      const fileId = store.insertFile('models/dog.ts', 'typescript', 'h5', 50);
      const modelId = store.insertOrmModel({ name: 'Dog', orm: 'mongoose' }, fileId);
      const nodeId = store.getNodeId('orm_model', modelId);
      expect(nodeId).toBeDefined();
    });
  });

  describe('ORM associations', () => {
    it('inserts and retrieves associations', () => {
      const fileId = store.insertFile('models/assoc.ts', 'typescript', 'hA', 50);
      const userModelId = store.insertOrmModel({ name: 'User', orm: 'mongoose' }, fileId);
      const postModelId = store.insertOrmModel({ name: 'Post', orm: 'mongoose' }, fileId);

      store.insertOrmAssociation(userModelId, postModelId, 'Post', 'hasMany', {}, fileId, 10);

      const assocs = store.getOrmAssociationsByModel(userModelId);
      expect(assocs.length).toBe(1);
      expect(assocs[0].kind).toBe('hasMany');
      expect(assocs[0].target_model_name).toBe('Post');
    });

    it('inserts association with null target (unresolved)', () => {
      const fileId = store.insertFile('models/u2.ts', 'typescript', 'hB', 50);
      const modelId = store.insertOrmModel({ name: 'Widget', orm: 'sequelize' }, fileId);

      store.insertOrmAssociation(modelId, null, 'Gadget', 'belongsTo');
      const assocs = store.getOrmAssociationsByModel(modelId);
      expect(assocs.length).toBe(1);
      expect(assocs[0].target_model_name).toBe('Gadget');
      expect(assocs[0].target_model_id).toBeNull();
    });
  });

  describe('React Native screens', () => {
    it('inserts and retrieves a screen by name', () => {
      const fileId = store.insertFile('screens/Profile.tsx', 'typescript', 'hS1', 100);
      const screen: RawRnScreen = {
        name: 'Profile',
        componentPath: 'ProfileScreen',
        navigatorType: 'stack',
        deepLink: 'user/:id',
        metadata: { nativeModules: ['CameraModule'] },
      };
      const screenId = store.insertRnScreen(screen, fileId);
      expect(screenId).toBeGreaterThan(0);

      const found = store.getRnScreenByName('Profile');
      expect(found).toBeDefined();
      expect(found!.name).toBe('Profile');
      expect(found!.navigator_type).toBe('stack');
      expect(found!.deep_link).toBe('user/:id');
      expect(found!.component_path).toBe('ProfileScreen');
    });

    it('returns undefined for unknown screen name', () => {
      expect(store.getRnScreenByName('NoSuchScreen')).toBeUndefined();
    });

    it('getAllRnScreens returns all inserted screens', () => {
      const fileId = store.insertFile('screens/multi.tsx', 'typescript', 'hS2', 100);
      store.insertRnScreen({ name: 'Home' }, fileId);
      store.insertRnScreen({ name: 'Settings' }, fileId);

      const all = store.getAllRnScreens();
      expect(all.length).toBeGreaterThanOrEqual(2);
      expect(all.map((s) => s.name)).toContain('Home');
      expect(all.map((s) => s.name)).toContain('Settings');
    });

    it('stores JSON metadata correctly', () => {
      const fileId = store.insertFile('screens/native.tsx', 'typescript', 'hS3', 100);
      store.insertRnScreen(
        {
          name: 'Camera',
          metadata: { nativeModules: ['CameraModule'], platformSpecific: { ios: 'Camera.ios.tsx' } },
        },
        fileId,
      );

      const found = store.getRnScreenByName('Camera');
      expect(found).toBeDefined();
      const meta = JSON.parse(found!.metadata!);
      expect(meta.nativeModules).toContain('CameraModule');
      expect(meta.platformSpecific.ios).toBe('Camera.ios.tsx');
    });

    it('creates a node for each screen', () => {
      const fileId = store.insertFile('screens/node-test.tsx', 'typescript', 'hS4', 50);
      const screenId = store.insertRnScreen({ name: 'NodeTest' }, fileId);
      const nodeId = store.getNodeId('rn_screen', screenId);
      expect(nodeId).toBeDefined();
    });
  });
});
