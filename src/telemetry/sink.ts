/**
 * Sink core: `NoopSink` (default, zero overhead) plus the `MultiSink`
 * fan-out wrapper and helpers used by every concrete sink.
 *
 * Concrete sinks (`OtlpSink`, `LangfuseSink`) are implemented in sibling
 * files and lazy-loaded by the factory in `index.ts` so users that never
 * opt in pay zero startup cost.
 */
import { randomUUID } from 'node:crypto';
import type { Attributes, AttributeValue, Span, TelemetrySink } from './types.js';

/** A span that records nothing and ends instantly. The shared default. */
export class NoopSpan implements Span {
  readonly id: string;
  readonly name: string;
  constructor(name: string) {
    this.id = '';
    this.name = name;
  }
  setAttribute(_key: string, _value: AttributeValue): void {}
  setAttributes(_attrs: Attributes): void {}
  recordError(_err: unknown): void {}
  setStatus(_code: 'ok' | 'error', _message?: string): void {}
  end(_endTimeMs?: number): void {}
}

/** The default sink. Selected when `telemetry.observability.sink` is "noop" or unset. */
export class NoopSink implements TelemetrySink {
  readonly name = 'noop';
  private static readonly _span = new NoopSpan('noop');
  startSpan(name: string, _attributes?: Attributes): Span {
    // Reuse a single instance — the noop span has no per-call state.
    void name;
    return NoopSink._span;
  }
  emit(_eventName: string, _attributes?: Attributes): void {}
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/** Sampling wrapper. `sampleRate` in [0,1]: 0 drops everything, 1 keeps everything. */
export class SamplingSink implements TelemetrySink {
  readonly name: string;
  constructor(
    private readonly inner: TelemetrySink,
    private readonly sampleRate: number,
  ) {
    this.name = `sampled(${inner.name})`;
  }
  private keep(): boolean {
    if (this.sampleRate >= 1) return true;
    if (this.sampleRate <= 0) return false;
    return Math.random() < this.sampleRate;
  }
  startSpan(name: string, attributes?: Attributes): Span {
    if (!this.keep()) return new NoopSpan(name);
    return this.inner.startSpan(name, attributes);
  }
  emit(eventName: string, attributes?: Attributes): void {
    if (!this.keep()) return;
    this.inner.emit(eventName, attributes);
  }
  flush(): Promise<void> {
    return this.inner.flush();
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** Fan-out wrapper. Spans appear on every wrapped sink. */
export class MultiSink implements TelemetrySink {
  readonly name: string;
  constructor(private readonly sinks: TelemetrySink[]) {
    this.name = `multi(${sinks.map((s) => s.name).join(',')})`;
  }
  startSpan(name: string, attributes?: Attributes): Span {
    const spans = this.sinks.map((s) => s.startSpan(name, attributes));
    return new MultiSpan(name, spans);
  }
  emit(eventName: string, attributes?: Attributes): void {
    for (const s of this.sinks) s.emit(eventName, attributes);
  }
  async flush(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.flush()));
  }
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.shutdown()));
  }
}

class MultiSpan implements Span {
  readonly id: string;
  readonly name: string;
  constructor(
    name: string,
    private readonly spans: Span[],
  ) {
    this.id = spans[0]?.id ?? '';
    this.name = name;
  }
  setAttribute(key: string, value: AttributeValue): void {
    for (const s of this.spans) s.setAttribute(key, value);
  }
  setAttributes(attrs: Attributes): void {
    for (const s of this.spans) s.setAttributes(attrs);
  }
  recordError(err: unknown): void {
    for (const s of this.spans) s.recordError(err);
  }
  setStatus(code: 'ok' | 'error', message?: string): void {
    for (const s of this.spans) s.setStatus(code, message);
  }
  end(endTimeMs?: number): void {
    for (const s of this.spans) s.end(endTimeMs);
  }
}

/**
 * Maximum events retained on a single `RecordingSpan`. Long-lived spans that
 * accumulate errors (e.g. a streaming generate that retries) would otherwise
 * grow without bound. Drop oldest on overflow.
 */
export const MAX_SPAN_EVENTS = 100;

/**
 * Common in-memory span used by HTTP-based sinks. Tracks start/end time,
 * attributes, events, and status. Calls `onEnd` exactly once when the
 * span is finalised so the sink can enqueue it for export.
 */
export class RecordingSpan implements Span {
  readonly id: string;
  readonly name: string;
  readonly startTimeMs: number;
  endTimeMs?: number;
  readonly attributes: Attributes = {};
  readonly events: Array<{ name: string; timeMs: number; attributes?: Attributes }> = [];
  status: { code: 'ok' | 'error'; message?: string } = { code: 'ok' };
  /** Total events dropped from this span due to the per-span cap. */
  droppedEvents = 0;
  private ended = false;
  private dropWarned = false;
  private readonly maxEvents: number;
  private readonly onDrop: ((span: RecordingSpan, droppedCount: number) => void) | undefined;

  constructor(
    name: string,
    initialAttrs: Attributes | undefined,
    private readonly onEnd: (span: RecordingSpan) => void,
    opts?: {
      maxEvents?: number;
      onDrop?: (span: RecordingSpan, droppedCount: number) => void;
    },
  ) {
    this.id = randomUUID();
    this.name = name;
    this.startTimeMs = Date.now();
    this.maxEvents = Math.max(1, opts?.maxEvents ?? MAX_SPAN_EVENTS);
    this.onDrop = opts?.onDrop;
    if (initialAttrs) this.setAttributes(initialAttrs);
  }

  setAttribute(key: string, value: AttributeValue): void {
    if (this.ended) return;
    this.attributes[key] = value;
  }
  setAttributes(attrs: Attributes): void {
    if (this.ended) return;
    for (const [k, v] of Object.entries(attrs)) this.attributes[k] = v;
  }
  /** Append an event, dropping the oldest entry once the per-span cap is hit. */
  private pushEvent(event: { name: string; timeMs: number; attributes?: Attributes }): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      const overflow = this.events.length - this.maxEvents;
      this.events.splice(0, overflow);
      this.droppedEvents += overflow;
      if (!this.dropWarned) {
        this.dropWarned = true;
        if (this.onDrop) this.onDrop(this, overflow);
      }
    }
  }
  recordError(err: unknown): void {
    if (this.ended) return;
    const message = err instanceof Error ? err.message : String(err);
    const type = err instanceof Error ? err.name : 'Error';
    const stack = err instanceof Error && err.stack ? err.stack : undefined;
    this.pushEvent({
      name: 'exception',
      timeMs: Date.now(),
      attributes: {
        'exception.type': type,
        'exception.message': message,
        ...(stack ? { 'exception.stacktrace': stack } : {}),
      },
    });
    this.status = { code: 'error', message };
  }
  setStatus(code: 'ok' | 'error', message?: string): void {
    if (this.ended) return;
    this.status = { code, message };
  }
  end(endTimeMs?: number): void {
    if (this.ended) return;
    this.ended = true;
    this.endTimeMs = endTimeMs ?? Date.now();
    this.onEnd(this);
  }
}
