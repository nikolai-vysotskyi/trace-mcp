import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OnnxProvider tests.
 *
 * `@huggingface/transformers` is a real dependency of this repo (see
 * package.json), so `isAvailable()` genuinely resolves the import without
 * any network call — that's exercised directly, no mocking needed.
 *
 * For `embed()`/`embedBatch()` we must NOT let the real pipeline run: it
 * would download an ONNX model from the network on first use. We mock the
 * `@huggingface/transformers` module and reset the module registry between
 * tests, since `onnx.ts` caches the loaded pipeline in a module-level
 * singleton (`pipelineInstance`/`pipelineModel`) that would otherwise leak
 * across tests.
 */
describe('OnnxProvider', () => {
  afterEach(() => {
    vi.doUnmock('@huggingface/transformers');
    vi.resetModules();
  });

  describe('isAvailable() — real import, no network', () => {
    it('returns true because @huggingface/transformers is an installed dependency', async () => {
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const provider = new OnnxProvider();
      expect(await provider.isAvailable()).toBe(true);
    });

    it('isOnnxAvailable() standalone helper agrees', async () => {
      const { isOnnxAvailable } = await import('../../src/ai/onnx.js');
      expect(await isOnnxAvailable()).toBe(true);
    });
  });

  describe('embedding() — mocked pipeline, no real model download', () => {
    function mockPipeline(vector: number[]) {
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => {
          return async (_text: string, _opts: unknown) => ({
            data: Float32Array.from(vector),
          });
        }),
      }));
    }

    beforeEach(() => {
      vi.resetModules();
    });

    it('returns a vector truncated to the configured dimensions', async () => {
      mockPipeline([1, 2, 3, 4, 5]);
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const provider = new OnnxProvider({ dimensions: 3 });
      const result = await provider.embedding().embed('hello world');
      expect(result).toEqual([1, 2, 3]);
    });

    it('embedBatch() calls the pipeline once per text and preserves order', async () => {
      let callCount = 0;
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => {
          return async (text: string) => {
            callCount += 1;
            return { data: Float32Array.from([text.length]) };
          };
        }),
      }));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const provider = new OnnxProvider({ dimensions: 10 });
      const result = await provider.embedding().embedBatch(['a', 'bb', 'ccc']);
      expect(result).toEqual([[1], [2], [3]]);
      expect(callCount).toBe(3);
    });

    it('embedBatch() stops early when the abort signal is already aborted', async () => {
      let callCount = 0;
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => {
          return async () => {
            callCount += 1;
            return { data: Float32Array.from([1]) };
          };
        }),
      }));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const provider = new OnnxProvider({ dimensions: 1 });
      const controller = new AbortController();
      controller.abort();
      const result = await provider
        .embedding()
        .embedBatch(['a', 'b', 'c'], undefined, controller.signal);
      expect(result).toEqual([]);
      expect(callCount).toBe(0);
    });

    it('uses default dimensions (384) when no config is passed', async () => {
      mockPipeline(Array.from({ length: 800 }, (_, i) => i));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const provider = new OnnxProvider();
      const result = await provider.embedding().embed('x');
      expect(result).toHaveLength(384);
    });

    it('dimensions()/modelName()/providerName() reflect configured values', async () => {
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const provider = new OnnxProvider({ model: 'custom/model', dimensions: 42 });
      const svc = provider.embedding();
      expect(svc.dimensions()).toBe(42);
      expect(svc.modelName()).toBe('custom/model');
      expect(svc.providerName()).toBe('onnx');
    });
  });

  describe('inference() — embedding-only provider, documented FallbackProvider delegation', () => {
    it('inference() returns a FallbackProvider inference service (not a real ONNX call)', async () => {
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const { FallbackProvider } = await import('../../src/ai/fallback.js');
      const provider = new OnnxProvider();
      const fallback = new FallbackProvider();

      // Behavioral equivalence check (constructors differ per-call so we
      // can't assert instance identity) — same documented no-op contract:
      // generate() returns a fixed message without calling any model.
      const onnxResult = await provider.inference().generate('anything');
      const fallbackResult = await fallback.inference().generate('anything');
      expect(onnxResult).toBe(fallbackResult);
    });

    it('fastInference() also delegates to FallbackProvider (embedding-only contract)', async () => {
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const { FallbackProvider } = await import('../../src/ai/fallback.js');
      const provider = new OnnxProvider();
      const fallback = new FallbackProvider();

      const onnxResult = await provider.fastInference().generate('anything');
      const fallbackResult = await fallback.fastInference().generate('anything');
      expect(onnxResult).toBe(fallbackResult);
    });

    it('inference()/fastInference() do not touch the transformers pipeline', async () => {
      const pipelineSpy = vi.fn();
      vi.doMock('@huggingface/transformers', () => ({ pipeline: pipelineSpy }));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const provider = new OnnxProvider();
      await provider.inference().generate('ping');
      await provider.fastInference().generate('ping');
      expect(pipelineSpy).not.toHaveBeenCalled();
    });
  });
});

describe('createAIProvider — onnx wiring', () => {
  it('constructs an onnx provider without requiring an api key or consent', async () => {
    const { createAIProvider } = await import('../../src/ai/index.js');
    const { FallbackProvider } = await import('../../src/ai/fallback.js');
    const provider = createAIProvider({
      root: '.',
      include: [],
      exclude: [],
      db: { path: ':memory:' },
      plugins: [],
      ai: { enabled: true, provider: 'onnx' },
    });
    expect(provider).not.toBeInstanceOf(FallbackProvider);
    expect(provider.embedding).toBeDefined();
  });

  it('passes embedding_model / embedding_dimensions through to OnnxProvider', async () => {
    const { createAIProvider } = await import('../../src/ai/index.js');
    const provider = createAIProvider({
      root: '.',
      include: [],
      exclude: [],
      db: { path: ':memory:' },
      plugins: [],
      ai: {
        enabled: true,
        provider: 'onnx',
        embedding_model: 'custom/onnx-model',
        embedding_dimensions: 384,
      },
    });
    const svc = provider.embedding();
    expect(svc.dimensions()).toBe(384);
    expect(svc.modelName()).toBe('custom/onnx-model');
  });
});
