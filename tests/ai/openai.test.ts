import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAIProvider } from '../../src/ai/index.js';
import {
  OpenAIProvider,
  parseOpenAIExtraBodyEnv,
  resolveOpenAIExtraBody,
} from '../../src/ai/openai.js';
import type { TraceMcpConfig } from '../../src/config.js';

// Use a loopback baseUrl so the SSRF guard's DNS lookup resolves locally
// without any real network dependency (matches the lmstudio default).
const LOCAL_BASE_URL = 'http://localhost:1234/v1';

describe('OpenAIProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const baseConfig = {
    apiKey: 'sk-test',
    baseUrl: LOCAL_BASE_URL,
    embeddingModel: 'nomic-embed-text-v1.5',
    embeddingDimensions: 768,
    inferenceModel: 'qwen2.5-coder-7b-instruct',
    fastModel: 'qwen2.5-coder-7b-instruct',
  };

  describe('isAvailable', () => {
    it('returns true when /models responds ok', async () => {
      (globalThis.fetch as any).mockResolvedValue(new Response('{}', { status: 200 }));
      const provider = new OpenAIProvider(baseConfig);
      expect(await provider.isAvailable()).toBe(true);
    });

    it('returns false on a non-ok response', async () => {
      (globalThis.fetch as any).mockResolvedValue(new Response('{}', { status: 401 }));
      const provider = new OpenAIProvider(baseConfig);
      expect(await provider.isAvailable()).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      (globalThis.fetch as any).mockRejectedValue(new Error('connection refused'));
      const provider = new OpenAIProvider(baseConfig);
      expect(await provider.isAvailable()).toBe(false);
    });

    it('sends Authorization bearer header to <baseUrl>/models', async () => {
      (globalThis.fetch as any).mockResolvedValue(new Response('{}', { status: 200 }));
      const provider = new OpenAIProvider(baseConfig);
      await provider.isAvailable();

      const [url, init] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toBe(`${LOCAL_BASE_URL}/models`);
      expect(init.headers.Authorization).toBe('Bearer sk-test');
    });
  });

  describe('embedding()', () => {
    it('returns an EmbeddingService reflecting configured model + dimensions', () => {
      const provider = new OpenAIProvider(baseConfig);
      const svc = provider.embedding();
      expect(svc.dimensions()).toBe(768);
      expect(svc.modelName()).toBe('nomic-embed-text-v1.5');
      expect(svc.providerName()).toBe('openai');
    });

    it('embed() posts to <baseUrl>/embeddings and returns the vector', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), {
          status: 200,
        }),
      );
      const provider = new OpenAIProvider(baseConfig);
      const result = await provider.embedding().embed('hello world');
      expect(result).toEqual([0.1, 0.2, 0.3]);

      const [url, init] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toBe(`${LOCAL_BASE_URL}/embeddings`);
      const body = JSON.parse(init.body);
      expect(body.model).toBe('nomic-embed-text-v1.5');
      expect(body.input).toEqual(['hello world']);
    });

    it('embedBatch() re-orders results by response index', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [2] },
              { index: 0, embedding: [1] },
            ],
          }),
          { status: 200 },
        ),
      );
      const provider = new OpenAIProvider(baseConfig);
      const result = await provider.embedding().embedBatch(['a', 'b']);
      expect(result).toEqual([[1], [2]]);
    });

    it('embedBatch() throws a descriptive error on API failure', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response('quota exceeded', { status: 429, statusText: 'Too Many Requests' }),
      );
      const provider = new OpenAIProvider(baseConfig);
      await expect(provider.embedding().embedBatch(['a'])).rejects.toThrow(
        /OpenAI embeddings failed/,
      );
    });
  });

  describe('inference() / fastInference()', () => {
    it('inference() uses the configured inferenceModel and hits /chat/completions', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
          status: 200,
        }),
      );
      const provider = new OpenAIProvider(baseConfig);
      const result = await provider.inference().generate('ping');
      expect(result).toBe('hi');

      const [url, init] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toBe(`${LOCAL_BASE_URL}/chat/completions`);
      const body = JSON.parse(init.body);
      expect(body.model).toBe('qwen2.5-coder-7b-instruct');
    });

    it('fastInference() uses the configured fastModel', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'fast' } }] }), {
          status: 200,
        }),
      );
      const provider = new OpenAIProvider({ ...baseConfig, fastModel: 'fast-model-x' });
      const result = await provider.fastInference().generate('ping');
      expect(result).toBe('fast');

      const [, init] = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.model).toBe('fast-model-x');
    });

    it('merges extraBody into the request, with core fields winning on conflict', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );
      const provider = new OpenAIProvider({
        ...baseConfig,
        extraBody: { model: 'should-be-overridden', reasoning_effort: 'high' },
      });
      await provider.inference().generate('ping');

      const [, init] = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.reasoning_effort).toBe('high');
      // Core `model` field always wins over extraBody per documented contract.
      expect(body.model).toBe('qwen2.5-coder-7b-instruct');
    });
  });

  describe('baseUrl override (OpenAI-compatible / LM Studio path)', () => {
    it('embedding/inference/fastInference all route through the configured baseUrl', async () => {
      const customUrl = 'http://127.0.0.1:8000/v1';
      (globalThis.fetch as any).mockResolvedValue(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 }),
      );
      const provider = new OpenAIProvider({ ...baseConfig, baseUrl: customUrl });
      await provider.embedding().embed('x');
      const [embedUrl] = (globalThis.fetch as any).mock.calls[0];
      expect(embedUrl).toBe(`${customUrl}/embeddings`);

      (globalThis.fetch as any).mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'y' } }] }), {
          status: 200,
        }),
      );
      await provider.inference().generate('ping');
      const [inferUrl] = (globalThis.fetch as any).mock.calls[1];
      expect(inferUrl).toBe(`${customUrl}/chat/completions`);
    });
  });
});

describe('parseOpenAIExtraBodyEnv / resolveOpenAIExtraBody', () => {
  it('parses a valid JSON object from the env var', () => {
    expect(parseOpenAIExtraBodyEnv('{"foo":"bar"}')).toEqual({ foo: 'bar' });
  });

  it('returns {} for empty/whitespace input', () => {
    expect(parseOpenAIExtraBodyEnv('')).toEqual({});
    expect(parseOpenAIExtraBodyEnv('   ')).toEqual({});
    expect(parseOpenAIExtraBodyEnv(undefined)).toEqual({});
  });

  it('returns {} and warns for malformed JSON', () => {
    expect(parseOpenAIExtraBodyEnv('{not valid json')).toEqual({});
  });

  it('returns {} for a JSON array (not an object)', () => {
    expect(parseOpenAIExtraBodyEnv('[1,2,3]')).toEqual({});
  });

  it('returns {} for JSON null', () => {
    expect(parseOpenAIExtraBodyEnv('null')).toEqual({});
  });

  it('resolveOpenAIExtraBody: config value wins over env on key conflict', () => {
    const result = resolveOpenAIExtraBody(
      { reasoning_effort: 'high' },
      { reasoning_effort: 'low' },
    );
    expect(result.reasoning_effort).toBe('high');
  });

  it('resolveOpenAIExtraBody: merges non-conflicting keys from both sources', () => {
    const result = resolveOpenAIExtraBody({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('resolveOpenAIExtraBody: defaults to {} when config extra is undefined', () => {
    expect(resolveOpenAIExtraBody(undefined, { b: 2 })).toEqual({ b: 2 });
  });
});

describe('createAIProvider — openai-compatible wiring', () => {
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

  it('reads api_key from config.ai.api_key for the openai provider', () => {
    vi.stubEnv('TRACE_MCP_AI_CONSENT', '1');
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'openai', api_key: 'sk-from-config' },
    });
    expect(provider.inference).toBeDefined();
  });

  it('falls back to process.env.OPENAI_API_KEY when config.ai.api_key is absent', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-from-env');
    vi.stubEnv('TRACE_MCP_AI_CONSENT', '1');
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'openai' },
    });
    expect(provider.inference).toBeDefined();
  });

  it('lmstudio does not require an api_key (local, no consent gate)', () => {
    vi.stubEnv('LMSTUDIO_API_KEY', '');
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'lmstudio' },
    });
    expect(provider.inference).toBeDefined();
  });

  it('lmstudio defaults base_url to http://localhost:1234/v1 when unset', () => {
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'lmstudio' },
    });
    // Can't reach into the wrapped provider's private config directly, but we
    // can confirm it constructs a usable provider without throwing/falling back.
    expect(provider.embedding().dimensions()).toBe(768);
  });

  it('falls back to FallbackProvider for openai when no api key is available anywhere', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('TRACE_MCP_AI_CONSENT', '1');
    const { FallbackProvider } = await import('../../src/ai/fallback.js');
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'openai' },
    });
    expect(provider).toBeInstanceOf(FallbackProvider);
  });
});
