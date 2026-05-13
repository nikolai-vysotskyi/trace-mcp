/**
 * Shared types for the trace-mcp observability bridge.
 *
 * The bridge is a thin abstraction over OpenTelemetry-style spans and one-shot
 * events. Implementations live in this directory:
 *   - `NoopSink` — default, zero overhead, no I/O.
 *   - `OtlpSink` — OTLP/HTTP exporter (raw fetch — no @opentelemetry/* deps).
 *   - `LangfuseSink` — Langfuse public ingestion API (raw fetch).
 *
 * Span attributes are JSON-serialisable primitives only. Errors are recorded
 * as a structured `exception` event on the span (per OTel semantic conventions).
 */

/** JSON-serialisable attribute value. Arrays must be homogeneous per OTel spec. */
export type AttributeValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | string[]
  | number[]
  | boolean[];

/** Bag of attributes attached to a span or event. */
export type Attributes = Record<string, AttributeValue>;

/**
 * A live, in-progress span. Implementations must be safe to call across
 * async boundaries and tolerate `end()` being called exactly once.
 *
 * `recordError(e)` MUST also set the span status to "error" so exporters
 * can filter failures without re-parsing attributes.
 */
export interface Span {
  /** Stable identifier (sink-specific). Useful for correlation in tests. */
  readonly id: string;
  /** Original span name. */
  readonly name: string;
  /** Set or replace a single attribute. */
  setAttribute(key: string, value: AttributeValue): void;
  /** Bulk-set attributes (last value wins on collision). */
  setAttributes(attrs: Attributes): void;
  /** Record an error/exception on the span. Marks status=error. */
  recordError(err: unknown): void;
  /** Explicit status setter. `end()` defaults to "ok" if never called. */
  setStatus(code: 'ok' | 'error', message?: string): void;
  /** Finalise the span and queue it for export. Subsequent calls are no-ops. */
  end(endTimeMs?: number): void;
}

/**
 * The pluggable export target. Multiple sinks can be composed via
 * `MultiSink` to fan out spans to several backends.
 */
export interface TelemetrySink {
  /** Stable identifier, e.g. "noop", "otlp", "langfuse". */
  readonly name: string;
  /** Start a new span. Returns immediately; never throws. */
  startSpan(name: string, attributes?: Attributes): Span;
  /** Emit a one-shot event (no start/end pair). */
  emit(eventName: string, attributes?: Attributes): void;
  /** Force-flush pending exports. Returns when buffers are drained. */
  flush(): Promise<void>;
  /** Stop accepting new work and release resources. Implies a final flush. */
  shutdown(): Promise<void>;
}

/** Errors thrown by sinks are intentionally swallowed; this helper surfaces them via logger. */
export interface SinkContext {
  /** Logger-like callback used for export errors. Off by default. */
  onError?: (err: unknown, sink: string) => void;
}
