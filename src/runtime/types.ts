/**
 * Minimal OTLP JSON types for trace ingestion.
 * Only the fields we actually parse — keeps the codebase light.
 */

// ════════════════════════════════════════════════════════════════════════
// OTLP JSON WIRE FORMAT (subset)
// ════════════════════════════════════════════════════════════════════════

export interface OtlpExportRequest {
  resourceSpans: ResourceSpans[];
}

interface ResourceSpans {
  resource: { attributes: KeyValue[] };
  scopeSpans: ScopeSpans[];
}

interface ScopeSpans {
  scope?: { name: string; version?: string };
  spans: OtlpSpan[];
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number; // SpanKind: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: KeyValue[];
  status?: { code?: number; message?: string };
}

interface KeyValue {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    boolValue?: boolean;
    doubleValue?: number;
  };
}

// ════════════════════════════════════════════════════════════════════════
// INTERNAL TYPES
// ════════════════════════════════════════════════════════════════════════

export const SPAN_KIND_MAP: Record<number, string> = {
  0: 'unspecified',
  1: 'internal',
  2: 'server',
  3: 'client',
  4: 'producer',
  5: 'consumer',
};

export interface RuntimeSpanRow {
  id: number;
  trace_id: number;
  span_id: string;
  parent_span_id: string | null;
  service_name: string;
  operation: string;
  kind: string;
  started_at: string;
  duration_us: number;
  status_code: number;
  status_message: string | null;
  attributes: string | null;
  mapped_node_id: number | null;
  mapping_method: string | null;
}

export interface IngestResult {
  traces: number;
  spans: number;
  services: number;
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

/** Extract a string attribute value from KeyValue array */
export function getStringAttr(attrs: KeyValue[] | undefined, key: string): string | undefined {
  if (!attrs) return undefined;
  const kv = attrs.find((a) => a.key === key);
  return kv?.value.stringValue;
}

/** Extract service.name from resource attributes */
export function getServiceName(attrs: KeyValue[]): string {
  return getStringAttr(attrs, 'service.name') ?? 'unknown';
}

/** Convert nanosecond unix timestamp to ISO 8601 string */
export function nanoToIso(nanos: string): string {
  try {
    const ms = BigInt(nanos) / 1_000_000n;
    return new Date(Number(ms)).toISOString();
  } catch {
    return new Date().toISOString(); // fallback for malformed input
  }
}

/** Compute duration in microseconds from start/end nanoseconds */
export function nanoDurationUs(startNano: string, endNano: string): number {
  try {
    const us = (BigInt(endNano) - BigInt(startNano)) / 1_000n;
    return Number(us);
  } catch {
    return 0;
  }
}
