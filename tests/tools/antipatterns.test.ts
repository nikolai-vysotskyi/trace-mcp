import { describe, test, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';
import { detectAntipatterns } from '../../src/tools/quality/antipatterns.js';

const TEST_DIR = path.join(tmpdir(), `trace-mcp-antipatterns-test-${process.pid}`);

function insertFile(store: Store, relPath: string, language = 'typescript'): number {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, '// placeholder');
  return store.insertFile(relPath, language, `hash-${relPath}`, 100);
}

function insertModel(
  store: Store,
  fileId: number,
  name: string,
  orm: string = 'sequelize',
  opts?: { table?: string; options?: Record<string, unknown>; metadata?: Record<string, unknown> },
): number {
  return store.insertOrmModel(
    {
      name,
      orm: orm as any,
      collectionOrTable: opts?.table,
      options: opts?.options,
      metadata: opts?.metadata,
    },
    fileId,
  );
}

function insertAssoc(
  store: Store,
  sourceModelId: number,
  targetModelId: number | null,
  targetModelName: string,
  kind: string,
  options?: Record<string, unknown>,
  fileId?: number,
  line?: number,
): number {
  return store.insertOrmAssociation(
    sourceModelId,
    targetModelId,
    targetModelName,
    kind,
    options,
    fileId,
    line,
  );
}

describe('Antipattern Detection', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  // -------------------------------------------------------------------
  // N+1 Query Risk
  // -------------------------------------------------------------------

  describe('n_plus_one_risk', () => {
    test('detects hasMany without eager loading (low severity without handler evidence)', () => {
      const fId = insertFile(store, 'src/models/User.ts');
      const userId = insertModel(store, fId, 'User');
      const postId = insertModel(store, fId, 'Post');
      insertAssoc(store, userId, postId, 'Post', 'hasMany');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['n_plus_one_risk'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.length).toBeGreaterThanOrEqual(1);
      expect(data.findings[0].category).toBe('n_plus_one_risk');
      // Without a handler accessor, severity is 'low' (weak evidence that
      // the model is ever loaded in bulk). See "confidence increases when
      // model accessed from handler" for the high-severity path.
      expect(data.findings[0].severity).toBe('low');
      expect(data.findings[0].title).toContain('User');
      expect(data.findings[0].title).toContain('Post');
      expect(data.findings[0].fix).toBeTruthy();
    });

    test('does not flag belongsTo (to-one relationship)', () => {
      const fId = insertFile(store, 'src/models/Post.ts');
      const postId = insertModel(store, fId, 'Post');
      const userId = insertModel(store, fId, 'User');
      insertAssoc(store, postId, userId, 'User', 'belongsTo');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['n_plus_one_risk'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('does not flag hasMany with eager loading option', () => {
      const fId = insertFile(store, 'src/models/User.ts');
      const userId = insertModel(store, fId, 'User');
      const postId = insertModel(store, fId, 'Post');
      insertAssoc(store, userId, postId, 'Post', 'hasMany', { eager: true });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['n_plus_one_risk'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('does not flag model with $with metadata (Laravel eager)', () => {
      const fId = insertFile(store, 'src/models/User.ts');
      const userId = insertModel(store, fId, 'User', 'sequelize', {
        metadata: { with: ['posts'] },
      });
      const postId = insertModel(store, fId, 'Post');
      insertAssoc(store, userId, postId, 'Post', 'hasMany');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['n_plus_one_risk'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('detects multiple to-many relationships', () => {
      const fId = insertFile(store, 'src/models/User.ts');
      const userId = insertModel(store, fId, 'User');
      const postId = insertModel(store, fId, 'Post');
      const commentId = insertModel(store, fId, 'Comment');
      insertAssoc(store, userId, postId, 'Post', 'hasMany');
      insertAssoc(store, userId, commentId, 'Comment', 'hasMany');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['n_plus_one_risk'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings.length).toBe(2);
    });

    test('detects belongsToMany (many-to-many)', () => {
      const fId = insertFile(store, 'src/models/User.ts');
      const userId = insertModel(store, fId, 'User');
      const roleId = insertModel(store, fId, 'Role');
      insertAssoc(store, userId, roleId, 'Role', 'belongsToMany');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['n_plus_one_risk'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
    });

    test('confidence increases when model accessed from handler', () => {
      const fModel = insertFile(store, 'src/models/User.ts');
      const fCtrl = insertFile(store, 'src/controllers/UserController.ts');
      const userId = insertModel(store, fModel, 'User');
      const postId = insertModel(store, fModel, 'Post');
      insertAssoc(store, userId, postId, 'Post', 'hasMany');

      // Create a controller symbol that calls the model
      const ctrlSymId = store.insertSymbol(fCtrl, {
        symbolId: 'ctrl::index#method',
        name: 'index',
        kind: 'method',
        byteStart: 0,
        byteEnd: 100,
        metadata: { frameworkRole: 'controller' },
      });

      // Link controller to model via graph edge
      const modelNodeId = store.getNodeId('orm_model', userId)!;
      const ctrlNodeId = store.getNodeId('symbol', ctrlSymId)!;
      store.insertEdge(ctrlNodeId, modelNodeId, 'calls', true);

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['n_plus_one_risk'],
      });
      expect(result.isOk()).toBe(true);
      const findings = result._unsafeUnwrap().findings;
      expect(findings.length).toBe(1);
      // Higher confidence when accessed from handler
      expect(findings[0].confidence).toBeGreaterThan(0.8);
      expect(findings[0].related_symbols).toBeDefined();
    });
  });

  // -------------------------------------------------------------------
  // Missing Eager Load
  // -------------------------------------------------------------------

  describe('missing_eager_load', () => {
    test('detects model with multiple uneager relationships', () => {
      const fId = insertFile(store, 'src/models/Order.ts');
      const orderId = insertModel(store, fId, 'Order');
      const custId = insertModel(store, fId, 'Customer');
      const itemId = insertModel(store, fId, 'Item');
      insertAssoc(store, orderId, custId, 'Customer', 'belongsTo');
      insertAssoc(store, orderId, itemId, 'Item', 'hasMany');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['missing_eager_load'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.length).toBeGreaterThanOrEqual(1);
      expect(data.findings[0].category).toBe('missing_eager_load');
      expect(data.findings[0].title).toContain('Order');
    });

    test('does not flag model with only one relationship', () => {
      const fId = insertFile(store, 'src/models/Post.ts');
      const postId = insertModel(store, fId, 'Post');
      const userId = insertModel(store, fId, 'User');
      insertAssoc(store, postId, userId, 'User', 'belongsTo');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['missing_eager_load'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('does not flag when all relationships have eager loading', () => {
      const fId = insertFile(store, 'src/models/Order.ts');
      const orderId = insertModel(store, fId, 'Order');
      const custId = insertModel(store, fId, 'Customer');
      const itemId = insertModel(store, fId, 'Item');
      insertAssoc(store, orderId, custId, 'Customer', 'belongsTo', { eager: true });
      insertAssoc(store, orderId, itemId, 'Item', 'hasMany', { eager: true });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['missing_eager_load'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Unbounded Query
  // -------------------------------------------------------------------

  describe('unbounded_query', () => {
    test('detects model with high-cardinality table and no pagination', () => {
      const fId = insertFile(store, 'src/models/Event.ts');
      insertModel(store, fId, 'Event', 'sequelize', { table: 'events' });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['unbounded_query'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.length).toBeGreaterThanOrEqual(1);
      expect(data.findings[0].category).toBe('unbounded_query');
      expect(data.findings[0].title).toContain('Event');
    });

    test('detects model named "logs" (high cardinality)', () => {
      const fId = insertFile(store, 'src/models/Log.ts');
      insertModel(store, fId, 'Log', 'sequelize', { table: 'logs' });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['unbounded_query'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
    });

    test('does not flag model with perPage configured', () => {
      const fId = insertFile(store, 'src/models/Event.ts');
      insertModel(store, fId, 'Event', 'sequelize', {
        table: 'events',
        options: { perPage: 20 },
      });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['unbounded_query'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('does not flag model with defaultScope limit', () => {
      const fId = insertFile(store, 'src/models/Message.ts');
      insertModel(store, fId, 'Message', 'sequelize', {
        table: 'messages',
        options: { defaultScope: { limit: 100 } },
      });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['unbounded_query'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('does not flag low-cardinality table name', () => {
      const fId = insertFile(store, 'src/models/Category.ts');
      insertModel(store, fId, 'Category', 'sequelize', { table: 'categories' });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['unbounded_query'],
      });
      expect(result.isOk()).toBe(true);
      // Low-cardinality + no route access → no findings
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Event Listener Leak
  // -------------------------------------------------------------------

  describe('event_listener_leak', () => {
    test('detects addEventListener without removeEventListener', () => {
      const fId = insertFile(store, 'src/components/Widget.ts');
      store.insertSymbol(fId, {
        symbolId: 'widget::setup#function',
        name: 'setupListeners',
        kind: 'function',
        byteStart: 0,
        byteEnd: 100,
        signature: 'function setupListeners()',
        metadata: { callSites: [{ calleeName: 'addEventListener', line: 2, receiver: 'window' }] },
      });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['event_listener_leak'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.length).toBeGreaterThanOrEqual(1);
      expect(data.findings[0].category).toBe('event_listener_leak');
    });

    test('does not flag when cleanup exists in same file', () => {
      const fId = insertFile(store, 'src/components/Widget.ts');
      store.insertSymbol(fId, {
        symbolId: 'widget::setup#function',
        name: 'setup',
        kind: 'function',
        byteStart: 0,
        byteEnd: 100,
        signature: 'function setup()',
        metadata: { callSites: [{ calleeName: 'addEventListener', line: 2, receiver: 'el' }] },
      });
      store.insertSymbol(fId, {
        symbolId: 'widget::teardown#function',
        name: 'teardown',
        kind: 'function',
        byteStart: 100,
        byteEnd: 200,
        signature: 'function teardown()',
        metadata: { callSites: [{ calleeName: 'removeEventListener', line: 5, receiver: 'el' }] },
      });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['event_listener_leak'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('detects setInterval without clearInterval', () => {
      const fId = insertFile(store, 'src/services/Poller.ts');
      store.insertSymbol(fId, {
        symbolId: 'poller::start#function',
        name: 'startPolling',
        kind: 'function',
        byteStart: 0,
        byteEnd: 100,
        signature: 'function startPolling()',
        metadata: { callSites: [{ calleeName: 'setInterval', line: 2 }] },
      });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['event_listener_leak'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.length).toBeGreaterThanOrEqual(1);
      expect(data.findings.some((f) => f.title.includes('setInterval'))).toBe(true);
    });

    test('detects subscribe without unsubscribe', () => {
      const fId = insertFile(store, 'src/services/EventBus.ts');
      store.insertSymbol(fId, {
        symbolId: 'bus::listen#function',
        name: 'listen',
        kind: 'function',
        byteStart: 0,
        byteEnd: 100,
        signature: 'function listen()',
        metadata: { callSites: [{ calleeName: 'subscribe', line: 2, receiver: 'observable' }] },
      });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['event_listener_leak'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.length).toBeGreaterThanOrEqual(1);
    });

    test('detects graph-based listener edges (listens_to)', () => {
      const fId = insertFile(store, 'src/listeners/Listener.ts');
      const symId = store.insertSymbol(fId, {
        symbolId: 'listener::handler#function',
        name: 'handleEvent',
        kind: 'function',
        byteStart: 0,
        byteEnd: 100,
      });

      // Create a target node for the event
      const fEvent = insertFile(store, 'src/events/UserCreated.ts');
      const evtSymId = store.insertSymbol(fEvent, {
        symbolId: 'event::UserCreated#class',
        name: 'UserCreated',
        kind: 'class',
        byteStart: 0,
        byteEnd: 100,
      });

      const srcNode = store.getNodeId('symbol', symId)!;
      const tgtNode = store.getNodeId('symbol', evtSymId)!;
      store.insertEdge(srcNode, tgtNode, 'listens_to', true);

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['event_listener_leak'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
    });

    test('no false positive when cleanup in importing file (cross-file)', () => {
      // File A: registers listener
      const fA = insertFile(store, 'src/components/Setup.ts');
      store.insertSymbol(fA, {
        symbolId: 'setup::init#function',
        name: 'init',
        kind: 'function',
        byteStart: 0,
        byteEnd: 100,
        signature: 'function init()',
        metadata: { callSites: [{ calleeName: 'addEventListener', line: 2, receiver: 'window' }] },
      });

      // File B: imports A and has cleanup
      const fB = insertFile(store, 'src/components/Teardown.ts');
      store.insertSymbol(fB, {
        symbolId: 'teardown::cleanup#function',
        name: 'cleanup',
        kind: 'function',
        byteStart: 0,
        byteEnd: 100,
        signature: 'function cleanup()',
        metadata: {
          callSites: [{ calleeName: 'removeEventListener', line: 2, receiver: 'window' }],
        },
      });

      // B imports A
      const nodeA = store.getNodeId('file', fA)!;
      const nodeB = store.getNodeId('file', fB)!;
      store.insertEdge(nodeB, nodeA, 'esm_imports', true, { specifiers: ['init'] });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['event_listener_leak'],
      });
      expect(result.isOk()).toBe(true);
      // Should NOT flag because cleanup exists in importing file
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Memory Leak Detection
  // -------------------------------------------------------------------

  describe('memory_leak', () => {
    test('detects Map/Set cache without eviction', () => {
      const fId = insertFile(store, 'src/services/cache.ts');
      // Variable that looks like a cache
      store.insertSymbol(fId, {
        symbolId: 'cache::responseCache#variable',
        name: 'responseCache',
        kind: 'variable',
        byteStart: 0,
        byteEnd: 50,
        signature: 'const responseCache = new Map<string, Response>()',
      });
      // Method that adds to it
      store.insertSymbol(fId, {
        symbolId: 'cache::cacheResponse#function',
        name: 'cacheResponse',
        kind: 'function',
        byteStart: 50,
        byteEnd: 150,
        signature: 'function cacheResponse(key: string, value: Response)',
        metadata: { callSites: [{ calleeName: 'set', line: 2, receiver: 'responseCache' }] },
      });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['memory_leak'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.length).toBeGreaterThanOrEqual(1);
      expect(data.findings[0].category).toBe('memory_leak');
      expect(data.findings[0].title).toContain('responseCache');
    });

    test('does not flag cache with eviction', () => {
      const fId = insertFile(store, 'src/services/managed-cache.ts');
      store.insertSymbol(fId, {
        symbolId: 'mc::cache#variable',
        name: 'cache',
        kind: 'variable',
        byteStart: 0,
        byteEnd: 50,
        signature: 'const cache = new Map<string, CacheEntry>()',
      });
      // Has both set and delete
      store.insertSymbol(fId, {
        symbolId: 'mc::set#function',
        name: 'setEntry',
        kind: 'function',
        byteStart: 50,
        byteEnd: 100,
        signature: 'function setEntry(k: string, v: CacheEntry)',
        metadata: { callSites: [{ calleeName: 'set', line: 2, receiver: 'cache' }] },
      });
      store.insertSymbol(fId, {
        symbolId: 'mc::evict#function',
        name: 'evict',
        kind: 'function',
        byteStart: 100,
        byteEnd: 150,
        signature: 'function evict(k: string)',
        metadata: { callSites: [{ calleeName: 'delete', line: 2, receiver: 'cache' }] },
      });

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['memory_leak'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('does not flag Map/Set without growth operations', () => {
      const fId = insertFile(store, 'src/services/static-map.ts');
      store.insertSymbol(fId, {
        symbolId: 'sm::lookup#variable',
        name: 'lookup',
        kind: 'variable',
        byteStart: 0,
        byteEnd: 50,
        signature: 'const lookup = new Map<string, number>()',
      });
      // No .set/.push/.add calls

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['memory_leak'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Circular Model Dependencies
  // -------------------------------------------------------------------

  describe('circular_dependency', () => {
    test('detects A → B → A cycle', () => {
      const fId = insertFile(store, 'src/models/Models.ts');
      const aId = insertModel(store, fId, 'A');
      const bId = insertModel(store, fId, 'B');
      insertAssoc(store, aId, bId, 'B', 'hasMany');
      insertAssoc(store, bId, aId, 'A', 'hasMany');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['circular_dependency'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.length).toBe(1);
      expect(data.findings[0].category).toBe('circular_dependency');
      expect(data.findings[0].confidence).toBe(1.0);
      expect(data.findings[0].description).toContain('→');
    });

    test('detects A → B → C → A cycle', () => {
      const fId = insertFile(store, 'src/models/Models.ts');
      const aId = insertModel(store, fId, 'A');
      const bId = insertModel(store, fId, 'B');
      const cId = insertModel(store, fId, 'C');
      insertAssoc(store, aId, bId, 'B', 'hasMany');
      insertAssoc(store, bId, cId, 'C', 'hasMany');
      insertAssoc(store, cId, aId, 'A', 'hasMany');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['circular_dependency'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.length).toBe(1);
      expect(data.findings[0].title).toContain('A');
      expect(data.findings[0].title).toContain('B');
      expect(data.findings[0].title).toContain('C');
    });

    test('does not flag acyclic graph', () => {
      const fId = insertFile(store, 'src/models/Models.ts');
      const aId = insertModel(store, fId, 'A');
      const bId = insertModel(store, fId, 'B');
      const cId = insertModel(store, fId, 'C');
      insertAssoc(store, aId, bId, 'B', 'hasMany');
      insertAssoc(store, bId, cId, 'C', 'hasMany');
      // No C → A, so no cycle

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['circular_dependency'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Missing Index
  // -------------------------------------------------------------------

  describe('missing_index', () => {
    test('detects FK without index in migrations', () => {
      const fModel = insertFile(store, 'src/models/Post.ts');
      const fMig = insertFile(store, 'db/migrations/001_create_posts.ts');
      const postId = insertModel(store, fModel, 'Post', 'sequelize', { table: 'posts' });
      const userId = insertModel(store, fModel, 'User', 'sequelize', { table: 'users' });

      insertAssoc(store, postId, userId, 'User', 'belongsTo', { foreignKey: 'user_id' });

      // Migration has no index on user_id
      store.insertMigration(
        {
          tableName: 'posts',
          operation: 'create',
          columns: [{ name: 'user_id', type: 'integer' }],
          indices: [],
        },
        fMig,
      );

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['missing_index'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.length).toBeGreaterThanOrEqual(1);
      expect(data.findings[0].category).toBe('missing_index');
      expect(data.findings[0].title).toContain('user_id');
    });

    test('does not flag FK with existing index', () => {
      const fModel = insertFile(store, 'src/models/Post.ts');
      const fMig = insertFile(store, 'db/migrations/001_create_posts.ts');
      const postId = insertModel(store, fModel, 'Post', 'sequelize', { table: 'posts' });
      const userId = insertModel(store, fModel, 'User', 'sequelize', { table: 'users' });

      insertAssoc(store, postId, userId, 'User', 'belongsTo', { foreignKey: 'user_id' });

      // Migration HAS index on user_id
      store.insertMigration(
        {
          tableName: 'posts',
          operation: 'create',
          columns: [{ name: 'user_id', type: 'integer' }],
          indices: [{ columns: ['user_id'] }],
        },
        fMig,
      );

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['missing_index'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('infers FK from ORM convention when no foreignKey option (lower confidence)', () => {
      const fModel = insertFile(store, 'src/models/Post.ts');
      const postId = insertModel(store, fModel, 'Post', 'sequelize', { table: 'posts' });
      const userId = insertModel(store, fModel, 'User', 'sequelize', { table: 'users' });
      insertAssoc(store, postId, userId, 'User', 'belongsTo'); // no foreignKey — inferred as user_id

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['missing_index'],
      });
      expect(result.isOk()).toBe(true);
      const findings = result._unsafeUnwrap().findings;
      expect(findings).toHaveLength(1);
      expect(findings[0].title).toContain('user_id');
      expect(findings[0].title).toContain('inferred');
      expect(findings[0].confidence).toBeLessThan(0.5);
    });

    test('does not flag inverse-side associations (hasMany/hasOne) without foreignKey', () => {
      // hasMany FK lives on the target table, not this model — so nothing to report here.
      const fModel = insertFile(store, 'src/models/User.ts');
      const userId = insertModel(store, fModel, 'User', 'sequelize', { table: 'users' });
      const postId = insertModel(store, fModel, 'Post', 'sequelize', { table: 'posts' });
      insertAssoc(store, userId, postId, 'Post', 'hasMany');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['missing_index'],
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Combined / Options
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // Size / complexity detectors (god_class, long_method, long_parameter_list, deep_nesting)
  // -------------------------------------------------------------------

  describe('god_class', () => {
    test('flags class with too many methods', () => {
      const fId = insertFile(store, 'src/Huge.ts');
      const classDbId = store.insertSymbol(fId, {
        symbolId: 'Huge#class',
        name: 'HugeService',
        kind: 'class' as any,
        byteStart: 0,
        byteEnd: 5000,
        lineStart: 1,
        lineEnd: 120,
      });
      for (let i = 0; i < 30; i++) {
        store.insertSymbol(
          fId,
          {
            symbolId: `Huge#m${i}`,
            name: `method${i}`,
            kind: 'method' as any,
            byteStart: 100 + i * 100,
            byteEnd: 100 + i * 100 + 50,
            lineStart: 2 + i * 2,
            lineEnd: 2 + i * 2 + 1,
          },
          classDbId,
        );
      }

      const result = detectAntipatterns(store, TEST_DIR, { category: ['god_class'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.length).toBe(1);
      expect(data.findings[0].category).toBe('god_class');
      expect(data.findings[0].title).toContain('HugeService');
    });

    test('flags class with excessive line count even without many methods', () => {
      const fId = insertFile(store, 'src/Big.ts');
      store.insertSymbol(fId, {
        symbolId: 'Big#class',
        name: 'BigBlob',
        kind: 'class' as any,
        byteStart: 0,
        byteEnd: 100000,
        lineStart: 1,
        lineEnd: 800,
      });

      const result = detectAntipatterns(store, TEST_DIR, { category: ['god_class'] });
      expect(result.isOk()).toBe(true);
      const findings = result._unsafeUnwrap().findings;
      expect(findings.length).toBe(1);
      expect(findings[0].title).toContain('BigBlob');
    });

    test('does NOT flag small classes', () => {
      const fId = insertFile(store, 'src/Small.ts');
      store.insertSymbol(fId, {
        symbolId: 'Small#class',
        name: 'Tiny',
        kind: 'class' as any,
        byteStart: 0,
        byteEnd: 200,
        lineStart: 1,
        lineEnd: 15,
      });

      const result = detectAntipatterns(store, TEST_DIR, { category: ['god_class'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings.length).toBe(0);
    });
  });

  describe('long_method', () => {
    test('flags function spanning many lines', () => {
      const fId = insertFile(store, 'src/long.ts');
      store.insertSymbol(fId, {
        symbolId: 'long#fn',
        name: 'bigFunction',
        kind: 'function' as any,
        byteStart: 0,
        byteEnd: 5000,
        lineStart: 10,
        lineEnd: 85,
        signature: 'function bigFunction()',
      });

      const result = detectAntipatterns(store, TEST_DIR, { category: ['long_method'] });
      expect(result.isOk()).toBe(true);
      const findings = result._unsafeUnwrap().findings;
      expect(findings.length).toBe(1);
      expect(findings[0].title).toContain('bigFunction');
      expect(findings[0].title).toContain('75 lines');
    });

    test('does NOT flag short functions', () => {
      const fId = insertFile(store, 'src/short.ts');
      store.insertSymbol(fId, {
        symbolId: 'short#fn',
        name: 'tinyFn',
        kind: 'function' as any,
        byteStart: 0,
        byteEnd: 100,
        lineStart: 1,
        lineEnd: 30,
        signature: 'function tinyFn()',
      });

      const result = detectAntipatterns(store, TEST_DIR, { category: ['long_method'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings.length).toBe(0);
    });

    test('severity scales with length', () => {
      const fId = insertFile(store, 'src/huge.ts');
      store.insertSymbol(fId, {
        symbolId: 'huge#fn',
        name: 'epicFn',
        kind: 'function' as any,
        byteStart: 0,
        byteEnd: 100000,
        lineStart: 1,
        lineEnd: 300,
        signature: 'function epicFn()',
      });

      const result = detectAntipatterns(store, TEST_DIR, { category: ['long_method'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings[0].severity).toBe('high');
    });
  });

  describe('long_parameter_list', () => {
    test('flags function with many parameters', () => {
      const fId = insertFile(store, 'src/many.ts');
      store.insertSymbol(fId, {
        symbolId: 'many#fn',
        name: 'tooManyParams',
        kind: 'function' as any,
        byteStart: 0,
        byteEnd: 200,
        lineStart: 1,
        lineEnd: 10,
        signature:
          'function tooManyParams(a: string, b: number, c: boolean, d: Date, e: object, f: string, g: number)',
      });

      const result = detectAntipatterns(store, TEST_DIR, { category: ['long_parameter_list'] });
      expect(result.isOk()).toBe(true);
      const findings = result._unsafeUnwrap().findings;
      expect(findings.length).toBe(1);
      expect(findings[0].title).toContain('7 params');
    });

    test('handles nested generics without counting internal commas', () => {
      const fId = insertFile(store, 'src/generics.ts');
      store.insertSymbol(fId, {
        symbolId: 'gen#fn',
        name: 'hasGenerics',
        kind: 'function' as any,
        byteStart: 0,
        byteEnd: 200,
        lineStart: 1,
        lineEnd: 10,
        signature: 'function hasGenerics(a: Map<string, number>, b: Record<string, Array<number>>)',
      });

      const result = detectAntipatterns(store, TEST_DIR, { category: ['long_parameter_list'] });
      expect(result.isOk()).toBe(true);
      // Only 2 real params despite 3 commas in generics
      expect(result._unsafeUnwrap().findings.length).toBe(0);
    });

    test('does NOT flag functions with 5 or fewer parameters', () => {
      const fId = insertFile(store, 'src/ok.ts');
      store.insertSymbol(fId, {
        symbolId: 'ok#fn',
        name: 'okFn',
        kind: 'function' as any,
        byteStart: 0,
        byteEnd: 200,
        lineStart: 1,
        lineEnd: 10,
        signature: 'function okFn(a: string, b: number, c: boolean, d: Date, e: object)',
      });

      const result = detectAntipatterns(store, TEST_DIR, { category: ['long_parameter_list'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings.length).toBe(0);
    });
  });

  describe('deep_nesting', () => {
    test('flags function with deep indentation', () => {
      const content = `function deeplyNested() {
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          if (e) {
            doSomething();
          }
        }
      }
    }
  }
}
`;
      const absPath = path.join(TEST_DIR, 'src/deep.ts');
      mkdirSync(path.dirname(absPath), { recursive: true });
      writeFileSync(absPath, content);
      const fId = store.insertFile('src/deep.ts', 'typescript', 'hash-deep', content.length);
      store.insertSymbol(fId, {
        symbolId: 'deep#fn',
        name: 'deeplyNested',
        kind: 'function' as any,
        byteStart: 0,
        byteEnd: content.length,
        lineStart: 1,
        lineEnd: content.split('\n').length,
        signature: 'function deeplyNested()',
      });

      const result = detectAntipatterns(store, TEST_DIR, { category: ['deep_nesting'] });
      expect(result.isOk()).toBe(true);
      const findings = result._unsafeUnwrap().findings;
      expect(findings.length).toBe(1);
      expect(findings[0].category).toBe('deep_nesting');
    });

    test('does NOT flag flat functions', () => {
      const content = `function flat() {
  const a = 1;
  const b = 2;
  return a + b;
}
`;
      const absPath = path.join(TEST_DIR, 'src/flat.ts');
      mkdirSync(path.dirname(absPath), { recursive: true });
      writeFileSync(absPath, content);
      const fId = store.insertFile('src/flat.ts', 'typescript', 'hash-flat', content.length);
      store.insertSymbol(fId, {
        symbolId: 'flat#fn',
        name: 'flat',
        kind: 'function' as any,
        byteStart: 0,
        byteEnd: content.length,
        lineStart: 1,
        lineEnd: content.split('\n').length,
        signature: 'function flat()',
      });

      const result = detectAntipatterns(store, TEST_DIR, { category: ['deep_nesting'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings.length).toBe(0);
    });
  });

  describe('options', () => {
    test('runs all categories by default', () => {
      const fId = insertFile(store, 'src/models/User.ts');
      const userId = insertModel(store, fId, 'User');
      const postId = insertModel(store, fId, 'Post');
      insertAssoc(store, userId, postId, 'Post', 'hasMany');
      insertAssoc(store, postId, userId, 'User', 'hasMany'); // cycle

      const result = detectAntipatterns(store, TEST_DIR);
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.categories_checked.length).toBe(11);
    });

    test('filters by severity threshold', () => {
      const fId = insertFile(store, 'src/models/User.ts');
      const userId = insertModel(store, fId, 'User');
      const postId = insertModel(store, fId, 'Post');
      insertAssoc(store, userId, postId, 'Post', 'hasMany'); // high severity

      // Circular (low severity)
      insertAssoc(store, postId, userId, 'User', 'hasMany');

      const result = detectAntipatterns(store, TEST_DIR, {
        severity_threshold: 'high',
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      for (const f of data.findings) {
        expect(['critical', 'high']).toContain(f.severity);
      }
    });

    test('respects limit', () => {
      const fId = insertFile(store, 'src/models/User.ts');
      const userId = insertModel(store, fId, 'User');
      // Create many to-many associations to generate multiple N+1 findings
      for (let i = 0; i < 10; i++) {
        const relId = insertModel(store, fId, `Rel${i}`);
        insertAssoc(store, userId, relId, `Rel${i}`, 'hasMany');
      }

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['n_plus_one_risk'],
        limit: 3,
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings.length).toBe(3);
    });

    test('findings are sorted by severity then confidence', () => {
      const fId = insertFile(store, 'src/models/Models.ts');
      const aId = insertModel(store, fId, 'A');
      const bId = insertModel(store, fId, 'B');
      const cId = insertModel(store, fId, 'C');
      // N+1 (high severity)
      insertAssoc(store, aId, bId, 'B', 'hasMany');
      // Circular (low severity)
      insertAssoc(store, bId, cId, 'C', 'hasMany');
      insertAssoc(store, cId, bId, 'B', 'hasMany');

      const result = detectAntipatterns(store, TEST_DIR);
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      if (data.findings.length >= 2) {
        const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        for (let i = 1; i < data.findings.length; i++) {
          const prev = sevOrder[data.findings[i - 1].severity];
          const curr = sevOrder[data.findings[i].severity];
          expect(prev).toBeLessThanOrEqual(curr);
        }
      }
    });

    test('summary counts are correct', () => {
      const fId = insertFile(store, 'src/models/User.ts');
      const userId = insertModel(store, fId, 'User');
      const postId = insertModel(store, fId, 'Post');
      insertAssoc(store, userId, postId, 'Post', 'hasMany');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['n_plus_one_risk'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const total =
        data.summary.critical + data.summary.high + data.summary.medium + data.summary.low;
      expect(total).toBe(data.findings.length);
    });

    test('returns empty when no ORM models indexed', () => {
      const result = detectAntipatterns(store, TEST_DIR);
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(0);
      expect(data.models_analyzed).toBe(0);
    });

    test('respects file_pattern filter', () => {
      const fA = insertFile(store, 'src/models/User.ts');
      const fB = insertFile(store, 'lib/models/Legacy.ts');
      const userId = insertModel(store, fA, 'User');
      const legacyId = insertModel(store, fB, 'Legacy');
      const postId = insertModel(store, fA, 'Post');
      const oldId = insertModel(store, fB, 'Old');
      insertAssoc(store, userId, postId, 'Post', 'hasMany');
      insertAssoc(store, legacyId, oldId, 'Old', 'hasMany');

      const result = detectAntipatterns(store, TEST_DIR, {
        category: ['n_plus_one_risk'],
        file_pattern: 'src/',
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      for (const f of data.findings) {
        expect(f.file).toContain('src/');
      }
    });
  });
});
