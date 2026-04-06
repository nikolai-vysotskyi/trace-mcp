/**
 * Span Ingester — processes OTLP export requests into SQLite.
 * Stores traces, spans, discovers services.
 */

import type Database from 'better-sqlite3';
import { logger } from '../logger.js';
import {
  type OtlpExportRequest,
  type IngestResult,
  getServiceName,
  getStringAttr,
  nanoToIso,
  nanoDurationUs,
  SPAN_KIND_MAP,
} from './types.js';

interface IngestCounters {
  traces: number;
  spans: number;
  services: number;
}

export class SpanIngester {
  private batchCount = 0;
  private insertTrace: Database.Statement;
  private getTrace: Database.Statement;
  private insertSpan: Database.Statement;
  private upsertService: Database.Statement;

  private pruneSpans: Database.Statement;
  private pruneAggs: Database.Statement;
  private pruneOrphanTraces: Database.Statement;

  constructor(
    private db: Database.Database,
    private pruneInterval: number = 100,
  ) {
    this.insertTrace = db.prepare(`
      INSERT OR IGNORE INTO runtime_traces (trace_id, root_service, root_operation, started_at, duration_us, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.getTrace = db.prepare('SELECT id FROM runtime_traces WHERE trace_id = ?');

    this.insertSpan = db.prepare(`
      INSERT OR IGNORE INTO runtime_spans
        (trace_id, span_id, parent_span_id, service_name, operation, kind, started_at, duration_us, status_code, status_message, attributes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.upsertService = db.prepare(`
      INSERT INTO runtime_services (name, kind, first_seen_at, last_seen_at, metadata)
      VALUES (?, ?, datetime('now'), datetime('now'), ?)
      ON CONFLICT(name) DO UPDATE SET last_seen_at = datetime('now')
    `);

    this.pruneSpans = db.prepare('DELETE FROM runtime_spans WHERE started_at < ?');
    this.pruneAggs = db.prepare('DELETE FROM runtime_aggregates WHERE bucket < ?');
    this.pruneOrphanTraces = db.prepare(
      'DELETE FROM runtime_traces WHERE id NOT IN (SELECT DISTINCT trace_id FROM runtime_spans)',
    );
  }

  ingest(request: OtlpExportRequest): IngestResult {
    const counters: IngestCounters = { traces: 0, spans: 0, services: 0 };

    this.db.transaction(() => {
      for (const rs of request.resourceSpans) {
        const resourceAttrs = rs.resource?.attributes ?? [];
        const serviceName = getServiceName(resourceAttrs);
        this.discoverService(serviceName, resourceAttrs, counters);

        for (const ss of rs.scopeSpans) {
          for (const span of ss.spans) {
            this.processSpan(span, serviceName, counters);
          }
        }
      }
    })();

    this.batchCount++;
    if (this.pruneInterval > 0 && this.batchCount % this.pruneInterval === 0) {
      this.prune(7, 90);
    }

    logger.debug(counters, 'Ingested OTLP batch');
    return counters;
  }

  private discoverService(
    serviceName: string,
    attrs: Array<{ key: string; value: { stringValue?: string } }>,
    counters: IngestCounters,
  ): void {
    const serviceKind = this.detectServiceKind(attrs);
    this.upsertService.run(serviceName, serviceKind, null);
    counters.services++;
  }

  private processSpan(
    span: { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; startTimeUnixNano: string; endTimeUnixNano: string; status?: { code?: number; message?: string }; attributes?: unknown[] },
    serviceName: string,
    counters: IngestCounters,
  ): void {
    const startedAt = nanoToIso(span.startTimeUnixNano);
    const durationUs = nanoDurationUs(span.startTimeUnixNano, span.endTimeUnixNano);
    const statusCode = span.status?.code ?? 0;
    const kind = SPAN_KIND_MAP[span.kind] ?? 'unspecified';

    const traceRowId = this.ensureTrace(span, serviceName, startedAt, durationUs, statusCode, counters);

    this.insertSpan.run(
      traceRowId,
      span.spanId,
      span.parentSpanId ?? null,
      serviceName,
      span.name,
      kind,
      startedAt,
      durationUs,
      statusCode,
      span.status?.message ?? null,
      span.attributes ? JSON.stringify(span.attributes) : null,
    );
    counters.spans++;
  }

  private ensureTrace(
    span: { traceId: string; parentSpanId?: string; name: string },
    serviceName: string,
    startedAt: string,
    durationUs: number,
    statusCode: number,
    counters: IngestCounters,
  ): number {
    const existing = this.getTrace.get(span.traceId) as { id: number } | undefined;
    if (existing) return existing.id;

    const isRoot = !span.parentSpanId;
    this.insertTrace.run(
      span.traceId,
      isRoot ? serviceName : null,
      isRoot ? span.name : null,
      startedAt,
      durationUs,
      statusCode === 2 ? 'error' : 'ok',
    );
    counters.traces++;
    return (this.getTrace.get(span.traceId) as { id: number }).id;
  }

  /** Prune old data per retention policy */
  prune(maxSpanAgeDays: number, maxAggregateAgeDays: number): { spans: number; aggregates: number; traces: number } {
    const spanCutoff = new Date(Date.now() - maxSpanAgeDays * 86_400_000).toISOString();
    const aggCutoff = new Date(Date.now() - maxAggregateAgeDays * 86_400_000).toISOString();

    const spansDeleted = this.pruneSpans.run(spanCutoff).changes;
    const aggsDeleted = this.pruneAggs.run(aggCutoff).changes;
    const tracesDeleted = this.pruneOrphanTraces.run().changes;

    if (spansDeleted > 0 || tracesDeleted > 0) {
      logger.info({ spansDeleted, aggsDeleted, tracesDeleted }, 'Runtime data pruned');
    }

    return { spans: spansDeleted, aggregates: aggsDeleted, traces: tracesDeleted };
  }

  private detectServiceKind(attrs: Array<{ key: string; value: { stringValue?: string } }>): string {
    const dbSystem = getStringAttr(attrs, 'db.system');
    if (dbSystem) return 'database';

    const rpcSystem = getStringAttr(attrs, 'rpc.system');
    if (rpcSystem === 'grpc') return 'grpc';

    const messagingSystem = getStringAttr(attrs, 'messaging.system');
    if (messagingSystem) return 'queue';

    return 'internal';
  }
}
