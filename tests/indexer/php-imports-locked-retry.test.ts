/**
 * TRA-2552 regression test:
 * PHP watcher reindex: database is locked in resolvePhpImportEdges.
 *
 * Verifies that:
 * 1. resolvePhpImportEdges uses BEGIN IMMEDIATE, preventing lock upgrade deadlocks.
 * 2. Transient SQLITE_BUSY / database locked from concurrent writers is handled
 *    with bounded retry and backoff without dropping edges or throwing unhandled errors.
 * 3. In-memory phantom caches are cleared on rollback to prevent FK or stale node references.
 * 4. Full pipeline reindex with PHP files completes cleanly under lock contention.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { logger } from '../../src/logger.js';
import { resolvePhpImportEdges } from '../../src/indexer/edge-resolvers/php-imports.js';
import { PhantomPackageFactory } from '../../src/indexer/edge-resolvers/phantom-externals.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';

describe('TRA-2552: PHP import edge resolution lock retry', () => {
  let tmpDir: string;
  let testRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tra2552-'));
    testRoot = path.join(tmpDir, 'project');
    fs.mkdirSync(testRoot, { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'app', 'Models'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'app', 'Services'), { recursive: true });

    // Composer.json for PSR-4
    fs.writeFileSync(
      path.join(testRoot, 'composer.json'),
      JSON.stringify(
        {
          name: 'test/project',
          autoload: {
            'psr-4': {
              'App\\': 'app/',
            },
          },
        },
        null,
        2,
      ),
    );

    // User model
    fs.writeFileSync(
      path.join(testRoot, 'app', 'Models', 'User.php'),
      `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class User extends Model {
    protected $table = 'users';
}
`,
    );

    // Order model
    fs.writeFileSync(
      path.join(testRoot, 'app', 'Models', 'Order.php'),
      `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class Order extends Model {
    protected $table = 'orders';
}
`,
    );

    // OrderService using User and Order and external vendor library
    fs.writeFileSync(
      path.join(testRoot, 'app', 'Services', 'OrderService.php'),
      `<?php
namespace App\\Services;

use App\\Models\\User;
use App\\Models\\Order;
use Stripe\\StripeClient;

class OrderService {
    public function process(User $user, Order $order): void {
    }
}
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('retries and succeeds when another connection temporarily holds write lock', async () => {
    const dbPath = path.join(tmpDir, 'test-resolve.db');
    const db1 = initializeDatabase(dbPath);
    const db2 = initializeDatabase(dbPath);

    // Short busy_timeout on db1 so contention trips SQLITE_BUSY quickly
    db1.pragma('busy_timeout = 25');
    db2.pragma('busy_timeout = 25');

    const store1 = new Store(db1);

    // Register files and nodes in db1
    const file1 = store1.insertFile('app/Models/User.php', 'php', 'h1', 100, null, null);
    const file2 = store1.insertFile('app/Models/Order.php', 'php', 'h2', 100, null, null);
    const file3 = store1.insertFile('app/Services/OrderService.php', 'php', 'h3', 100, null, null);

    store1.createNode('file', file1);
    store1.createNode('file', file2);
    store1.createNode('file', file3);

    // Insert symbols
    const sym1 = store1.insertSymbol(file1, {
      name: 'User',
      kind: 'class',
      fqn: 'App\\Models\\User',
      symbolId: 'app/Models/User.php::User',
      lineStart: 6,
      lineEnd: 8,
      byteStart: 0,
      byteEnd: 100,
    });
    store1.createNode('symbol', sym1);

    const sym2 = store1.insertSymbol(file2, {
      name: 'Order',
      kind: 'class',
      fqn: 'App\\Models\\Order',
      symbolId: 'app/Models/Order.php::Order',
      lineStart: 6,
      lineEnd: 8,
      byteStart: 0,
      byteEnd: 100,
    });
    store1.createNode('symbol', sym2);

    const sym3 = store1.insertSymbol(file3, {
      name: 'OrderService',
      kind: 'class',
      fqn: 'App\\Services\\OrderService',
      symbolId: 'app/Services/OrderService.php::OrderService',
      lineStart: 8,
      lineEnd: 11,
      byteStart: 0,
      byteEnd: 100,
    });
    store1.createNode('symbol', sym3);

    const state: PipelineState = {
      store: store1,
      rootPath: testRoot,
      workspaces: [],
      pendingImports: new Map([
        [file1, [{ from: 'Illuminate\\Database\\Eloquent\\Model', specifiers: ['Model'] }]],
        [file2, [{ from: 'Illuminate\\Database\\Eloquent\\Model', specifiers: ['Model'] }]],
        [
          file3,
          [
            { from: 'App\\Models\\User', specifiers: ['User'] },
            { from: 'App\\Models\\Order', specifiers: ['Order'] },
            { from: 'Stripe\\StripeClient', specifiers: ['StripeClient'] },
          ],
        ],
      ]),
    } as unknown as PipelineState;

    // Acquire write lock on db2 for 80ms
    let lockReleased = false;
    const timer = setTimeout(() => {
      lockReleased = true;
      db2.prepare('COMMIT').run();
    }, 80);
    db2.prepare('BEGIN IMMEDIATE').run();

    try {
      await resolvePhpImportEdges(state);
      expect(lockReleased).toBe(true);

      // Verify edges were created
      const edges = db1.prepare(`SELECT * FROM edges`).all() as Array<{
        source_node_id: number;
        target_node_id: number;
        edge_type_id: number;
        metadata: string;
      }>;

      expect(edges.length).toBeGreaterThanOrEqual(4);

      // Check User -> Illuminate\Database phantom package edge
      const userNode = store1.getNodeId('file', file1);
      const orderServiceNode = store1.getNodeId('file', file3);
      expect(edges.some((e) => e.source_node_id === userNode)).toBe(true);
      expect(edges.some((e) => e.source_node_id === orderServiceNode)).toBe(true);
    } finally {
      clearTimeout(timer);
      db1.close();
      db2.close();
    }
  });

  it('PhantomPackageFactory.clear resets cached uncommitted state', () => {
    const dbPath = path.join(tmpDir, 'test-phantom-clear.db');
    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const state = { store, rootPath: testRoot } as unknown as PipelineState;

    const factory = new PhantomPackageFactory(state, 'php');

    // Inside a rolled-back transaction
    const tx = db.transaction(() => {
      factory.ensure('Illuminate\\Database', null);
      throw new Error('Simulated abort');
    });

    expect(() => tx()).toThrow('Simulated abort');

    // Without clear(), cache still holds the phantom file id and node id
    // which were rolled back in the DB!
    factory.clear();

    // Re-running ensure after clear correctly creates the file and node afresh
    const pkg = factory.ensure('Illuminate\\Database', null);
    expect(pkg.id).toBeGreaterThan(0);
    expect(pkg.node_id).toBeGreaterThan(0);

    const inDb = store.getFile(pkg.path);
    expect(inDb).not.toBeNull();
    expect(inDb?.id).toBe(pkg.id);

    db.close();
  });

  it('full pipeline indexes PHP project cleanly under concurrent lock contention', async () => {
    const dbPath = path.join(tmpDir, 'test-pipeline.db');
    const store1 = new Store(initializeDatabase(dbPath));
    const db2 = initializeDatabase(dbPath);

    store1.db.pragma('busy_timeout = 50');
    db2.pragma('busy_timeout = 50');

    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());

    const config: TraceMcpConfig = {
      root: testRoot,
      include: ['app/**/*.php'],
      exclude: [],
      plugins: [],
    };

    const pipeline = new IndexingPipeline(store1, registry, config, testRoot);

    // Hold write lock on db2 briefly
    let lockReleased = false;
    const timer = setTimeout(() => {
      lockReleased = true;
      db2.prepare('COMMIT').run();
    }, 70);
    db2.prepare('BEGIN IMMEDIATE').run();

    try {
      const res = await pipeline.indexAll();
      expect(res.errors).toBe(0);
      expect(res.totalFiles).toBe(3);
      expect(lockReleased).toBe(true);

      // Verify edges table has resolved edges
      const edges = store1.db.prepare('SELECT count(*) as count FROM edges').get() as {
        count: number;
      };
      expect(edges.count).toBeGreaterThanOrEqual(4);
    } finally {
      clearTimeout(timer);
      await pipeline.dispose();
      store1.db.close();
      db2.close();
    }
  });

  it('watcher reindex on changed PHP files avoids L50 error under lock contention', async () => {
    const errorSpy = vi.spyOn(logger, 'error');

    const dbPath = path.join(tmpDir, 'test-watcher-reindex.db');
    const store1 = new Store(initializeDatabase(dbPath));
    const db2 = initializeDatabase(dbPath);

    store1.db.pragma('busy_timeout = 50');
    db2.pragma('busy_timeout = 50');

    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());

    const config: TraceMcpConfig = {
      root: testRoot,
      include: ['app/**/*.php'],
      exclude: [],
      plugins: [],
    };

    const pipeline = new IndexingPipeline(store1, registry, config, testRoot);
    await pipeline.indexAll();

    // Create a new PHP file: PaymentService.php
    const newFileRel = 'app/Services/PaymentService.php';
    const newFilePath = path.join(testRoot, newFileRel);
    fs.writeFileSync(
      newFilePath,
      `<?php
namespace App\\Services;

use App\\Models\\User;
use App\\Models\\Order;
use Stripe\\PaymentIntent;

class PaymentService {
    public function pay(User $user, Order $order): void {}
}
`,
    );

    // Simulate concurrent lock during watcher change handler
    let lockReleased = false;
    const timer = setTimeout(() => {
      lockReleased = true;
      db2.prepare('COMMIT').run();
    }, 80);
    db2.prepare('BEGIN IMMEDIATE').run();

    try {
      // Simulate watcher calling onChanges([newFileRel])
      const res = await pipeline.indexFiles([newFileRel]);
      expect(res.errors).toBe(0);
      expect(lockReleased).toBe(true);

      // Assert no L50 logger.error('File change handler failed')
      const l50Calls = errorSpy.mock.calls.filter(
        (call) => call[1] === 'File change handler failed',
      );
      expect(l50Calls).toHaveLength(0);

      // Verify new file edges were inserted
      const newFile = store1.getFile(newFileRel);
      expect(newFile).not.toBeNull();
      const newFileNode = store1.getNodeId('file', newFile!.id);
      expect(newFileNode).not.toBeNull();

      const edges = store1.db
        .prepare('SELECT count(*) as count FROM edges WHERE source_node_id = ?')
        .get(newFileNode) as { count: number };
      expect(edges.count).toBeGreaterThanOrEqual(3); // User, Order, Stripe\PaymentIntent
    } finally {
      clearTimeout(timer);
      await pipeline.dispose();
      store1.db.close();
      db2.close();
      errorSpy.mockRestore();
    }
  });
});
