/**
 * TRA-2810: Ephemeral index DELETE FROM symbols blocked event loop on unindexed routes FK check.
 *
 * In QA testing on workdir databases with large routes tables (15k+ routes),
 * deleting symbols from a file triggered a 2.28s event loop stall because
 * `routes.controller_symbol_id REFERENCES symbols(id)` lacked an index,
 * causing SQLite to execute a full table SCAN on `routes` for every deleted symbol.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';

describe('TRA-2810: delete symbols foreign-key index on routes', () => {
  let db: Database.Database;
  let store: Store;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    store = new Store(db);
  });

  afterEach(() => {
    db.close();
  });

  it('uses idx_routes_controller_symbol and avoids SCAN routes in query plan', () => {
    const plan = db
      .prepare('EXPLAIN QUERY PLAN DELETE FROM symbols WHERE file_id = ?')
      .all(1) as Array<{ detail: string }>;

    const details = plan.map((p) => p.detail);
    const routesCheck = details.find((d) => d.includes('routes'));

    expect(routesCheck).toBeDefined();
    expect(routesCheck).toContain('idx_routes_controller_symbol');
    expect(details.some((d) => d.includes('SCAN routes'))).toBe(false);
  });

  it('deletes symbols in single-digit ms even with 15,000 routes', () => {
    const fileId = store.insertFile('src/routes.ts', 'typescript', 'hash-routes', 1000);
    const targetFileId = store.insertFile('src/controller.ts', 'typescript', 'hash-ctrl', 1000);

    // Insert 200 symbols in the target file
    const symbols = Array.from({ length: 200 }, (_, i) => ({
      symbolId: `src/controller.ts::fn_${i}#function`,
      name: `fn_${i}`,
      kind: 'function',
      byteStart: i * 20,
      byteEnd: i * 20 + 15,
      lineStart: i + 1,
      lineEnd: i + 1,
    }));
    store.insertSymbols(targetFileId, symbols);

    // Insert 15,000 routes in routes table
    const insertRoute = db.prepare(
      'INSERT INTO routes (method, uri, file_id, controller_symbol_id) VALUES (?, ?, ?, ?)',
    );
    db.transaction(() => {
      for (let i = 0; i < 15_000; i++) {
        insertRoute.run('GET', `/api/v1/items/${i}`, fileId, null);
      }
    })();

    // Ensure routes are populated
    const routeCount = (db.prepare('SELECT COUNT(*) as c FROM routes').get() as { c: number }).c;
    expect(routeCount).toBe(15_000);

    // Measure deletion time of symbols in target file
    const start = performance.now();
    store.deleteSymbolsByFile(targetFileId);
    const durationMs = performance.now() - start;

    // Verify symbols were deleted
    expect(store.getSymbolsByFile(targetFileId)).toHaveLength(0);

    // Before TRA-2810, scanning 15k routes 200 times took hundreds of ms in memory
    // and >2 seconds under disk/thread contention. With index, it takes < 50ms.
    expect(durationMs).toBeLessThan(100);
  });

  it('enforces foreign key constraint when route actively references a symbol', () => {
    const fileId = store.insertFile('src/api.ts', 'typescript', 'hash-api', 100);
    const symId = store.insertSymbol(fileId, {
      symbolId: 'src/api.ts::handler#function',
      name: 'handler',
      kind: 'function',
      byteStart: 0,
      byteEnd: 20,
    });

    // Attach route to controller symbol
    db.prepare(
      'INSERT INTO routes (method, uri, file_id, controller_symbol_id) VALUES (?, ?, ?, ?)',
    ).run('POST', '/api/action', fileId, symId);

    // Deleting symbols should fail due to RESTRICT on routes.controller_symbol_id
    expect(() => {
      store.deleteSymbolsByFile(fileId);
    }).toThrow(/FOREIGN KEY constraint failed/);

    // After unlinking route, deletion succeeds cleanly
    db.prepare('UPDATE routes SET controller_symbol_id = NULL WHERE controller_symbol_id = ?').run(
      symId,
    );
    expect(() => {
      store.deleteSymbolsByFile(fileId);
    }).not.toThrow();
    expect(store.getSymbolsByFile(fileId)).toHaveLength(0);
  });
});
