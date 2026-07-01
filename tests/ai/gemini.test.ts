import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../../src/ai/gemini.js';
import { createAIProvider } from '../../src/ai/index.js';
import type { TraceMcpConfig } from '../../src/config.js';

describe('GeminiProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const baseConfig = {
    apiKey: 'gm-test-key',
    embeddingModel: 'text-embedding-004',
    embeddingDimensions: 768,
    inferenceModel: 'gemini-2.5-pro',
    fastModel: 'gemini-2.5-flash',
  };

  describe('isAvailable', () => {
    it('returns true when /models responds ok', async () => {
      (globalThis.fetch as any).mockResolvedValue(new Response('{}', { status: 200 }));
      const provider = new GeminiProvider(baseConfig);
      expect(await provider.isAvailable()).toBe(true);
    });

    it('returns false on a non-ok response', async () => {
      (globalThis.fetch as any).mockResolvedValue(new Response('{}', { status: 403 }));
      const provider = new GeminiProvider(baseConfig);
      expect(await provider.isAvailable()).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      (globalThis.fetch as any).mockRejectedValue(new Error('network error'));
      const provider = new GeminiProvider(baseConfig);
      expect(await provider.isAvailable()).toBe(false);
    });

    it('includes the api key as a query param', async () => {
      (globalThis.fetch as any).mockResolvedValue(new Response('{}', { status: 200 }));
      const provider = new GeminiProvider(baseConfig);
      await provider.isAvailable();

      const [url] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toContain('key=gm-test-key');
      expect(url).toContain('/v1beta/models');
    });
  });

  describe('embedding()', () => {
    it('returns an EmbeddingService reflecting configured model + dimensions', () => {
      const provider = new GeminiProvider(baseConfig);
      const svc = provider.embedding();
      expect(svc.dimensions()).toBe(768);
      expect(svc.modelName()).toBe('text-embedding-004');
      expect(svc.providerName()).toBe('gemini');
    });

    it('embed() posts to batchEmbedContents and returns the vector', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(JSON.stringify({ embeddings: [{ values: [0.5, 0.6] }] }), { status: 200 }),
      );
      const provider = new GeminiProvider(baseConfig);
      const result = await provider.embedding().embed('hello');
      expect(result).toEqual([0.5, 0.6]);

      const [url, init] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toContain(':batchEmbedContents');
      expect(url).toContain('text-embedding-004');
      const body = JSON.parse(init.body);
      expect(body.requests[0].taskType).toBe('RETRIEVAL_DOCUMENT');
    });

    it('embed(text, "query") sends RETRIEVAL_QUERY task type', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(JSON.stringify({ embeddings: [{ values: [1] }] }), { status: 200 }),
      );
      const provider = new GeminiProvider(baseConfig);
      await provider.embedding().embed('user query', 'query');

      const [, init] = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.requests[0].taskType).toBe('RETRIEVAL_QUERY');
    });

    it('embedBatch() maps each text to a request with outputDimensionality', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(JSON.stringify({ embeddings: [{ values: [1] }, { values: [2] }] }), {
          status: 200,
        }),
      );
      const provider = new GeminiProvider(baseConfig);
      const result = await provider.embedding().embedBatch(['a', 'b']);
      expect(result).toEqual([[1], [2]]);

      const [, init] = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.requests).toHaveLength(2);
      expect(body.requests[0].outputDimensionality).toBe(768);
    });

    it('embedBatch() throws a descriptive error on API failure', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response('bad key', { status: 400, statusText: 'Bad Request' }),
      );
      const provider = new GeminiProvider(baseConfig);
      await expect(provider.embedding().embedBatch(['a'])).rejects.toThrow(
        /Gemini embeddings failed/,
      );
    });
  });

  describe('inference() vs fastInference() — fast/smart tier split', () => {
    it('inference() uses the smart tier model (gemini-2.5-pro by default)', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'smart answer' }] } }] }),
          { status: 200 },
        ),
      );
      const provider = new GeminiProvider(baseConfig);
      const result = await provider.inference().generate('ping');
      expect(result).toBe('smart answer');

      const [url] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toContain('gemini-2.5-pro:generateContent');
    });

    it('fastInference() uses the fast tier model (gemini-2.5-flash by default)', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'fast answer' }] } }] }),
          { status: 200 },
        ),
      );
      const provider = new GeminiProvider(baseConfig);
      const result = await provider.fastInference().generate('ping');
      expect(result).toBe('fast answer');

      const [url] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toContain('gemini-2.5-flash:generateContent');
    });

    it('inference() and fastInference() use different models when configured differently', async () => {
      const provider = new GeminiProvider({
        ...baseConfig,
        inferenceModel: 'gemini-custom-smart',
        fastModel: 'gemini-custom-fast',
      });
      const makeResponse = () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }), {
          status: 200,
        });

      (globalThis.fetch as any).mockResolvedValueOnce(makeResponse());
      await provider.inference().generate('ping');
      const [smartUrl] = (globalThis.fetch as any).mock.calls[0];
      expect(smartUrl).toContain('gemini-custom-smart');

      (globalThis.fetch as any).mockResolvedValueOnce(makeResponse());
      await provider.fastInference().generate('ping');
      const [fastUrl] = (globalThis.fetch as any).mock.calls[1];
      expect(fastUrl).toContain('gemini-custom-fast');
    });

    it('generate() throws a descriptive error on API failure', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
      );
      const provider = new GeminiProvider(baseConfig);
      await expect(provider.inference().generate('ping')).rejects.toThrow(/Gemini generate failed/);
    });
  });
});

describe('createAIProvider — gemini wiring', () => {
  const baseConfig: TraceMcpConfig = {
    root: '.',
    include: [],
    exclude: [],
    db: { path: ':memory:' },
    plugins: [],
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads api_key from config.ai.api_key when present', () => {
    vi.stubEnv('TRACE_MCP_AI_CONSENT', '1');
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'gemini', api_key: 'gm-from-config' },
    });
    expect(provider.inference).toBeDefined();
  });

  it('falls back to process.env.GEMINI_API_KEY when config.ai.api_key is absent', () => {
    vi.stubEnv('GEMINI_API_KEY', 'gm-from-env');
    vi.stubEnv('TRACE_MCP_AI_CONSENT', '1');
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'gemini' },
    });
    expect(provider.inference).toBeDefined();
  });

  it('defaults embedding dimensions to 768 when unset', () => {
    vi.stubEnv('GEMINI_API_KEY', 'gm-from-env');
    vi.stubEnv('TRACE_MCP_AI_CONSENT', '1');
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'gemini' },
    });
    expect(provider.embedding().dimensions()).toBe(768);
  });

  it('falls back to FallbackProvider when no api key is available anywhere', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('TRACE_MCP_AI_CONSENT', '1');
    const { FallbackProvider } = await import('../../src/ai/fallback.js');
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'gemini' },
    });
    expect(provider).toBeInstanceOf(FallbackProvider);
  });
});
