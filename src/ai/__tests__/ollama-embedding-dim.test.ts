import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SSRF-guarded fetch so the embedding service never hits the network.
// isExplicitlyLocalUrl is left real (returns true for localhost) — harmless.
const safeFetchMock = vi.fn();
vi.mock('../../utils/ssrf-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/ssrf-guard.js')>();
  return { ...actual, safeFetch: (...args: unknown[]) => safeFetchMock(...args) };
});

// Import after the mock is registered.
const { OllamaProvider } = await import('../ollama.js');

function embedResponse(vectors: number[][]): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ embeddings: vectors }),
  } as unknown as Response;
}

/** A 1024-dim probe vector, mirroring qwen3-embedding:0.6b. */
function vec(dim: number): number[] {
  return Array.from({ length: dim }, (_, i) => (i % 7) * 0.01);
}

describe('OllamaEmbeddingService dimension auto-detection', () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  function makeService(embeddingDimensions?: number) {
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embeddingModel: 'qwen3-embedding:0.6b',
      inferenceModel: 'x',
      fastModel: 'x',
      embeddingDimensions,
    });
    return provider.embedding();
  }

  it('probes and adopts the model real dimension when no explicit dim is configured', async () => {
    // Model returns 1024-dim vectors, not the 768 blanket default.
    safeFetchMock.mockResolvedValue(embedResponse([vec(1024)]));

    const svc = makeService(undefined);
    // Before any call it reports the fallback default.
    expect(svc.dimensions()).toBe(768);

    const detected = await svc.probeDimensions?.();
    expect(detected).toBe(1024);
    // dimensions() now reflects the real, detected value.
    expect(svc.dimensions()).toBe(1024);
    // Only one probe call was made.
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('adopts the real dimension on the first embedBatch when unconfigured', async () => {
    safeFetchMock.mockResolvedValue(embedResponse([vec(1024), vec(1024)]));
    const svc = makeService(undefined);
    expect(svc.dimensions()).toBe(768);

    await svc.embedBatch(['a', 'b']);
    expect(svc.dimensions()).toBe(1024);
  });

  it('trusts an explicit configured dimension and never probes', async () => {
    safeFetchMock.mockResolvedValue(embedResponse([vec(1024)]));
    const svc = makeService(1024);
    expect(svc.dimensions()).toBe(1024);

    // probeDimensions returns the pinned value without a network call.
    const d = await svc.probeDimensions?.();
    expect(d).toBe(1024);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('caches the detected dimension — a second probe issues no new request', async () => {
    safeFetchMock.mockResolvedValue(embedResponse([vec(384)]));
    const svc = makeService(undefined);

    expect(await svc.probeDimensions?.()).toBe(384);
    expect(await svc.probeDimensions?.()).toBe(384);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });
});
