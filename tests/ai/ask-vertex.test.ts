import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVertexAIProvider } from '../../src/ai/ask-shared.js';

describe('createVertexAIProvider (Ask streaming)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
  }

  it('streams Gemini-format SSE chunks as text deltas', async () => {
    const body = sseBody([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"world"}]}}]}\n\n',
    ]);
    (globalThis.fetch as any).mockResolvedValue(new Response(body, { status: 200 }));

    const provider = createVertexAIProvider(
      'ya29.test',
      'demo-project',
      'us-central1',
      'gemini-2.5-flash',
    );
    const out: string[] = [];
    for await (const chunk of provider.streamChat([
      { role: 'system', content: 'you are a helper' },
      { role: 'user', content: 'hi' },
    ])) {
      out.push(chunk);
    }
    expect(out.join('')).toBe('Hello world');
  });

  it('routes to :streamGenerateContent on the regional host with Bearer auth', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(sseBody([]), { status: 200 }));

    const provider = createVertexAIProvider(
      'ya29.test',
      'demo-project',
      'europe-west4',
      'gemini-2.5-pro',
    );
    // Consume the stream so fetch fires.
    for await (const _ of provider.streamChat([{ role: 'user', content: 'hi' }])) {
      void _;
    }

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe(
      'https://europe-west4-aiplatform.googleapis.com/v1/projects/demo-project/locations/europe-west4/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
    expect(init.headers.Authorization).toBe('Bearer ya29.test');
  });

  it('puts system message into systemInstruction (Gemini schema), not into contents', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(sseBody([]), { status: 200 }));

    const provider = createVertexAIProvider(
      'ya29.test',
      'demo-project',
      'us-central1',
      'gemini-2.5-flash',
    );
    for await (const _ of provider.streamChat([
      { role: 'system', content: 'you are a helper' },
      { role: 'user', content: 'hi' },
    ])) {
      void _;
    }

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'you are a helper' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('maps assistant role to Gemini-native "model" role', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(sseBody([]), { status: 200 }));

    const provider = createVertexAIProvider(
      'ya29.test',
      'demo-project',
      'us-central1',
      'gemini-2.5-flash',
    );
    for await (const _ of provider.streamChat([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you?' },
    ])) {
      void _;
    }

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
  });
});
