import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SpanIngester } from '../../src/runtime/ingest.js';
import type { OtlpExportRequest } from '../../src/runtime/types.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE runtime_traces (
      id INTEGER PRIMARY KEY,
      trace_id TEXT UNIQUE NOT NULL,
      root_service TEXT,
      root_operation TEXT,
      started_at TEXT,
      duration_us INTEGER,
      status TEXT
    );
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
      attributes TEXT
    );
    CREATE TABLE runtime_services (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      kind TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      metadata TEXT
    );
    CREATE TABLE runtime_aggregates (
      id INTEGER PRIMARY KEY,
      bucket TEXT NOT NULL,
      service_name TEXT,
      operation TEXT,
      count INTEGER,
      total_duration_us INTEGER
    );
  `);
  return db;
}

function makeRequest(overrides?: Partial<{
  traceId: string;
  spanId: string;
  parentSpanId: string;
  serviceName: string;
  spanName: string;
  kind: number;
  statusCode: number;
}>): OtlpExportRequest {
  const o = overrides ?? {};
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: o.serviceName ?? 'test-service' } },
        ],
      },
      scopeSpans: [{
        scope: {},
        spans: [{
          traceId: o.traceId ?? 'trace-001',
          spanId: o.spanId ?? 'span-001',
          parentSpanId: o.parentSpanId,
          name: o.spanName ?? 'GET /api/test',
          kind: o.kind ?? 2, // SERVER
          startTimeUnixNano: '1700000000000000000',
          endTimeUnixNano: '1700000000500000000',
          status: { code: o.statusCode ?? 0 },
          attributes: [{ key: 'http.method', value: { stringValue: 'GET' } }],
        }],
      }],
    }],
  };
}

describe('SpanIngester', () => {
  let db: Database.Database;
  let ingester: SpanIngester;

  beforeEach(() => {
    db = createDb();
    ingester = new SpanIngester(db, 0); // disable auto-prune
  });

  afterEach(() => {
    db.close();
  });

  it('ingests a single span and creates trace + service', () => {
    const result = ingester.ingest(makeRequest());

    expect(result.traces).toBe(1);
    expect(result.spans).toBe(1);
    expect(result.services).toBe(1);

    const traces = db.prepare('SELECT * FROM runtime_traces').all() as { trace_id: string; root_service: string; status: string }[];
    expect(traces).toHaveLength(1);
    expect(traces[0].trace_id).toBe('trace-001');
    expect(traces[0].root_service).toBe('test-service');
    expect(traces[0].status).toBe('ok');

    const spans = db.prepare('SELECT * FROM runtime_spans').all() as { span_id: string; kind: string; operation: string }[];
    expect(spans).toHaveLength(1);
    expect(spans[0].span_id).toBe('span-001');
    expect(spans[0].kind).toBe('server');
    expect(spans[0].operation).toBe('GET /api/test');
  });

  it('does not duplicate traces on second ingest of same traceId', () => {
    ingester.ingest(makeRequest({ traceId: 'trace-001', spanId: 'span-001' }));
    ingester.ingest(makeRequest({ traceId: 'trace-001', spanId: 'span-002', parentSpanId: 'span-001' }));

    const traces = db.prepare('SELECT * FROM runtime_traces').all();
    expect(traces).toHaveLength(1);

    const spans = db.prepare('SELECT * FROM runtime_spans').all();
    expect(spans).toHaveLength(2);
  });

  it('marks error status on spans with status code 2', () => {
    ingester.ingest(makeRequest({ statusCode: 2 }));

    const trace = db.prepare('SELECT status FROM runtime_traces').get() as { status: string };
    expect(trace.status).toBe('error');
  });

  it('sets root_service/root_operation only for root spans', () => {
    ingester.ingest(makeRequest({
      traceId: 'trace-002',
      spanId: 'child-span',
      parentSpanId: 'parent-span',
      spanName: 'child op',
    }));

    const trace = db.prepare('SELECT root_service, root_operation FROM runtime_traces').get() as {
      root_service: string | null;
      root_operation: string | null;
    };
    expect(trace.root_service).toBeNull();
    expect(trace.root_operation).toBeNull();
  });

  it('discovers service with correct kind based on attributes', () => {
    // Database service
    ingester.ingest({
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'pg-db' } },
            { key: 'db.system', value: { stringValue: 'postgresql' } },
          ],
        },
        scopeSpans: [{
          scope: {},
          spans: [{
            traceId: 'trace-db',
            spanId: 'span-db',
            name: 'SELECT',
            kind: 3,
            startTimeUnixNano: '1700000000000000000',
            endTimeUnixNano: '1700000000100000000',
            status: {},
          }],
        }],
      }],
    });

    const service = db.prepare("SELECT kind FROM runtime_services WHERE name = 'pg-db'").get() as { kind: string };
    expect(service.kind).toBe('database');
  });

  it('stores span attributes as JSON', () => {
    ingester.ingest(makeRequest());

    const span = db.prepare('SELECT attributes FROM runtime_spans').get() as { attributes: string };
    const attrs = JSON.parse(span.attributes);
    expect(attrs).toEqual([{ key: 'http.method', value: { stringValue: 'GET' } }]);
  });

  it('prune() removes old data', () => {
    ingester.ingest(makeRequest());

    // Manually backdate the span
    db.prepare("UPDATE runtime_spans SET started_at = '2020-01-01T00:00:00Z'").run();

    const pruned = ingester.prune(1, 1); // 1 day retention
    expect(pruned.spans).toBe(1);
    expect(pruned.traces).toBe(1); // orphan trace cleaned
  });

  it('handles multiple resource spans in one request', () => {
    const request: OtlpExportRequest = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc-a' } }] },
          scopeSpans: [{
            scope: {},
            spans: [{
              traceId: 'trace-multi',
              spanId: 'span-a',
              name: 'op-a',
              kind: 2,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000000100000000',
              status: {},
            }],
          }],
        },
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc-b' } }] },
          scopeSpans: [{
            scope: {},
            spans: [{
              traceId: 'trace-multi',
              spanId: 'span-b',
              parentSpanId: 'span-a',
              name: 'op-b',
              kind: 3,
              startTimeUnixNano: '1700000000100000000',
              endTimeUnixNano: '1700000000200000000',
              status: {},
            }],
          }],
        },
      ],
    };

    const result = ingester.ingest(request);
    expect(result.spans).toBe(2);
    expect(result.services).toBe(2);
    expect(result.traces).toBe(1); // same trace

    const services = db.prepare('SELECT name FROM runtime_services ORDER BY name').all() as { name: string }[];
    expect(services.map((s) => s.name)).toEqual(['svc-a', 'svc-b']);
  });

  it('auto-prunes after pruneInterval batches', () => {
    const autoIngester = new SpanIngester(db, 2); // prune every 2 batches

    // Insert old data
    autoIngester.ingest(makeRequest({ traceId: 't1', spanId: 's1' }));
    db.prepare("UPDATE runtime_spans SET started_at = '2020-01-01T00:00:00Z'").run();

    // Use a recent timestamp for the second batch (current time in nanos)
    const nowNanos = String(BigInt(Date.now()) * 1_000_000n);
    const endNanos = String(BigInt(Date.now()) * 1_000_000n + 500_000_000n);
    autoIngester.ingest({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeSpans: [{
          scope: {},
          spans: [{
            traceId: 't2', spanId: 's2', name: 'op', kind: 2,
            startTimeUnixNano: nowNanos, endTimeUnixNano: endNanos, status: {},
          }],
        }],
      }],
    });

    const spans = db.prepare('SELECT * FROM runtime_spans').all();
    expect(spans).toHaveLength(1); // old one pruned, new one kept
  });
});
