/**
 * Observability bridge entry point.
 *
 * Public surface:
 *   - `createTelemetrySink(config)` — factory honoring `config.telemetry.observability`.
 *     Lazy-imports the OTLP / Langfuse sinks so opt-out users pay zero cost.
 *   - `instrumentAiCall` / `instrumentToolCall` — convenience wrappers used
 *     by `TrackedAIProvider` and the MCP tool gate.
 *   - `setGlobalTelemetrySink` / `getGlobalTelemetrySink` — process-wide
 *     singleton so wire-up sites don't need to thread the sink through.
 */
import { logger } from '../logger.js';
import { MultiSink, NoopSink, SamplingSink } from './sink.js';
import type { Attributes, Span, TelemetrySink } from './types.js';

export type { Attributes, AttributeValue, Span, TelemetrySink, SinkContext } from './types.js';
export { NoopSink, SamplingSink, MultiSink, RecordingSpan, NoopSpan } from './sink.js';

/** Shape of the `telemetry.observability` config section. Mirrors `TelemetryConfigSchema`. */
export interface ObservabilityConfig {
  enabled?: boolean;
  sink?: 'noop' | 'otlp' | 'langfuse' | 'multi';
  sampleRate?: number;
  otlp?: {
    endpoint?: string;
    headers?: Record<string, string>;
    serviceName?: string;
    /** Cap on buffered spans before oldest are dropped. Default 5000. */
    maxQueuedSpans?: number;
    /** Per-request timeout (ms). Default 10000. 0 disables. */
    requestTimeoutMs?: number;
  };
  langfuse?: {
    endpoint?: string;
    publicKey?: string;
    secretKey?: string;
    /** Cap on buffered ingestion events before oldest are dropped. Default 10000. */
    maxQueuedEvents?: number;
    /** Per-request timeout (ms). Default 10000. 0 disables. */
    requestTimeoutMs?: number;
  };
}

let globalSink: TelemetrySink = new NoopSink();

/** Replace the process-wide singleton. Pass `null` to reset to noop. */
export function setGlobalTelemetrySink(sink: TelemetrySink | null): void {
  globalSink = sink ?? new NoopSink();
}

/** Returns the current process-wide sink. Always defined. */
export function getGlobalTelemetrySink(): TelemetrySink {
  return globalSink;
}

/**
 * Build a sink from the `telemetry.observability` config section.
 * Defaults to noop. Concrete sinks are lazy-loaded.
 */
export async function createTelemetrySink(
  cfg: ObservabilityConfig | undefined,
): Promise<TelemetrySink> {
  if (!cfg || cfg.enabled === false || !cfg.enabled) {
    return new NoopSink();
  }
  const requested = cfg.sink ?? 'noop';
  if (requested === 'noop') return new NoopSink();

  const sinks: TelemetrySink[] = [];

  if (requested === 'otlp' || requested === 'multi') {
    const otlpEndpoint = cfg.otlp?.endpoint ?? 'http://localhost:4318/v1/traces';
    try {
      const mod = await import('./otlp.js');
      sinks.push(
        new mod.OtlpSink({
          endpoint: otlpEndpoint,
          headers: cfg.otlp?.headers,
          serviceName: cfg.otlp?.serviceName ?? 'trace-mcp',
          maxQueuedSpans: cfg.otlp?.maxQueuedSpans,
          requestTimeoutMs: cfg.otlp?.requestTimeoutMs,
          onError: (e) => logger.warn({ err: e }, 'telemetry.otlp_export_failed'),
        }),
      );
    } catch (err) {
      logger.warn({ err }, 'telemetry.otlp_init_failed');
    }
  }

  if (requested === 'langfuse' || requested === 'multi') {
    const { endpoint, publicKey, secretKey } = cfg.langfuse ?? {};
    if (publicKey && secretKey) {
      try {
        const mod = await import('./langfuse.js');
        sinks.push(
          new mod.LangfuseSink({
            endpoint: endpoint ?? 'https://cloud.langfuse.com',
            publicKey,
            secretKey,
            maxQueuedEvents: cfg.langfuse?.maxQueuedEvents,
            requestTimeoutMs: cfg.langfuse?.requestTimeoutMs,
            onError: (e) => logger.warn({ err: e }, 'telemetry.langfuse_export_failed'),
          }),
        );
      } catch (err) {
        logger.warn({ err }, 'telemetry.langfuse_init_failed');
      }
    } else {
      logger.warn('telemetry.langfuse_missing_credentials');
    }
  }

  let combined: TelemetrySink;
  if (sinks.length === 0) combined = new NoopSink();
  else if (sinks.length === 1) combined = sinks[0]!;
  else combined = new MultiSink(sinks);

  if (typeof cfg.sampleRate === 'number' && cfg.sampleRate < 1) {
    combined = new SamplingSink(combined, cfg.sampleRate);
  }
  return combined;
}

/**
 * Time an async operation as a span. Records duration_ms, attaches any extra
 * attributes, and converts thrown errors into `span.recordError`. The error
 * is rethrown so callers see normal control flow.
 */
export async function instrumentAsync<T>(
  sink: TelemetrySink,
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = sink.startSpan(name, attributes);
  const t0 = Date.now();
  try {
    const result = await fn(span);
    span.setAttribute('duration_ms', Date.now() - t0);
    span.end();
    return result;
  } catch (err) {
    span.setAttribute('duration_ms', Date.now() - t0);
    span.recordError(err);
    span.end();
    throw err;
  }
}

/** Convenience for AI provider calls. Adds standard `ai.*` attributes. */
export async function instrumentAiCall<T>(
  sink: TelemetrySink,
  method: 'embed' | 'embed_batch' | 'generate' | 'generate_stream',
  attrs: { provider: string; model: string; url?: string; inputSize: number },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return instrumentAsync(
    sink,
    `ai.${method}`,
    {
      'ai.method': method,
      'ai.provider': attrs.provider,
      'ai.model': attrs.model,
      'ai.url': attrs.url,
      'ai.input_size': attrs.inputSize,
    },
    fn,
  );
}

/** Convenience for MCP tool execution. Adds standard `tool.*` attributes. */
export async function instrumentToolCall<T>(
  sink: TelemetrySink,
  toolName: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return instrumentAsync(sink, `tool.${toolName}`, { 'tool.name': toolName }, fn);
}
