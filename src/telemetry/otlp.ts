/**
 * OTLP/HTTP JSON exporter (no @opentelemetry/* dependency).
 *
 * Why no SDK? Pulling @opentelemetry/sdk-node into the runtime adds ~3 MB
 * and a Node startup hit. The OTLP/HTTP wire format is stable and small,
 * so we serialise spans directly and POST to `/v1/traces`. Sinks that
 * require richer semantics can layer on top of this without touching the
 * core.
 *
 * Spec: https://opentelemetry.io/docs/specs/otlp/#otlphttp
 * JSON encoding: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
 */
import { randomBytes } from 'node:crypto';
import { RecordingSpan } from './sink.js';
import type { Attributes, AttributeValue, Span, TelemetrySink } from './types.js';

export interface OtlpSinkOptions {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  /** Flush buffered spans when this many are pending. Default 50. */
  maxBatchSize?: number;
  /** Auto-flush every N ms regardless of buffer size. Default 5000. */
  flushIntervalMs?: number;
  /** Override the fetch implementation (test seam). */
  fetchImpl?: typeof fetch;
  /** Surface export failures. Default: swallow silently. */
  onError?: (err: unknown) => void;
  /** Override current-time clock for deterministic tests. */
  nowMs?: () => number;
}

interface PendingSpan {
  span: RecordingSpan;
  traceIdHex: string;
  spanIdHex: string;
}

/**
 * Emits spans to an OTLP/HTTP JSON endpoint (default
 * http://localhost:4318/v1/traces). Buffers in memory and flushes either
 * when `maxBatchSize` is reached, after `flushIntervalMs`, or on explicit
 * flush/shutdown.
 */
export class OtlpSink implements TelemetrySink {
  readonly name = 'otlp';
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly serviceName: string;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (err: unknown) => void;
  private readonly nowMs: () => number;
  private readonly buffer: PendingSpan[] = [];
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(opts: OtlpSinkOptions) {
    this.endpoint = opts.endpoint;
    this.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    this.serviceName = opts.serviceName ?? 'trace-mcp';
    this.maxBatchSize = Math.max(1, opts.maxBatchSize ?? 50);
    this.flushIntervalMs = Math.max(0, opts.flushIntervalMs ?? 5000);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.onError = opts.onError ?? (() => {});
    this.nowMs = opts.nowMs ?? Date.now;
    if (this.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush().catch((e) => this.onError(e));
      }, this.flushIntervalMs);
      // Don't keep the process alive just to flush an empty buffer.
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  startSpan(name: string, attributes?: Attributes): Span {
    if (this.stopped) {
      // Return a no-op span if we've already shut down.
      return new RecordingSpan(name, attributes, () => {});
    }
    return new RecordingSpan(name, attributes, (s) => this.enqueue(s));
  }

  emit(eventName: string, attributes?: Attributes): void {
    // One-shot events are modelled as zero-duration spans on the same trace
    // surface — exporters render them identically.
    const span = this.startSpan(eventName, attributes);
    span.setAttribute('telemetry.event', true);
    span.end();
  }

  private enqueue(span: RecordingSpan): void {
    this.buffer.push({
      span,
      traceIdHex: hex(16),
      spanIdHex: hex(8),
    });
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush().catch((e) => this.onError(e));
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    const payload = this.encode(batch);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.onError(new Error(`OTLP export failed: HTTP ${res.status}`));
      }
    } catch (err) {
      this.onError(err);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  /** Internal — exposed for tests so we can assert payload shape without HTTP. */
  encode(batch: PendingSpan[]): unknown {
    const spans = batch.map(({ span, traceIdHex, spanIdHex }) => ({
      traceId: traceIdHex,
      spanId: spanIdHex,
      name: span.name,
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano: msToNano(span.startTimeMs),
      endTimeUnixNano: msToNano(span.endTimeMs ?? this.nowMs()),
      attributes: toOtlpKv(span.attributes),
      events: span.events.map((e) => ({
        timeUnixNano: msToNano(e.timeMs),
        name: e.name,
        attributes: toOtlpKv(e.attributes ?? {}),
      })),
      status: {
        code: span.status.code === 'error' ? 2 : 1, // STATUS_CODE_ERROR / STATUS_CODE_OK
        ...(span.status.message ? { message: span.status.message } : {}),
      },
    }));

    return {
      resourceSpans: [
        {
          resource: {
            attributes: toOtlpKv({ 'service.name': this.serviceName }),
          },
          scopeSpans: [
            {
              scope: { name: 'trace-mcp', version: '1' },
              spans,
            },
          ],
        },
      ],
    };
  }
}

function msToNano(ms: number): string {
  // OTLP encodes timestamps as Unix-nano strings to avoid 2^53 precision loss.
  return (BigInt(Math.floor(ms)) * 1_000_000n).toString();
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function toOtlpKv(attrs: Attributes): Array<{ key: string; value: unknown }> {
  const out: Array<{ key: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(attrs)) {
    const encoded = encodeAttr(value);
    if (encoded !== undefined) out.push({ key, value: encoded });
  }
  return out;
}

function encodeAttr(v: AttributeValue): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return {
      arrayValue: {
        values: v
          .map((x) => encodeAttr(x as AttributeValue))
          .filter((x): x is NonNullable<typeof x> => x !== undefined),
      },
    };
  }
  return undefined;
}
