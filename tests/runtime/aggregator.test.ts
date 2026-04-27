import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeAggregator } from '../../src/runtime/aggregator.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE runtime_spans (
      id INTEGER PRIMARY KEY,
      trace_id INTEGER NOT NULL,
      span_id TEXT UNIQUE NOT NULL,
      parent_span_id TEXT,
      service_name TEXT,
      operation TEXT,
      kind TEXT,
      started_at TEXT,
      duration_us INTEGER,
      status_code INTEGER,
      status_message TEXT,
      attributes TEXT,
      mapped_node_id INTEGER,
      mapping_method TEXT
    );
    CREATE TABLE runtime_aggregates (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL,
      bucket TEXT NOT NULL,
      call_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      total_duration_us INTEGER DEFAULT 0,
      min_duration_us INTEGER,
      max_duration_us INTEGER,
      percentiles TEXT,
      UNIQUE(node_id, bucket)
    );
  `);
  return db;
}

function insertSpan(
  db: Database.Database,
  opts: {
    traceId?: number;
    spanId?: string;
    nodeId?: number;
    operation?: string;
    durationUs?: number;
    statusCode?: number;
    startedAt?: string;
  },
) {
  const id = opts.spanId ?? `span-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO runtime_spans (trace_id, span_id, service_name, operation, kind, started_at, duration_us, status_code, mapped_node_id, mapping_method)
    VALUES (?, ?, 'test-svc', ?, 'server', ?, ?, ?, ?, 'fqn')
  `).run(
    opts.traceId ?? 1,
    id,
    opts.operation ?? 'test.op',
    opts.startedAt ?? new Date().toISOString(),
    opts.durationUs ?? 1000,
    opts.statusCode ?? 0,
    opts.nodeId ?? 1,
  );
}

describe('RuntimeAggregator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });
  afterEach(() => {
    db.close();
  });

  it('aggregates mapped spans into buckets', () => {
    insertSpan(db, { nodeId: 10, durationUs: 100 });
    insertSpan(db, { nodeId: 10, durationUs: 200 });
    insertSpan(db, { nodeId: 10, durationUs: 300, statusCode: 2 });

    const agg = new RuntimeAggregator(db);
    const result = agg.aggregate();

    expect(result.bucketsUpdated).toBeGreaterThanOrEqual(1);
    expect(result.nodesAffected).toBeGreaterThanOrEqual(1);

    const rows = db.prepare('SELECT * FROM runtime_aggregates WHERE node_id = 10').all() as Array<{
      call_count: number;
      error_count: number;
      total_duration_us: number;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const total = rows.reduce((sum, r) => sum + r.call_count, 0);
    expect(total).toBe(3);
  });

  it('skips unmapped spans', () => {
    db.prepare(`
      INSERT INTO runtime_spans (trace_id, span_id, service_name, operation, kind, started_at, duration_us, status_code, mapped_node_id, mapping_method)
      VALUES (1, 'unmapped-1', 'svc', 'op', 'server', datetime('now'), 500, 0, NULL, NULL)
    `).run();

    const agg = new RuntimeAggregator(db);
    const result = agg.aggregate();
    expect(result.bucketsUpdated).toBe(0);
  });

  it('returns zero for empty database', () => {
    const agg = new RuntimeAggregator(db);
    const result = agg.aggregate();
    expect(result.bucketsUpdated).toBe(0);
    expect(result.nodesAffected).toBe(0);
  });
});
