import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VertexAIProvider } from '../../src/ai/vertex.js';

describe('VertexAIProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const baseConfig = {
    accessToken: 'ya29.test',
    project: 'demo-project',
    location: 'us-central1',
    embeddingModel: 'text-embedding-005',
    embeddingDimensions: 768,
    inferenceModel: 'gemini-2.5-flash',
    fastModel: 'gemini-2.5-flash',
  };

  it('embedding service routes to the correct region host + :predict verb', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(
      JSON.stringify({ predictions: [
        { embeddings: { values: [0.1, 0.2] } },
        { embeddings: { values: [0.3, 0.4] } },
      ] }),
      { status: 200 },
    ));

    const provider = new VertexAIProvider(baseConfig);
    const result = await provider.embedding().embedBatch(['a', 'b']);
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google/models/text-embedding-005:predict',
    );
    expect(init.headers.Authorization).toBe('Bearer ya29.test');
    const body = JSON.parse(init.body);
    expect(body.instances).toEqual([
      { task_type: 'RETRIEVAL_DOCUMENT', content: 'a' },
      { task_type: 'RETRIEVAL_DOCUMENT', content: 'b' },
    ]);
    expect(body.parameters).toEqual({ outputDimensionality: 768 });
  });

  it('inference hits :generateContent on the same regional host', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'hello from vertex' }] } }],
      }),
      { status: 200 },
    ));

    const provider = new VertexAIProvider(baseConfig);
    const result = await provider.inference().generate('ping');
    expect(result).toBe('hello from vertex');

    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent',
    );
  });

  it('isAvailable() returns false when auth or project is missing', async () => {
    const noToken = new VertexAIProvider({ ...baseConfig, accessToken: '' });
    const noProject = new VertexAIProvider({ ...baseConfig, project: '' });
    expect(await noToken.isAvailable()).toBe(false);
    expect(await noProject.isAvailable()).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('embed(text, "query") sends task_type=RETRIEVAL_QUERY instead of RETRIEVAL_DOCUMENT', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(
      JSON.stringify({ predictions: [{ embeddings: { values: [1] } }] }),
      { status: 200 },
    ));

    const provider = new VertexAIProvider(baseConfig);
    await provider.embedding().embed('user query', 'query');

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.instances).toEqual([{ task_type: 'RETRIEVAL_QUERY', content: 'user query' }]);
  });

  it('uses the configured location for request routing', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(
      JSON.stringify({ predictions: [{ embeddings: { values: [1] } }] }),
      { status: 200 },
    ));

    const provider = new VertexAIProvider({ ...baseConfig, location: 'europe-west4' });
    await provider.embedding().embed('hi');

    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain('https://europe-west4-aiplatform.googleapis.com/');
    expect(url).toContain('/locations/europe-west4/');
  });
});
