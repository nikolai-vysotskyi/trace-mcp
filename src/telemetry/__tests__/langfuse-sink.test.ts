import { describe, expect, it, vi } from 'vitest';
import { LangfuseSink } from '../langfuse.js';

function makeFetchSpy(): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('LangfuseSink', () => {
  it('normalizes the endpoint and adds Basic auth', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    const sink = new LangfuseSink({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      fetchImpl,
      maxBatchSize: 1,
      flushIntervalMs: 0,
    });

    sink.startSpan('ai.generate', { 'ai.model': 'gpt-4o' }).end();
    await sink.shutdown();

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://cloud.langfuse.com/api/public/ingestion');
    expect(c.init?.method).toBe('POST');
    const headers = c.init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(headers.authorization.slice(6), 'base64').toString();
    expect(decoded).toBe('pk-test:sk-test');
    expect(headers['content-type']).toBe('application/json');
  });

  it('sends span-create + span-update pairs with correlated IDs', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    const sink = new LangfuseSink({
      endpoint: 'https://cloud.langfuse.com/api/public/ingestion',
      publicKey: 'pk',
      secretKey: 'sk',
      fetchImpl,
      maxBatchSize: 2,
      flushIntervalMs: 0,
    });

    const span = sink.startSpan('ai.embed', { 'ai.input_size': 10 });
    span.end();
    await sink.shutdown();

    const body = JSON.parse(String(calls[0]!.init?.body ?? '{}')) as {
      batch: Array<{ type: string; body: { id: string; endTime?: string; level?: string } }>;
    };
    expect(body.batch).toHaveLength(2);
    const create = body.batch.find((e) => e.type === 'span-create');
    const update = body.batch.find((e) => e.type === 'span-update');
    expect(create).toBeDefined();
    expect(update).toBeDefined();
    expect(create!.body.id).toBe(update!.body.id);
    expect(update!.body.level).toBe('DEFAULT');
  });

  it('marks errors with level=ERROR in the span-update', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    const sink = new LangfuseSink({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: 'pk',
      secretKey: 'sk',
      fetchImpl,
      maxBatchSize: 2,
      flushIntervalMs: 0,
    });

    const span = sink.startSpan('ai.generate');
    span.recordError(new Error('rate limited'));
    span.end();
    await sink.shutdown();

    const body = JSON.parse(String(calls[0]!.init?.body ?? '{}')) as {
      batch: Array<{ type: string; body: { level?: string; statusMessage?: string } }>;
    };
    const update = body.batch.find((e) => e.type === 'span-update');
    expect(update?.body.level).toBe('ERROR');
    expect(update?.body.statusMessage).toBe('rate limited');
  });

  it('one-shot events go out as event-create entries', async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    const sink = new LangfuseSink({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: 'pk',
      secretKey: 'sk',
      fetchImpl,
      maxBatchSize: 1,
      flushIntervalMs: 0,
    });
    sink.emit('cache.miss', { 'cache.key': 'abc' });
    await sink.shutdown();

    const body = JSON.parse(String(calls[0]!.init?.body ?? '{}')) as {
      batch: Array<{
        type: string;
        body: { name?: string; metadata?: Record<string, unknown> };
      }>;
    };
    const ev = body.batch.find((e) => e.type === 'event-create');
    expect(ev).toBeDefined();
    expect(ev!.body.name).toBe('cache.miss');
    expect(ev!.body.metadata).toEqual({ 'cache.key': 'abc' });
  });
});
