import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { SpanMapper } from '../../src/runtime/mapper.js';
import { createTestStore } from '../test-utils.js';

function createTestDb(): { db: Database.Database; store: Store } {
  const store = createTestStore();
  const db = store.db;
  // runtime_spans + runtime_traces are now seeded by the fresh-DB DDL
  // (see src/db/schema.ts v12 mirror). Insert a parent trace so spans
  // inserted with trace_id=1 satisfy the FK that ships with the real schema.
  db.prepare(
    `INSERT INTO runtime_traces (id, trace_id, started_at) VALUES (1, 'trace-1', datetime('now'))`,
  ).run();
  return { db, store };
}

describe('SpanMapper', () => {
  let db: Database.Database;
  let store: Store;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    store = t.store;
  });
  afterEach(() => {
    db.close();
  });

  it('maps span by FQN (code.function + code.namespace)', () => {
    // Insert a symbol
    const fileId = store.insertFile('src/user.ts', 'typescript', 'hash1', 100);
    const symId = store.insertSymbol(fileId, {
      symbolId: 'src/user.ts::UserService#class',
      name: 'UserService',
      kind: 'class',
      fqn: 'UserModule.UserService',
      signature: 'class UserService',
      byteStart: 0,
      byteEnd: 100,
      lineStart: 1,
      lineEnd: 10,
    });
    store.createNode('symbol', symId);

    // Insert unmapped span with code attributes
    db.prepare(`
      INSERT INTO runtime_spans (trace_id, span_id, service_name, operation, kind, started_at, duration_us, status_code, attributes, mapped_node_id, mapping_method)
      VALUES (1, 'span-1', 'svc', 'UserModule.UserService', 'server', datetime('now'), 500, 0, ?, NULL, NULL)
    `).run(
      JSON.stringify([
        { key: 'code.function', value: { stringValue: 'UserService' } },
        { key: 'code.namespace', value: { stringValue: 'UserModule' } },
      ]),
    );

    const mapper = new SpanMapper(store, db, { routePatterns: [] });
    const mapped = mapper.mapUnmapped();
    expect(mapped).toBe(1);
  });

  it('returns 0 when no unmapped spans exist', () => {
    const mapper = new SpanMapper(store, db, { routePatterns: [] });
    expect(mapper.mapUnmapped()).toBe(0);
  });

  it('maps span by file path + line number', () => {
    const fileId = store.insertFile('src/handler.ts', 'typescript', 'hash2', 200);
    const symId = store.insertSymbol(fileId, {
      symbolId: 'src/handler.ts::handleRequest#function',
      name: 'handleRequest',
      kind: 'function',
      signature: 'function handleRequest()',
      byteStart: 0,
      byteEnd: 100,
      lineStart: 5,
      lineEnd: 20,
    });
    store.createNode('file', fileId);
    store.createNode('symbol', symId);

    db.prepare(`
      INSERT INTO runtime_spans (trace_id, span_id, service_name, operation, kind, started_at, duration_us, status_code, attributes, mapped_node_id, mapping_method)
      VALUES (1, 'span-file', 'svc', 'handleRequest', 'server', datetime('now'), 100, 0, ?, NULL, NULL)
    `).run(
      JSON.stringify([
        { key: 'code.filepath', value: { stringValue: 'src/handler.ts' } },
        { key: 'code.lineno', value: { stringValue: '10' } },
      ]),
    );

    const mapper = new SpanMapper(store, db, { routePatterns: [] });
    const mapped = mapper.mapUnmapped();
    expect(mapped).toBe(1);
  });
});
