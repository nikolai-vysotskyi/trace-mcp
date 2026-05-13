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
  /** Override fetch (test seam). */
  fetchImpl?: typeof fetch;
  /** Surface export failures. Default: swallow silently. */
  onError?: (err: unknown) => void;
}

interface IngestionEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

/** Posts spans to Langfuse Cloud or a self-hosted Langfuse server. */
export class LangfuseSink implements TelemetrySink {
  readonly name = 'langfuse';
  private readonly endpoint: string;
  private readonly authHeader: string;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (err: unknown) => void;
  private readonly buffer: IngestionEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(opts: LangfuseSinkOptions) {
    // Allow either bare host or full /api/public/ingestion URL.
    const trimmed = opts.endpoint.replace(/\/$/, '');
    this.endpoint = trimmed.endsWith('/ingestion') ? trimmed : `${trimmed}/api/public/ingestion`;
    const creds = Buffer.from(`${opts.publicKey}:${opts.secretKey}`).toString('base64');
    this.authHeader = `Basic ${creds}`;
    this.maxBatchSize = Math.max(1, opts.maxBatchSize ?? 50);
    this.flushIntervalMs = Math.max(0, opts.flushIntervalMs ?? 5000);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.onError = opts.onError ?? (() => {});
    if (this.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush().catch((e) => this.onError(e));
      }, this.flushIntervalMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
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
    this.maybeFlush();
  }

  private maybeFlush(): void {
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush().catch((e) => this.onError(e));
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.authHeader,
        },
        body: JSON.stringify({ batch }),
      });
      // Langfuse returns 207 on partial success; both 2xx codes are fine.
      if (!res.ok && res.status !== 207) {
        this.onError(new Error(`Langfuse export failed: HTTP ${res.status}`));
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
}

function serializeAttrs(attrs: Attributes): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}
