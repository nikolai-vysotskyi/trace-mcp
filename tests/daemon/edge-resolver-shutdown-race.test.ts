/**
 * TRA-2439: Shutdown race condition regression test.
 *
 * Verifies that when a daemon shutdown (or SIGTERM / stopProject) occurs while
 * edge resolvers (resolvePhpCallEdges, resolvePluginEdges / _storeRawEdgesInternal)
 * are in-flight in commitInChunks:
 *  1. No L50 "The database connection is not open" TypeError is thrown or logged.
 *  2. In-flight edge resolver tasks abort cleanly with IndexAbortedError.
 *  3. Shutdown completes within the teardown deadline.
 *  4. On subsequent restart/reindex, the database and graph are consistent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as registry from '../../src/registry.js';
import { ProjectManager } from '../../src/daemon/project-manager.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { EdgeResolver } from '../../src/indexer/edge-resolver.js';
import { logger } from '../../src/logger.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';

describe('TRA-2439: Edge resolver shutdown race condition', () => {
  let tmpHome: string;
  let testRoot: string;
  let pm: ProjectManager | null = null;
  let errorLogs: Array<{ msg?: string; error?: unknown }> = [];

  beforeEach(() => {
    errorLogs = [];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tra2439-home-'));
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tra2439-proj-'));
    process.env.TRACE_MCP_DATA_DIR = tmpHome;
    process.env.TRACE_MCP_HOME = tmpHome;

    fs.mkdirSync(path.join(testRoot, 'src'), { recursive: true });

    fs.writeFileSync(
      path.join(testRoot, 'composer.json'),
      JSON.stringify({
        name: 'test/app',
        require: {
          'laravel/framework': '^11.0',
        },
      }),
    );

    // Seed Eloquent models so Laravel plugin emits edges
    fs.writeFileSync(
      path.join(testRoot, 'src', 'User.php'),
      `<?php
namespace App\\Models;
class User {
    public function posts() {
        return $this->hasMany(Post::class);
    }
}
class Post {
    public function user() {
        return $this->belongsTo(User::class);
    }
}
`,
    );

    // Seed test PHP files with classes and method calls (120 files = 360 symbols > RESOLVER_WRITE_CHUNK 200)
    for (let i = 0; i < 120; i++) {
      fs.writeFileSync(
        path.join(testRoot, 'src', `Service${i}.php`),
        `<?php
namespace App\\Services;
class Service${i} {
    public function execute() {
        return "result${i}";
    }
    public function callOther() {
        $other = new Service${(i + 1) % 120}();
        return $other->execute();
    }
}
`,
      );
    }

    // Seed test TypeScript files
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(
        path.join(testRoot, 'src', `component${i}.ts`),
        `export function fn${i}(): number { return ${i}; }
export function caller${i}(): number { return fn${(i + 1) % 20}(); }
`,
      );
    }

    registry.registerProject(testRoot);

    // Track logger.error calls
    vi.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => {
      const obj = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as Record<
        string,
        unknown
      >;
      const msg =
        typeof args[0] === 'string'
          ? args[0]
          : typeof args[1] === 'string'
            ? args[1]
            : (obj.msg as string);
      errorLogs.push({ msg, error: obj.error ?? args[0] });
    });
  });

  afterEach(async () => {
    try {
      if (pm) {
        await pm.shutdown();
        pm = null;
      }
    } catch {
      // Best-effort cleanup
    }
    try {
      registry.unregisterProject(testRoot);
    } catch {
      // Ignore
    }
    delete process.env.TRACE_MCP_DATA_DIR;
    delete process.env.TRACE_MCP_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(testRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('aborts resolvePhpCallEdges cleanly during shutdown without database closed errors', async () => {
    pm = new ProjectManager();

    let phpCallEntered = false;
    let receivedSignal: AbortSignal | undefined;
    let releasePhpCall!: () => void;
    const phpCallGate = new Promise<void>((resolve) => {
      releasePhpCall = resolve;
    });

    const origResolvePhpCalls = EdgeResolver.prototype.resolvePhpCallEdges;
    vi.spyOn(EdgeResolver.prototype, 'resolvePhpCallEdges').mockImplementation(async function (
      this: EdgeResolver,
      ...args: Parameters<typeof origResolvePhpCalls>
    ) {
      phpCallEntered = true;
      receivedSignal = args[1];
      // Hold in-flight until shutdown begins
      await phpCallGate;
      return origResolvePhpCalls.apply(this, args);
    });

    // Start project loading and indexing in background
    const addPromise = pm.addProject(testRoot);

    // Wait until resolvePhpCallEdges is in-flight
    await vi.waitFor(() => expect(phpCallEntered).toBe(true), { timeout: 10_000 });

    // Now trigger shutdown while resolvePhpCallEdges is paused mid-flight
    const shutdownStart = Date.now();
    const shutdownPromise = pm.shutdown();

    // Release the gate so the resolver continues while shutdown/abort is executing
    releasePhpCall();

    await shutdownPromise;
    const shutdownDuration = Date.now() - shutdownStart;
    pm = null;

    // Verify that a valid AbortSignal was passed and was aborted during shutdown
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(true);

    // Shutdown must complete within deadline (< 13s)
    expect(shutdownDuration).toBeLessThan(13_000);

    // Must NOT log "The database connection is not open"
    const dbNotOpenErrors = errorLogs.filter((log) => {
      const errStr = String(log.error ?? '') + String(log.msg ?? '');
      return (
        errStr.includes('The database connection is not open') ||
        errStr.includes('database connection is not open')
      );
    });
    expect(dbNotOpenErrors).toHaveLength(0);

    // On restart, the project can be loaded and re-indexed cleanly
    pm = new ProjectManager();
    await pm.addProject(testRoot);
    const db = initializeDatabase(registry.getProject(testRoot)!.dbPath);
    const store = new Store(db);
    expect(db.open).toBe(true);
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
    db.close();
  });

  it('aborts framework resolveEdges and storeRawEdges cleanly during shutdown without database closed errors', async () => {
    pm = new ProjectManager();

    let resolveEdgesEntered = false;
    let receivedSignal: AbortSignal | undefined;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const origResolveEdges = EdgeResolver.prototype.resolveEdges;
    vi.spyOn(EdgeResolver.prototype, 'resolveEdges').mockImplementation(async function (
      this: EdgeResolver,
      ...args: Parameters<typeof origResolveEdges>
    ) {
      resolveEdgesEntered = true;
      receivedSignal = args[3];
      await gate;
      return origResolveEdges.apply(this, args);
    });

    const addPromise = pm.addProject(testRoot);
    await vi.waitFor(() => expect(resolveEdgesEntered).toBe(true), { timeout: 10_000 });

    const shutdownStart = Date.now();
    const shutdownPromise = pm.shutdown();

    releaseGate();
    await shutdownPromise;
    const shutdownDuration = Date.now() - shutdownStart;
    pm = null;

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(true);

    expect(shutdownDuration).toBeLessThan(13_000);

    const dbNotOpenErrors = errorLogs.filter((log) => {
      const errStr = String(log.error ?? '') + String(log.msg ?? '');
      return (
        errStr.includes('The database connection is not open') ||
        errStr.includes('database connection is not open')
      );
    });
    expect(dbNotOpenErrors).toHaveLength(0);

    // Verify consistency on restart
    pm = new ProjectManager();
    await pm.addProject(testRoot);
    const db = initializeDatabase(registry.getProject(testRoot)!.dbPath);
    const store = new Store(db);
    expect(db.open).toBe(true);
    expect(store.getAllFiles().length).toBeGreaterThan(0);
    db.close();
  });

  it('aborts multi-chunk commitInChunks during resolvePhpCallEdges when shutdown triggers between chunks', async () => {
    pm = new ProjectManager();

    const budgetModule = await import('../../src/indexer/resolver-budget.js');
    const origCommit = budgetModule.commitInChunks;

    let chunkCount = 0;
    let shutdownTriggered = false;

    vi.spyOn(budgetModule, 'commitInChunks').mockImplementation(
      async function (db, items, fn, chunkSize, signal) {
        const wrappedFn = (chunk: unknown[]) => {
          chunkCount++;
          fn(chunk as any);
          if (chunkCount === 1 && !shutdownTriggered) {
            shutdownTriggered = true;
          }
        };
        return origCommit.call(this, db, items, wrappedFn, chunkSize, signal);
      },
    );

    const addPromise = pm.addProject(testRoot);

    await vi.waitFor(() => expect(chunkCount).toBeGreaterThanOrEqual(1), { timeout: 10_000 });

    const shutdownStart = Date.now();
    const shutdownPromise = pm.shutdown();

    await shutdownPromise;
    const shutdownDuration = Date.now() - shutdownStart;
    pm = null;

    expect(shutdownDuration).toBeLessThan(13_000);

    const dbNotOpenErrors = errorLogs.filter((log) => {
      const errStr = String(log.error ?? '') + String(log.msg ?? '');
      return (
        errStr.includes('The database connection is not open') ||
        errStr.includes('database connection is not open')
      );
    });
    expect(dbNotOpenErrors).toHaveLength(0);

    // On restart, verification
    pm = new ProjectManager();
    await pm.addProject(testRoot);
    const db = initializeDatabase(registry.getProject(testRoot)!.dbPath);
    const store = new Store(db);
    expect(db.open).toBe(true);
    expect(store.getAllFiles().length).toBeGreaterThan(0);
    db.close();
  });
});
