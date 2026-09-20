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

// TRA-961: the first isAvailable() test does a cold `import('../../src/ai/onnx.js')`,
// which pulls in @huggingface/transformers — a large dependency whose first-import
// cost (~2s uncontended) can exceed vitest's default 10s testTimeout under full-suite
// worker contention. Not a product bug; keep the budget clear of contention.
vi.setConfig({ testTimeout: 30_000 });

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
          return async (_text: string | string[], _opts: unknown) => ({
            data: Float32Array.from(vector),
            dims: [1, vector.length],
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

    it('embedBatch() issues ONE pipeline call for N texts (true batching)', async () => {
      let callCount = 0;
      let seenInput: unknown = null;
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => {
          return async (texts: string | string[]) => {
            callCount += 1;
            seenInput = texts;
            const arr = Array.isArray(texts) ? texts : [texts];
            return {
              data: Float32Array.from(arr.map((t) => t.length)),
              dims: [arr.length, 1],
            };
          };
        }),
      }));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const provider = new OnnxProvider({ dimensions: 10 });
      const result = await provider.embedding().embedBatch(['a', 'bb', 'ccc']);
      expect(result).toEqual([[1], [2], [3]]);
      expect(callCount).toBe(1);
      expect(seenInput).toEqual(['a', 'bb', 'ccc']);
    });

    it('embedBatch() falls back to per-text calls when the batched call throws', async () => {
      let batchCalls = 0;
      let singleCalls = 0;
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => {
          return async (texts: string | string[]) => {
            if (Array.isArray(texts) && texts.length > 1) {
              batchCalls += 1;
              throw new Error('backend rejects batches');
            }
            singleCalls += 1;
            const t = Array.isArray(texts) ? texts[0]! : texts;
            return { data: Float32Array.from([t.length]), dims: [1, 1] };
          };
        }),
      }));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const provider = new OnnxProvider({ dimensions: 10 });
      const result = await provider.embedding().embedBatch(['a', 'bb']);
      expect(result).toEqual([[1], [2]]);
      expect(batchCalls).toBe(1);
      expect(singleCalls).toBe(2);
    });

    it('embedBatch([]) returns [] without touching the pipeline', async () => {
      const pipelineSpy = vi.fn();
      vi.doMock('@huggingface/transformers', () => ({ pipeline: pipelineSpy }));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const provider = new OnnxProvider();
      expect(await provider.embedding().embedBatch([])).toEqual([]);
      expect(pipelineSpy).not.toHaveBeenCalled();
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

  describe('quantization dtype — q8 default, fp32 rollback', () => {
    const OLD_ENV = process.env.TRACE_MCP_ONNX_DTYPE;

    afterEach(() => {
      if (OLD_ENV === undefined) delete process.env.TRACE_MCP_ONNX_DTYPE;
      else process.env.TRACE_MCP_ONNX_DTYPE = OLD_ENV;
    });

    it("passes dtype 'q8' to the pipeline factory by default", async () => {
      delete process.env.TRACE_MCP_ONNX_DTYPE;
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => async () => ({ data: Float32Array.from([1]), dims: [1, 1] })),
      }));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const { pipeline } = await import('@huggingface/transformers');
      await new OnnxProvider().embedding().embed('hello');
      expect(vi.mocked(pipeline).mock.calls[0]?.[2]).toMatchObject({ dtype: 'q8' });
    });

    it('TRACE_MCP_ONNX_DTYPE=fp32 rolls back to full precision', async () => {
      process.env.TRACE_MCP_ONNX_DTYPE = 'fp32';
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => async () => ({ data: Float32Array.from([1]), dims: [1, 1] })),
      }));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const { pipeline } = await import('@huggingface/transformers');
      await new OnnxProvider().embedding().embed('hello');
      expect(vi.mocked(pipeline).mock.calls[0]?.[2]).toMatchObject({ dtype: 'fp32' });
    });

    it('explicit constructor dtype wins over the env var', async () => {
      process.env.TRACE_MCP_ONNX_DTYPE = 'fp32';
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => async () => ({ data: Float32Array.from([1]), dims: [1, 1] })),
      }));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const { pipeline } = await import('@huggingface/transformers');
      await new OnnxProvider({ dtype: 'q4' }).embedding().embed('hello');
      expect(vi.mocked(pipeline).mock.calls[0]?.[2]).toMatchObject({ dtype: 'q4' });
    });

    it('unknown env dtype falls back to q8 instead of crashing model load', async () => {
      process.env.TRACE_MCP_ONNX_DTYPE = 'bf16-plz';
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => async () => ({ data: Float32Array.from([1]), dims: [1, 1] })),
      }));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const { pipeline } = await import('@huggingface/transformers');
      await new OnnxProvider().embedding().embed('hello');
      expect(vi.mocked(pipeline).mock.calls[0]?.[2]).toMatchObject({ dtype: 'q8' });
    });
  });

  describe('ORT arena tuning — mem-pattern off by default, stock rollback (TRA-1608)', () => {
    const OLD_ENV = process.env.TRACE_MCP_ONNX_ARENA;

    afterEach(() => {
      if (OLD_ENV === undefined) delete process.env.TRACE_MCP_ONNX_ARENA;
      else process.env.TRACE_MCP_ONNX_ARENA = OLD_ENV;
    });

    async function embedWithMockedPipeline() {
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const { pipeline } = await import('@huggingface/transformers');
      await new OnnxProvider().embedding().embed('hello');
      return vi.mocked(pipeline).mock.calls[0]?.[2] as Record<string, unknown>;
    }

    function mockPipeline() {
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => async () => ({ data: Float32Array.from([1]), dims: [1, 1] })),
      }));
    }

    it('passes tuned session_options (mem-pattern off) by default', async () => {
      delete process.env.TRACE_MCP_ONNX_ARENA;
      mockPipeline();
      const opts = await embedWithMockedPipeline();
      expect(opts).toMatchObject({
        dtype: 'q8',
        session_options: { enableMemPattern: false },
      });
    });

    it('TRACE_MCP_ONNX_ARENA=default omits session_options (stock ORT rollback)', async () => {
      process.env.TRACE_MCP_ONNX_ARENA = 'default';
      mockPipeline();
      const opts = await embedWithMockedPipeline();
      expect(opts).toMatchObject({ dtype: 'q8' });
      expect(opts).not.toHaveProperty('session_options');
    });

    it('explicit constructor arena wins over the env var', async () => {
      process.env.TRACE_MCP_ONNX_ARENA = 'default';
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => async () => ({ data: Float32Array.from([1]), dims: [1, 1] })),
      }));
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const { pipeline } = await import('@huggingface/transformers');
      await new OnnxProvider({ arena: 'tuned' }).embedding().embed('hello');
      expect(vi.mocked(pipeline).mock.calls[0]?.[2]).toMatchObject({
        session_options: { enableMemPattern: false },
      });
    });

    it('unknown env arena falls back to tuned instead of crashing model load', async () => {
      process.env.TRACE_MCP_ONNX_ARENA = 'kSameAsRequested-plz';
      mockPipeline();
      const opts = await embedWithMockedPipeline();
      expect(opts).toMatchObject({ session_options: { enableMemPattern: false } });
    });

    it('resolveOnnxSessionOptions returns undefined in default mode', async () => {
      const { resolveOnnxSessionOptions, resolveOnnxArenaMode } = await import(
        '../../src/ai/onnx.js'
      );
      delete process.env.TRACE_MCP_ONNX_ARENA;
      expect(resolveOnnxArenaMode()).toBe('tuned');
      expect(resolveOnnxSessionOptions()).toEqual({ enableMemPattern: false });
      expect(resolveOnnxSessionOptions('default')).toBeUndefined();
    });
  });

  describe('E5 prefixes — query:/passage: plumbing (TRA-1539)', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    function mockEchoPipeline() {
      let seenInput: unknown = null;
      vi.doMock('@huggingface/transformers', () => ({
        pipeline: vi.fn(async () => {
          return async (texts: string | string[]) => {
            seenInput = texts;
            const arr = Array.isArray(texts) ? texts : [texts];
            return {
              data: Float32Array.from(arr.map((t) => t.length)),
              dims: [arr.length, 1],
            };
          };
        }),
      }));
      return () => seenInput as string[];
    }

    it('applyE5Prefix: query task → "query: ", document/undefined → "passage: " for E5 models', async () => {
      const { applyE5Prefix, isE5Model } = await import('../../src/ai/onnx.js');
      expect(isE5Model('Xenova/multilingual-e5-small')).toBe(true);
      expect(isE5Model('intfloat/multilingual-e5-small')).toBe(true);
      expect(isE5Model('Xenova/all-MiniLM-L6-v2')).toBe(false);
      expect(applyE5Prefix('Xenova/multilingual-e5-small', 'hello', 'query')).toBe('query: hello');
      expect(applyE5Prefix('Xenova/multilingual-e5-small', 'hello', 'document')).toBe(
        'passage: hello',
      );
      expect(applyE5Prefix('Xenova/multilingual-e5-small', 'hello')).toBe('passage: hello');
      expect(applyE5Prefix('Xenova/all-MiniLM-L6-v2', 'hello', 'query')).toBe('hello');
    });

    it('embedBatch(E5, task=query) prefixes the query; indexing path gets passage:', async () => {
      const getSeen = mockEchoPipeline();
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const svc = new OnnxProvider({
        model: 'Xenova/multilingual-e5-small',
        dimensions: 1,
      }).embedding();
      await svc.embedBatch(['find auth code'], 'query');
      expect(getSeen()).toEqual(['query: find auth code']);
      await svc.embedBatch(['class AuthService'], 'document');
      expect(getSeen()).toEqual(['passage: class AuthService']);
      // embed() forwards its task too (previously it silently dropped it)
      await svc.embed('who handles login', 'query');
      expect(getSeen()).toEqual(['query: who handles login']);
    });

    it('embedBatch(MiniLM, task=query) leaves text untouched — no behavior change', async () => {
      const getSeen = mockEchoPipeline();
      const { OnnxProvider } = await import('../../src/ai/onnx.js');
      const svc = new OnnxProvider().embedding();
      await svc.embedBatch(['find auth code'], 'query');
      expect(getSeen()).toEqual(['find auth code']);
      await svc.embed('who handles login', 'query');
      expect(getSeen()).toEqual(['who handles login']);
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
