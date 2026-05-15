import { describe, expect, it, vi } from 'vitest';
import { LangfuseSink, LangfuseQueueOverflowError } from '../langfuse.js';

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

  it('caps buffer when endpoint never responds (hung fetch)', async () => {
    const fetchImpl = vi.fn(
      async (_url: unknown, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }
        }),
    ) as unknown as typeof fetch;

    const errors: unknown[] = [];
    const sink = new LangfuseSink({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: 'pk',
      secretKey: 'sk',
      fetchImpl,
      maxBatchSize: 1_000_000,
      flushIntervalMs: 0,
      maxQueuedEvents: 50,
      requestTimeoutMs: 0,
      onError: (e) => errors.push(e),
    });

    // 200 spans → 400 events, hard-capped to 50.
    for (let i = 0; i < 200; i++) {
      sink.startSpan(`s${i}`).end();
    }
    expect(sink.getBufferSize()).toBe(50);
    expect(errors.some((e) => e instanceof LangfuseQueueOverflowError)).toBe(true);
  });

  it('caps buffer when endpoint returns 500', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const sink = new LangfuseSink({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: 'pk',
      secretKey: 'sk',
      fetchImpl,
      maxBatchSize: 10_000, // never auto-flush
      flushIntervalMs: 0,
      maxQueuedEvents: 40,
      requestTimeoutMs: 0,
      onError: (e) => errors.push(e),
    });
    for (let i = 0; i < 100; i++) {
      sink.startSpan(`x${i}`).end();
    }
    expect(sink.getBufferSize()).toBe(40);
    expect(errors.some((e) => e instanceof LangfuseQueueOverflowError)).toBe(true);
    await sink.shutdown();
  });

  it('single concurrent flush: parallel triggers share one fetch', async () => {
    const resolvers: Array<(res: Response) => void> = [];
    const fetchImpl = vi.fn(
      async () =>
        new Promise<Response>((res) => {
          resolvers.push(res);
        }),
    ) as unknown as typeof fetch;
    const mockCalls = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls;

    const sink = new LangfuseSink({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: 'pk',
      secretKey: 'sk',
      fetchImpl,
      maxBatchSize: 1_000,
      flushIntervalMs: 0,
      requestTimeoutMs: 0,
    });

    sink.startSpan('a').end();
    const p1 = sink.flush();
    const p2 = sink.flush();
    sink.startSpan('b').end();
    const p3 = sink.flush();

    expect(mockCalls.length).toBe(1);
    resolvers[0]!(new Response('{}', { status: 200 }));
    await Promise.all([p1, p2, p3]);

    // "b" span (2 events) still buffered.
    expect(sink.getBufferSize()).toBe(2);
    const p4 = sink.flush();
    expect(mockCalls.length).toBe(2);
    resolvers[1]!(new Response('{}', { status: 200 }));
    await p4;
    expect(sink.getBufferSize()).toBe(0);
  });

  it('requestTimeoutMs aborts a hung fetch', async () => {
    vi.useFakeTimers();
    try {
      const aborts: unknown[] = [];
      const fetchImpl = vi.fn(
        async (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                aborts.push('abort');
                reject(new Error('aborted'));
              });
            }
          }),
      ) as unknown as typeof fetch;
      const errors: unknown[] = [];
      const sink = new LangfuseSink({
        endpoint: 'https://cloud.langfuse.com',
        publicKey: 'pk',
        secretKey: 'sk',
        fetchImpl,
        maxBatchSize: 1, // triggers flush after first event
        flushIntervalMs: 0,
        requestTimeoutMs: 100,
        onError: (e) => errors.push(e),
      });
      sink.emit('cache.miss');
      await vi.advanceTimersByTimeAsync(150);
      expect(aborts.length).toBe(1);
      expect(errors.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limits queue overflow warnings (one warn per 60s)', async () => {
    let now = 0;
    const errors: unknown[] = [];
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    const sink = new LangfuseSink({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: 'pk',
      secretKey: 'sk',
      fetchImpl,
      maxBatchSize: 10_000, // never auto-flush
      flushIntervalMs: 0,
      maxQueuedEvents: 10,
      requestTimeoutMs: 0,
      nowMs: () => now,
      onError: (e) => errors.push(e),
    });

    for (let i = 0; i < 50; i++) sink.startSpan(`a${i}`).end();
    expect(errors.filter((e) => e instanceof LangfuseQueueOverflowError).length).toBe(1);

    now = 30_000;
    for (let i = 0; i < 50; i++) sink.startSpan(`b${i}`).end();
    expect(errors.filter((e) => e instanceof LangfuseQueueOverflowError).length).toBe(1);

    now = 70_000;
    for (let i = 0; i < 50; i++) sink.startSpan(`c${i}`).end();
    expect(errors.filter((e) => e instanceof LangfuseQueueOverflowError).length).toBe(2);
  });
});
