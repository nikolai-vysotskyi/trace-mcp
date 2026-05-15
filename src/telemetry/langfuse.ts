/**
 * Langfuse ingestion exporter (raw fetch, no langfuse-node SDK).
 *
 * Each span is sent as a `span-create` event paired with a `span-update`
 * carrying the end time and status. We avoid the SDK because:
 *  - it pulls in node-fetch, uuid, eventsource-parser, etc. (~1.5 MB)
 *  - the public ingestion endpoint is stable and self-documenting
 *  - we already have a generic Span interface so the SDK adds nothing
 *
 * API docs: https://langfuse.com/docs/api (POST /api/public/ingestion)
 */
import { randomUUID } from 'node:crypto';
import { RecordingSpan } from './sink.js';
import type { Attributes, Span, TelemetrySink } from './types.js';

export interface LangfuseSinkOptions {
  /** Langfuse host. Cloud default: https://cloud.langfuse.com */
  endpoint: string;
  /** Public key (LF-PUBLIC-...). Sent as Basic auth username. */
  publicKey: string;
  /** Secret key (LF-SECRET-...). Sent as Basic auth password. */
  secretKey: string;
  /** Flush after this many pending events. Default 50. */
  maxBatchSize?: number;
  /** Background flush interval. Default 5000 ms. */
  flushIntervalMs?: number;
  /**
   * Maximum number of buffered ingestion events before the oldest are dropped.
   * Bounds memory growth when the export endpoint is unreachable or slow.
   * Note: each span produces two events (span-create + span-update), so the
   * effective span capacity is roughly maxQueuedEvents / 2. Default 10000.
   */
  maxQueuedEvents?: number;
  /**
   * Per-request timeout in milliseconds. Wraps `fetchImpl` with an
   * AbortController so a hung server can't pin memory forever. Default 10000.
   * Set to 0 to disable.
   */
  requestTimeoutMs?: number;
  /** Override fetch (test seam). */
  fetchImpl?: typeof fetch;
  /** Surface export failures. Default: swallow silently. */
  onError?: (err: unknown) => void;
  /** Override current-time clock for deterministic tests. */
  nowMs?: () => number;
}

interface IngestionEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

/**
 * Error sentinel emitted when the queue cap is exceeded and oldest events are
 * dropped. The `dropped` flag lets `onError` consumers rate-limit warnings.
 */
export class LangfuseQueueOverflowError extends Error {
  readonly dropped = true;
  constructor(
    readonly droppedCount: number,
    readonly queueCap: number,
  ) {
    super(`Langfuse queue overflow: dropped ${droppedCount} oldest event(s) (cap=${queueCap})`);
    this.name = 'LangfuseQueueOverflowError';
  }
}

/** Minimum gap between back-to-back queue-overflow warnings, in ms. */
const DROP_WARN_INTERVAL_MS = 60_000;

/** Posts spans to Langfuse Cloud or a self-hosted Langfuse server. */
export class LangfuseSink implements TelemetrySink {
  readonly name = 'langfuse';
  private readonly endpoint: string;
  private readonly authHeader: string;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueuedEvents: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (err: unknown) => void;
  private readonly nowMs: () => number;
  private readonly buffer: IngestionEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private flushing = false;
  private inflight: Promise<void> | undefined;
  private droppedSinceLastWarn = 0;
  // Negative-infinity sentinel: first overflow always emits a warning, then
  // subsequent ones are coalesced within DROP_WARN_INTERVAL_MS.
  private lastDropWarnMs = Number.NEGATIVE_INFINITY;

  constructor(opts: LangfuseSinkOptions) {
    // Allow either bare host or full /api/public/ingestion URL.
    const trimmed = opts.endpoint.replace(/\/$/, '');
    this.endpoint = trimmed.endsWith('/ingestion') ? trimmed : `${trimmed}/api/public/ingestion`;
    const creds = Buffer.from(`${opts.publicKey}:${opts.secretKey}`).toString('base64');
    this.authHeader = `Basic ${creds}`;
    this.maxBatchSize = Math.max(1, opts.maxBatchSize ?? 50);
    this.flushIntervalMs = Math.max(0, opts.flushIntervalMs ?? 5000);
    this.maxQueuedEvents = Math.max(2, opts.maxQueuedEvents ?? 10_000);
    this.requestTimeoutMs = Math.max(0, opts.requestTimeoutMs ?? 10_000);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.onError = opts.onError ?? (() => {});
    this.nowMs = opts.nowMs ?? Date.now;
    if (this.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush().catch((e) => this.onError(e));
      }, this.flushIntervalMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  /** Current buffered-event count. Exposed for diagnostics + tests. */
  getBufferSize(): number {
    return this.buffer.length;
  }

  startSpan(name: string, attributes?: Attributes): Span {
    if (this.stopped) {
      return new RecordingSpan(name, attributes, () => {});
    }
    return new RecordingSpan(name, attributes, (s) => this.enqueueSpan(s));
  }

  emit(eventName: string, attributes?: Attributes): void {
    if (this.stopped) return;
    this.buffer.push({
      id: randomUUID(),
      type: 'event-create',
      timestamp: new Date().toISOString(),
      body: {
        id: randomUUID(),
        name: eventName,
        metadata: serializeAttrs(attributes ?? {}),
      },
    });
    this.enforceCap();
    this.maybeFlush();
  }

  private enqueueSpan(span: RecordingSpan): void {
    const id = span.id;
    const startIso = new Date(span.startTimeMs).toISOString();
    const endIso = new Date(span.endTimeMs ?? span.startTimeMs).toISOString();
    this.buffer.push({
      id: randomUUID(),
      type: 'span-create',
      timestamp: startIso,
      body: {
        id,
        name: span.name,
        startTime: startIso,
        metadata: serializeAttrs(span.attributes),
      },
    });
    this.buffer.push({
      id: randomUUID(),
      type: 'span-update',
      timestamp: endIso,
      body: {
        id,
        endTime: endIso,
        level: span.status.code === 'error' ? 'ERROR' : 'DEFAULT',
        statusMessage: span.status.message ?? undefined,
      },
    });
    this.enforceCap();
    this.maybeFlush();
  }

  /** Drop oldest entries when the queue exceeds its cap. */
  private enforceCap(): void {
    if (this.buffer.length > this.maxQueuedEvents) {
      const overflow = this.buffer.length - this.maxQueuedEvents;
      this.buffer.splice(0, overflow);
      this.recordDrops(overflow);
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
      this.onError(new LangfuseQueueOverflowError(total, this.maxQueuedEvents));
    }
  }

  private maybeFlush(): void {
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush().catch((e) => this.onError(e));
    }
  }

  async flush(): Promise<void> {
    if (this.flushing && this.inflight) return this.inflight;
    if (this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
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
          headers: {
            'content-type': 'application/json',
            authorization: this.authHeader,
          },
          body: JSON.stringify({ batch }),
          signal: controller?.signal,
        });
        // Langfuse returns 207 on partial success; both 2xx codes are fine.
        if (!res.ok && res.status !== 207) {
          this.onError(new Error(`Langfuse export failed: HTTP ${res.status}`));
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
    if (this.inflight) {
      await this.inflight.catch(() => {});
    }
    await this.flush();
  }
}

function serializeAttrs(attrs: Attributes): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}
