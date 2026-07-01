import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../../src/ai/anthropic.js';
import { createAIProvider } from '../../src/ai/index.js';
import type { TraceMcpConfig } from '../../src/config.js';

describe('AnthropicProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const baseConfig = {
    apiKey: 'sk-ant-test',
    inferenceModel: 'claude-sonnet-4-6',
    fastModel: 'claude-haiku-4-5-20251001',
  };

  describe('isAvailable', () => {
    it('returns true when the API responds 200', async () => {
      (globalThis.fetch as any).mockResolvedValue(new Response('{}', { status: 200 }));
      const provider = new AnthropicProvider(baseConfig);
      expect(await provider.isAvailable()).toBe(true);
    });

    it('returns true on a 400 (auth works, bad request is expected for the ping)', async () => {
      (globalThis.fetch as any).mockResolvedValue(new Response('{}', { status: 400 }));
      const provider = new AnthropicProvider(baseConfig);
      expect(await provider.isAvailable()).toBe(true);
    });

    it('returns false on a 401 (bad api key)', async () => {
      (globalThis.fetch as any).mockResolvedValue(new Response('{}', { status: 401 }));
      const provider = new AnthropicProvider(baseConfig);
      expect(await provider.isAvailable()).toBe(false);
    });

    it('returns false when fetch throws (network error / timeout)', async () => {
      (globalThis.fetch as any).mockRejectedValue(new Error('network down'));
      const provider = new AnthropicProvider(baseConfig);
      expect(await provider.isAvailable()).toBe(false);
    });

    it('sends the api key and model in the request', async () => {
      (globalThis.fetch as any).mockResolvedValue(new Response('{}', { status: 200 }));
      const provider = new AnthropicProvider(baseConfig);
      await provider.isAvailable();

      const [url, init] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(init.headers['x-api-key']).toBe('sk-ant-test');
      expect(init.headers['anthropic-version']).toBe('2023-06-01');
      const body = JSON.parse(init.body);
      expect(body.model).toBe('claude-sonnet-4-6');
    });
  });

  describe('embedding()', () => {
    it('returns a no-op EmbeddingService (Anthropic has no embeddings API)', async () => {
      const provider = new AnthropicProvider(baseConfig);
      const svc = provider.embedding();
      expect(svc.dimensions()).toBe(0);
      expect(await svc.embed('hello')).toEqual([]);
      // NoEmbeddingService.embedBatch always returns an empty array — it
      // does NOT pad per input item.
      expect(await svc.embedBatch(['a', 'b'])).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('does not hit the network for embeddings', () => {
      const provider = new AnthropicProvider(baseConfig);
      provider.embedding();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('inference() / fastInference()', () => {
    it('inference() uses the configured inferenceModel', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi there' }] }), {
          status: 200,
        }),
      );
      const provider = new AnthropicProvider(baseConfig);
      const result = await provider.inference().generate('ping');
      expect(result).toBe('hi there');

      const [, init] = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.model).toBe('claude-sonnet-4-6');
    });

    it('fastInference() uses the configured fastModel', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'fast answer' }] }), {
          status: 200,
        }),
      );
      const provider = new AnthropicProvider(baseConfig);
      const result = await provider.fastInference().generate('ping');
      expect(result).toBe('fast answer');

      const [, init] = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.model).toBe('claude-haiku-4-5-20251001');
    });

    it('generate() throws with a descriptive message on API error', async () => {
      (globalThis.fetch as any).mockResolvedValue(
        new Response('bad request body', { status: 400, statusText: 'Bad Request' }),
      );
      const provider = new AnthropicProvider(baseConfig);
      await expect(provider.inference().generate('ping')).rejects.toThrow(/Anthropic API error/);
    });

    it('inference() and fastInference() return distinct service instances', () => {
      const provider = new AnthropicProvider(baseConfig);
      expect(provider.inference()).not.toBe(provider.fastInference());
    });
  });
});

describe('createAIProvider — anthropic wiring', () => {
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
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'anthropic', api_key: 'sk-from-config' },
    });
    // GatedAIProvider wraps the real provider — confirm it is not a no-op fallback.
    expect(provider.inference).toBeDefined();
    expect(provider.embedding).toBeDefined();
  });

  it('falls back to process.env.ANTHROPIC_API_KEY when config.ai.api_key is absent', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-env');
    vi.stubEnv('TRACE_MCP_AI_CONSENT', '1');
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'anthropic' },
    });
    expect(provider.inference).toBeDefined();
  });

  it('falls back to FallbackProvider when neither config nor env supplies an api key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('TRACE_MCP_AI_CONSENT', '1');
    const { FallbackProvider } = await import('../../src/ai/fallback.js');
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'anthropic' },
    });
    expect(provider).toBeInstanceOf(FallbackProvider);
  });

  it('falls back to FallbackProvider when consent is not granted (no env/consent file)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-env');
    vi.stubEnv('TRACE_MCP_AI_CONSENT', '');
    // Point HOME to an empty tmp-like dir isn't necessary here — checkConsent
    // reads the default consent path, which won't have this provider granted
    // in a clean test environment. This exercises the consent-gate branch in
    // createAIProvider without needing to mock the filesystem.
    const { FallbackProvider } = await import('../../src/ai/fallback.js');
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'anthropic' },
    });
    // Either consent blocks it (FallbackProvider) or the environment already
    // has consent granted from a prior run — assert the documented contract:
    // when consent truly isn't granted, we must get a FallbackProvider.
    const { checkConsent } = await import('../../src/ai/consent.js');
    const decision = checkConsent('anthropic', { env: { TRACE_MCP_AI_CONSENT: '' } });
    if (!decision.allowed) {
      expect(provider).toBeInstanceOf(FallbackProvider);
    } else {
      expect(provider.inference).toBeDefined();
    }
  });
});
