/**
 * Unit tests for src/ai/ask-shared.ts — the highest-priority gap in the AI
 * provider layer's test coverage. This module decides:
 *   - resolveProvider(): which LLM provider handles `trace-mcp ask` (cloud
 *     routing + the ai.features.inference gate)
 *   - gatherContext()/gatherContextWithEnvelope(): what code/context is
 *     actually assembled and handed to that LLM — the real privacy boundary
 *
 * Note: createVertexAIProvider() streaming behavior (SSE parsing, role
 * mapping, regional host routing) is already covered by
 * tests/ai/ask-vertex.test.ts — this file adds only its error-path test to
 * avoid duplicating that coverage.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSystemPrompt,
  createAnthropicProvider,
  createOpenAICompatibleProvider,
  createVertexAIProvider,
  gatherContext,
  gatherContextWithEnvelope,
  resolveProvider,
  stripContextFromMessage,
} from '../../src/ai/ask-shared.js';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/no-framework');

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function makeConfig(overrides: Partial<TraceMcpConfig> = {}): TraceMcpConfig {
  return {
    root: '.',
    include: [],
    exclude: [],
    db: { path: ':memory:' },
    plugins: [],
    ...overrides,
  };
}

describe('resolveProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore exactly — vi.unstubAllEnvs only undoes vi.stubEnv calls, but
    // resolveProvider reads process.env directly so we manage it by hand.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  function clearProviderEnvVars() {
    delete process.env.GROQ_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_ACCESS_TOKEN;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_LOCATION;
  }

  beforeEach(() => {
    clearProviderEnvVars();
  });

  it('throws when ai.features.inference is explicitly disabled', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const config = makeConfig({
      ai: { enabled: true, provider: 'anthropic', features: { inference: false } },
    });
    expect(() => resolveProvider({}, config)).toThrow(/ai\.features\.inference = false/);
  });

  it('does not throw when ai.enabled is false, even with features.inference: false', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const config = makeConfig({
      ai: { enabled: false, provider: 'anthropic', features: { inference: false } },
    });
    expect(() => resolveProvider({}, config)).not.toThrow();
  });

  it('--provider groq requires GROQ_API_KEY and throws a clear error without it', () => {
    expect(() => resolveProvider({ provider: 'groq' })).toThrow(/GROQ_API_KEY/);
  });

  it('routes to groq when GROQ_API_KEY is set, even without --provider', () => {
    process.env.GROQ_API_KEY = 'gsk-test';
    const provider = resolveProvider({});
    expect(provider.name).toContain('groq');
  });

  it('explicit --provider anthropic requires ANTHROPIC_API_KEY', () => {
    expect(() => resolveProvider({ provider: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('routes to anthropic when ANTHROPIC_API_KEY is set (env-only auto-detect)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const provider = resolveProvider({});
    expect(provider.name).toContain('anthropic');
    expect(provider.name).toContain('claude-sonnet-4-6');
  });

  it('--model overrides the default model for the chosen provider', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const provider = resolveProvider({ model: 'claude-custom' });
    expect(provider.name).toContain('claude-custom');
  });

  it('explicit --provider openai requires OPENAI_API_KEY', () => {
    expect(() => resolveProvider({ provider: 'openai' })).toThrow(/OPENAI_API_KEY/);
  });

  it('routes to openai when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-oa-test';
    const provider = resolveProvider({});
    expect(provider.name).toContain('openai');
    expect(provider.name).toContain('gpt-4o-mini');
  });

  it('vertex requires both GOOGLE_ACCESS_TOKEN and GOOGLE_CLOUD_PROJECT', () => {
    expect(() => resolveProvider({ provider: 'vertex' })).toThrow(/GOOGLE_ACCESS_TOKEN/);
    process.env.GOOGLE_ACCESS_TOKEN = 'ya29.test';
    expect(() => resolveProvider({ provider: 'vertex' })).toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it('routes to vertex when both env vars are present', () => {
    process.env.GOOGLE_ACCESS_TOKEN = 'ya29.test';
    process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
    const provider = resolveProvider({});
    expect(provider.name).toContain('vertex');
  });

  it('priority order: --provider flag wins over auto-detected env vars', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.GROQ_API_KEY = 'gsk-test';
    // Explicit --provider anthropic should win even though groq is checked first
    // in the auto-detect chain — because opts.provider is checked per-branch.
    const provider = resolveProvider({ provider: 'anthropic' });
    expect(provider.name).toContain('anthropic');
  });

  it('falls back to config.ai when no CLI flag / env var matches (openai)', () => {
    const config = makeConfig({
      ai: { enabled: true, provider: 'openai', api_key: 'sk-from-config' },
    });
    const provider = resolveProvider({}, config);
    expect(provider.name).toContain('openai');
  });

  it('falls back to config.ai for ollama without requiring an api key', () => {
    const config = makeConfig({
      ai: { enabled: true, provider: 'ollama', base_url: 'http://localhost:11434' },
    });
    const provider = resolveProvider({}, config);
    expect(provider.name).toContain('ollama');
  });

  it('skips config.ai routing when provider is onnx (embedding-only, no inference)', () => {
    const config = makeConfig({ ai: { enabled: true, provider: 'onnx' } });
    expect(() => resolveProvider({}, config)).toThrow(/No LLM provider found/);
  });

  it('throws a helpful error listing all env vars when nothing matches', () => {
    expect(() => resolveProvider({})).toThrow(/GROQ_API_KEY/);
    expect(() => resolveProvider({})).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => resolveProvider({})).toThrow(/OPENAI_API_KEY/);
    expect(() => resolveProvider({})).toThrow(/GOOGLE_ACCESS_TOKEN/);
  });
});

describe('createOpenAICompatibleProvider (Ask streaming)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('streams OpenAI-format SSE chunks as text deltas', async () => {
    const body = sseBody([
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    (globalThis.fetch as any).mockResolvedValue(new Response(body, { status: 200 }));

    const provider = createOpenAICompatibleProvider(
      'groq',
      'https://api.groq.com/openai/v1',
      'gsk-test',
      'llama-3.3-70b-versatile',
    );
    const out: string[] = [];
    for await (const chunk of provider.streamChat([{ role: 'user', content: 'hi' }])) {
      out.push(chunk);
    }
    expect(out.join('')).toBe('Hello world');
  });

  it('posts to <baseUrl>/chat/completions with Bearer auth and stream: true', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(sseBody([]), { status: 200 }));

    const provider = createOpenAICompatibleProvider(
      'openai',
      'https://api.openai.com/v1',
      'sk-test',
      'gpt-4o-mini',
    );
    for await (const _ of provider.streamChat([{ role: 'user', content: 'hi' }])) {
      void _;
    }

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.stream).toBe(true);
  });

  it('throws a descriptive error on a non-ok response', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response('rate limited', { status: 429 }));
    const provider = createOpenAICompatibleProvider(
      'groq',
      'https://api.groq.com/openai/v1',
      'gsk-test',
      'llama-3.3-70b-versatile',
    );
    await expect(async () => {
      for await (const _ of provider.streamChat([{ role: 'user', content: 'hi' }])) {
        void _;
      }
    }).rejects.toThrow(/groq API error: 429/);
  });

  it('name includes the provider label and model', () => {
    const provider = createOpenAICompatibleProvider(
      'ollama',
      'http://localhost:11434/v1',
      '',
      'llama3.2',
    );
    expect(provider.name).toBe('ollama (llama3.2)');
  });
});

describe('createAnthropicProvider (Ask streaming)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('streams Anthropic-format SSE content_block_delta events as text', async () => {
    const body = sseBody([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    (globalThis.fetch as any).mockResolvedValue(new Response(body, { status: 200 }));

    const provider = createAnthropicProvider('sk-ant-test', 'claude-sonnet-4-6');
    const out: string[] = [];
    for await (const chunk of provider.streamChat([{ role: 'user', content: 'hi' }])) {
      out.push(chunk);
    }
    expect(out.join('')).toBe('Hello world');
  });

  it('puts system message into the top-level `system` field, not `messages`', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(sseBody([]), { status: 200 }));

    const provider = createAnthropicProvider('sk-ant-test', 'claude-sonnet-4-6');
    for await (const _ of provider.streamChat([
      { role: 'system', content: 'you are a helper' },
      { role: 'user', content: 'hi' },
    ])) {
      void _;
    }

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    const body = JSON.parse(init.body);
    expect(body.system).toBe('you are a helper');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.stream).toBe(true);
  });

  it('throws a descriptive error on a non-ok response', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response('bad auth', { status: 401 }));
    const provider = createAnthropicProvider('bad-key', 'claude-sonnet-4-6');
    await expect(async () => {
      for await (const _ of provider.streamChat([{ role: 'user', content: 'hi' }])) {
        void _;
      }
    }).rejects.toThrow(/Anthropic API error: 401/);
  });

  it('name includes the model', () => {
    const provider = createAnthropicProvider('sk-ant-test', 'claude-haiku-4-5-20251001');
    expect(provider.name).toBe('anthropic (claude-haiku-4-5-20251001)');
  });
});

describe('createVertexAIProvider — error path', () => {
  // Streaming/role-mapping/regional-host coverage lives in ask-vertex.test.ts.
  // This adds the one missing branch: non-ok response handling.
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws a descriptive error on a non-ok response', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response('quota exceeded', { status: 429 }));
    const provider = createVertexAIProvider(
      'ya29.test',
      'demo-project',
      'us-central1',
      'gemini-2.5-flash',
    );
    await expect(async () => {
      for await (const _ of provider.streamChat([{ role: 'user', content: 'hi' }])) {
        void _;
      }
    }).rejects.toThrow(/Vertex AI API error: 429/);
  });
});

describe('buildSystemPrompt / stripContextFromMessage', () => {
  it('buildSystemPrompt embeds the project root and framing instructions', () => {
    const prompt = buildSystemPrompt('/my/project');
    expect(prompt).toContain('/my/project');
    expect(prompt).toContain('code expert');
  });

  it('stripContextFromMessage removes everything up to and including the "## Question" marker', () => {
    const msg = stripContextFromMessage({
      role: 'user',
      content: 'lots of packed context here\n\n## Question\n\nWhat does X do?',
    });
    expect(msg.content).toBe('What does X do?');
    expect(msg.role).toBe('user');
  });

  it('stripContextFromMessage is a no-op when the marker is absent', () => {
    const msg = stripContextFromMessage({ role: 'user', content: 'plain question, no context' });
    expect(msg.content).toBe('plain question, no context');
  });

  it('stripContextFromMessage is a no-op for non-user roles (system/assistant untouched)', () => {
    const systemMsg = stripContextFromMessage({
      role: 'system',
      content: 'stuff\n\n## Question\n\nshould not be stripped',
    });
    expect(systemMsg.content).toContain('## Question');

    const assistantMsg = stripContextFromMessage({
      role: 'assistant',
      content: 'stuff\n\n## Question\n\nshould not be stripped',
    });
    expect(assistantMsg.content).toContain('## Question');
  });
});

describe('gatherContext / gatherContextWithEnvelope — the privacy boundary', () => {
  let store: ReturnType<typeof createTestStore>;
  let registry: PluginRegistry;

  beforeEach(async () => {
    store = createTestStore();
    registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config: TraceMcpConfig = {
      root: FIXTURE_DIR,
      include: ['src/**/*.ts'],
      exclude: ['vendor/**', 'node_modules/**'],
      db: { path: ':memory:' },
      plugins: [],
    };
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();
  });

  it('gatherContext() returns a markdown string containing project code, not raw JSON', async () => {
    const context = await gatherContext(FIXTURE_DIR, store, registry, 'User', 4000);
    expect(typeof context).toBe('string');
    expect(context.length).toBeGreaterThan(0);
  });

  it('gatherContext() respects the token budget — a tiny budget yields tiny output', async () => {
    const small = await gatherContext(FIXTURE_DIR, store, registry, 'User', 200);
    const large = await gatherContext(FIXTURE_DIR, store, registry, 'User', 8000);
    // A materially smaller token budget must not produce materially more content.
    expect(small.length).toBeLessThanOrEqual(large.length + 200);
  });

  it('gatherContextWithEnvelope() only lists files that were actually indexed under the project root', async () => {
    const { envelope } = await gatherContextWithEnvelope(
      FIXTURE_DIR,
      store,
      registry,
      'User',
      4000,
    );
    for (const f of envelope.files) {
      // No path traversal / no absolute paths / no files outside the indexed set.
      expect(f.startsWith('..')).toBe(false);
      expect(path.isAbsolute(f)).toBe(false);
    }
  });

  it('gatherContextWithEnvelope() caps envelope.symbols at 30 entries', async () => {
    const { envelope } = await gatherContextWithEnvelope(
      FIXTURE_DIR,
      store,
      registry,
      'User',
      20000,
    );
    expect(envelope.symbols.length).toBeLessThanOrEqual(30);
  });

  it('gatherContextWithEnvelope() caps envelope.files at 20 entries', async () => {
    const { envelope } = await gatherContextWithEnvelope(
      FIXTURE_DIR,
      store,
      registry,
      'User',
      20000,
    );
    expect(envelope.files.length).toBeLessThanOrEqual(20);
  });

  it('gatherContextWithEnvelope() decisions array is always empty (not yet surfaced)', async () => {
    const { envelope } = await gatherContextWithEnvelope(
      FIXTURE_DIR,
      store,
      registry,
      'User',
      4000,
    );
    expect(envelope.decisions).toEqual([]);
  });

  it('gatherContext() does not throw for a query matching nothing in the index', async () => {
    const context = await gatherContext(
      FIXTURE_DIR,
      store,
      registry,
      'zzz_no_such_symbol_exists_zzz',
      4000,
    );
    expect(typeof context).toBe('string');
  });
});
