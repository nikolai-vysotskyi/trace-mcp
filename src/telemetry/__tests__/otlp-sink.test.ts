import { describe, expect, it, vi } from 'vitest';
import { OtlpSink } from '../otlp.js';

function makeFetchSpy(): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('OtlpSink', () => {
  it('encodes a finished span into the OTLP/HTTP JSON shape', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    const sink = new OtlpSink({
      endpoint: 'http://localhost:4318/v1/traces',
      fetchImpl,
      maxBatchSize: 1, // flush on first span
      flushIntervalMs: 0, // disable timer
      serviceName: 'trace-mcp-test',
    });

    const span = sink.startSpan('ai.embed', {
      'ai.provider': 'openai',
      'ai.model': 'text-embedding-3-small',
      'ai.input_size': 42,
      'ai.temperature': 0.5,
    });
    span.setAttribute('duration_ms', 17);
    span.end();
    // Buffer should have auto-flushed on enqueue because maxBatchSize=1.
    await sink.shutdown();

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const first = calls[0]!;
    expect(first.url).toBe('http://localhost:4318/v1/traces');
    expect(first.init?.method).toBe('POST');
    const body = JSON.parse(String(first.init?.body ?? '{}')) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
        scopeSpans: Array<{
          spans: Array<{
            name: string;
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
            status: { code: number };
            startTimeUnixNano: string;
            endTimeUnixNano: string;
          }>;
        }>;
      }>;
    };
    expect(body.resourceSpans).toHaveLength(1);
    const resource = body.resourceSpans[0]!.resource.attributes;
    const serviceName = resource.find((a) => a.key === 'service.name');
    expect(serviceName?.value.stringValue).toBe('trace-mcp-test');

    const otlpSpans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(otlpSpans).toHaveLength(1);
    const s = otlpSpans[0]!;
    expect(s.name).toBe('ai.embed');
    expect(s.status.code).toBe(1); // STATUS_CODE_OK

    const attrMap = new Map(s.attributes.map((a) => [a.key, a.value]));
    expect(attrMap.get('ai.provider')).toEqual({ stringValue: 'openai' });
    expect(attrMap.get('ai.input_size')).toEqual({ intValue: '42' });
    expect(attrMap.get('ai.temperature')).toEqual({ doubleValue: 0.5 });
    expect(attrMap.get('duration_ms')).toEqual({ intValue: '17' });

    // Span timing is encoded as unix-nano strings.
    expect(s.startTimeUnixNano).toMatch(/^\d+$/);
    expect(s.endTimeUnixNano).toMatch(/^\d+$/);
    expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true);
  });

  it('records errors as exception events and marks status=error', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    const sink = new OtlpSink({
      endpoint: 'http://localhost:4318/v1/traces',
      fetchImpl,
      maxBatchSize: 1,
      flushIntervalMs: 0,
    });
    const span = sink.startSpan('ai.generate');
    span.recordError(new Error('upstream timeout'));
    span.end();
    await sink.shutdown();

    const body = JSON.parse(String(calls[0]!.init?.body ?? '{}')) as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{
            events: Array<{
              name: string;
              attributes: Array<{ key: string; value: { stringValue: string } }>;
            }>;
            status: { code: number };
          }>;
        }>;
      }>;
    };
    const s = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(s.status.code).toBe(2); // STATUS_CODE_ERROR
    const event = s.events.find((e) => e.name === 'exception');
    expect(event).toBeDefined();
    const evMap = new Map(event!.attributes.map((a) => [a.key, a.value.stringValue]));
    expect(evMap.get('exception.message')).toBe('upstream timeout');
    expect(evMap.get('exception.type')).toBe('Error');
  });

  it('span timing is accurate within a tolerance', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    const sink = new OtlpSink({
      endpoint: 'http://localhost:4318/v1/traces',
      fetchImpl,
      maxBatchSize: 1,
      flushIntervalMs: 0,
    });
    const span = sink.startSpan('ai.embed');
    await new Promise((r) => setTimeout(r, 25));
    span.end();
    await sink.shutdown();

    const body = JSON.parse(String(calls[0]!.init?.body ?? '{}')) as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{ startTimeUnixNano: string; endTimeUnixNano: string }>;
        }>;
      }>;
    };
    const s = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const durNs = BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano);
    const durMs = Number(durNs / 1_000_000n);
    expect(durMs).toBeGreaterThanOrEqual(20);
    expect(durMs).toBeLessThan(500);
  });

  it('emit() produces a zero-duration span flagged as an event', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    const sink = new OtlpSink({
      endpoint: 'http://localhost:4318/v1/traces',
      fetchImpl,
      maxBatchSize: 1,
      flushIntervalMs: 0,
    });
    sink.emit('cache.miss', { 'cache.key': 'abc' });
    await sink.shutdown();

    const body = JSON.parse(String(calls[0]!.init?.body ?? '{}')) as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{
            name: string;
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
          }>;
        }>;
      }>;
    };
    const s = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(s.name).toBe('cache.miss');
    const attrMap = new Map(s.attributes.map((a) => [a.key, a.value]));
    expect(attrMap.get('telemetry.event')).toEqual({ boolValue: true });
    expect(attrMap.get('cache.key')).toEqual({ stringValue: 'abc' });
  });

  it('shutdown is idempotent and flushes pending spans', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    const sink = new OtlpSink({
      endpoint: 'http://localhost:4318/v1/traces',
      fetchImpl,
      maxBatchSize: 100, // do not auto-flush
      flushIntervalMs: 0,
    });
    sink.startSpan('a').end();
    sink.startSpan('b').end();
    expect(calls.length).toBe(0);
    await sink.shutdown();
    expect(calls.length).toBe(1);
    await sink.shutdown(); // no-op second call
    expect(calls.length).toBe(1);
  });
});
