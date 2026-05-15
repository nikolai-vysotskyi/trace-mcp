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
  /**
   * Maximum number of buffered spans before the oldest are dropped. Bounds
   * memory growth when the export endpoint is unreachable or slow. Default 5000.
   */
  maxQueuedSpans?: number;
  /**
   * Per-request timeout in milliseconds. Wraps `fetchImpl` with an
   * AbortController so a hung server can't pin memory forever. Default 10000.
   * Set to 0 to disable.
   */
  requestTimeoutMs?: number;
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
 * Error sentinel emitted when the queue cap is exceeded and oldest spans are
 * dropped. The `dropped` flag lets `onError` consumers rate-limit warnings.
 */
export class OtlpQueueOverflowError extends Error {
  readonly dropped = true;
  constructor(
    readonly droppedCount: number,
    readonly queueCap: number,
  ) {
    super(`OTLP queue overflow: dropped ${droppedCount} oldest span(s) (cap=${queueCap})`);
    this.name = 'OtlpQueueOverflowError';
  }
}

/**
 * Emits spans to an OTLP/HTTP JSON endpoint (default
 * http://localhost:4318/v1/traces). Buffers in memory and flushes either
 * when `maxBatchSize` is reached, after `flushIntervalMs`, or on explicit
 * flush/shutdown.
 */
/** Minimum gap between back-to-back queue-overflow warnings, in ms. */
const DROP_WARN_INTERVAL_MS = 60_000;

export class OtlpSink implements TelemetrySink {
  readonly name = 'otlp';
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly serviceName: string;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueuedSpans: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (err: unknown) => void;
  private readonly nowMs: () => number;
  private readonly buffer: PendingSpan[] = [];
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private flushing = false;
  private inflight: Promise<void> | undefined;
  private droppedSinceLastWarn = 0;
  // Negative-infinity sentinel: first overflow always emits a warning, then
  // subsequent ones are coalesced within DROP_WARN_INTERVAL_MS.
  private lastDropWarnMs = Number.NEGATIVE_INFINITY;

  constructor(opts: OtlpSinkOptions) {
    this.endpoint = opts.endpoint;
    this.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    this.serviceName = opts.serviceName ?? 'trace-mcp';
    this.maxBatchSize = Math.max(1, opts.maxBatchSize ?? 50);
    this.flushIntervalMs = Math.max(0, opts.flushIntervalMs ?? 5000);
    this.maxQueuedSpans = Math.max(1, opts.maxQueuedSpans ?? 5000);
    this.requestTimeoutMs = Math.max(0, opts.requestTimeoutMs ?? 10_000);
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

  /** Current buffered-span count. Exposed for diagnostics + tests. */
  getBufferSize(): number {
    return this.buffer.length;
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
    if (this.buffer.length > this.maxQueuedSpans) {
      const overflow = this.buffer.length - this.maxQueuedSpans;
      this.buffer.splice(0, overflow);
      this.recordDrops(overflow);
    }
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush().catch((e) => this.onError(e));
    }
  }

  /** Rate-limited overflow warning. Coalesces drops within DROP_WARN_INTERVAL_MS. */
  private recordDrops(count: number): void {
    this.droppedSinceLastWarn += count;
    const now = this.nowMs();
    if (now - this.lastDropWarnMs >= DROP_WARN_INTERVAL_MS) {
      this.lastDropWarnMs = now;
      const total = this.droppedSinceLastWarn;
      this.droppedSinceLastWarn = 0;
      this.onError(new OtlpQueueOverflowError(total, this.maxQueuedSpans));
    }
  }

  async flush(): Promise<void> {
    // In-flight guard: a single fetch is allowed at a time. Concurrent callers
    // (timer + overflow trigger) get the already-running flush so they can
    // still await completion without double-firing a fetch.
    if (this.flushing && this.inflight) return this.inflight;
    if (this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    const payload = this.encode(batch);
    const controller = this.requestTimeoutMs > 0 ? new AbortController() : undefined;
    const timer =
      this.requestTimeoutMs > 0 && controller
        ? setTimeout(() => controller.abort(), this.requestTimeoutMs)
        : undefined;
    if (timer && typeof timer.unref === 'function') timer.unref();
    const run = (async () => {
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(payload),
          signal: controller?.signal,
        });
        if (!res.ok) {
          this.onError(new Error(`OTLP export failed: HTTP ${res.status}`));
        }
      } catch (err) {
        this.onError(err);
      } finally {
        if (timer) clearTimeout(timer);
        this.flushing = false;
        this.inflight = undefined;
      }
    })();
    this.inflight = run;
    return run;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Drain any in-flight fetch first so a follow-up flush() sees the buffer
    // that arrived after the in-flight batch was already spliced out.
    if (this.inflight) {
      await this.inflight.catch(() => {});
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
