import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoyageProvider } from '../../src/ai/voyage.js';

describe('VoyageProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('embedding service posts Bearer auth + voyage body shape', async () => {
    (globalThis.fetch as any).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [0.1, 0.2, 0.3] },
            { index: 1, embedding: [0.4, 0.5, 0.6] },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = new VoyageProvider({
      apiKey: 'pa-test',
      baseUrl: 'https://api.voyageai.com/v1',
      embeddingModel: 'voyage-code-3',
      embeddingDimensions: 1024,
    });
    const result = await provider.embedding().embedBatch(['hello', 'world']);
    expect(result).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(init.headers.Authorization).toBe('Bearer pa-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('voyage-code-3');
    expect(body.input).toEqual(['hello', 'world']);
    expect(body.input_type).toBe('document');
    expect(body.output_dimension).toBe(1024);
  });

  it('inference falls back to empty string (Voyage has no inference API)', async () => {
    const provider = new VoyageProvider({
      apiKey: 'pa-test',
      baseUrl: 'https://api.voyageai.com/v1',
      embeddingModel: 'voyage-code-3',
      embeddingDimensions: 1024,
    });
    expect(await provider.inference().generate('anything')).toBe('');
    expect(await provider.fastInference().generate('anything')).toBe('');
  });

  it('embed(text, "query") sends input_type="query" for retrieval-side calls', async () => {
    (globalThis.fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }), { status: 200 }),
    );

    const provider = new VoyageProvider({
      apiKey: 'pa-test',
      baseUrl: 'https://api.voyageai.com/v1',
      embeddingModel: 'voyage-code-3',
      embeddingDimensions: 1024,
    });
    await provider.embedding().embed('search terms', 'query');

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.input_type).toBe('query');
  });

  it('dimensions() + modelName() expose configured values', () => {
    const provider = new VoyageProvider({
      apiKey: 'pa-test',
      baseUrl: 'https://api.voyageai.com/v1',
      embeddingModel: 'voyage-3-large',
      embeddingDimensions: 2048,
    });
    const svc = provider.embedding();
    expect(svc.dimensions()).toBe(2048);
    expect(svc.modelName()).toBe('voyage-3-large');
  });
});
