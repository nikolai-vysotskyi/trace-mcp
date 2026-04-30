import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingService } from '../../src/ai/interfaces.js';
import { CANARY_STRINGS, checkEmbeddingDrift } from '../../src/runtime/embedding-drift.js';

/** Build a fake embedding service that returns deterministic vectors derived from the input string. */
function makeFakeEmbedding(transform: (text: string) => number[]): EmbeddingService {
  return {
    embed: vi.fn(async (text: string) => transform(text)),
  } as unknown as EmbeddingService;
}

/** Hash-into-3D: stable but coarse. Good enough to detect identity and small drifts. */
function hashEmbedding(text: string, scale = 1): number[] {
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a += code;
    b += code * (i + 1);
    c += code * (i + 2);
  }
  return [a * scale, b * scale, c * scale];
}

describe('checkEmbeddingDrift', () => {
  let tmpDir: string;
  let canaryFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-drift-'));
    canaryFile = path.join(tmpDir, 'embedding-canary.json');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns no_provider when embedding service is null', async () => {
    const r = await checkEmbeddingDrift(null, { filePath: canaryFile });
    expect(r.status).toBe('no_provider');
  });

  it('captures a baseline on first run and reports it', async () => {
    const svc = makeFakeEmbedding((t) => hashEmbedding(t));
    const r = await checkEmbeddingDrift(svc, { filePath: canaryFile });
    expect(r.status).toBe('baseline_captured');
    expect(fs.existsSync(canaryFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(canaryFile, 'utf-8')) as { strings: string[] };
    expect(saved.strings).toEqual([...CANARY_STRINGS]);
  });

  it('reports ok when subsequent embeddings match the baseline exactly', async () => {
    const svc = makeFakeEmbedding((t) => hashEmbedding(t));
    await checkEmbeddingDrift(svc, { filePath: canaryFile });

    const r = await checkEmbeddingDrift(svc, { filePath: canaryFile });
    expect(r.status).toBe('ok');
    expect(r.max_distance).toBeLessThan(0.001);
  });

  it('flags drift when embeddings change beyond the threshold', async () => {
    // Capture baseline with one transformation.
    const svc1 = makeFakeEmbedding((t) => hashEmbedding(t));
    await checkEmbeddingDrift(svc1, { filePath: canaryFile });

    // Switch to a transformation that produces meaningfully different vectors
    // (rotated/perturbed enough to push cosine distance above threshold).
    const svc2 = makeFakeEmbedding((t) => {
      const [a, b, c] = hashEmbedding(t);
      return [-(b ?? 0), a ?? 0, (c ?? 0) * 2];
    });
    const r = await checkEmbeddingDrift(svc2, { filePath: canaryFile, threshold: 0.05 });
    expect(r.status).toBe('drift');
    expect(r.max_distance).toBeGreaterThan(0.05);
  });

  it('overwrites baseline when capture=true', async () => {
    const svc1 = makeFakeEmbedding((t) => hashEmbedding(t, 1));
    await checkEmbeddingDrift(svc1, { filePath: canaryFile });
    const before = fs.readFileSync(canaryFile, 'utf-8');

    const svc2 = makeFakeEmbedding((t) => hashEmbedding(t, 2));
    const r = await checkEmbeddingDrift(svc2, { filePath: canaryFile, capture: true });
    expect(r.status).toBe('baseline_captured');
    const after = fs.readFileSync(canaryFile, 'utf-8');
    expect(after).not.toBe(before);
  });

  it('records provider/model identifiers in the baseline', async () => {
    const svc = makeFakeEmbedding((t) => hashEmbedding(t));
    await checkEmbeddingDrift(svc, {
      filePath: canaryFile,
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
    const saved = JSON.parse(fs.readFileSync(canaryFile, 'utf-8')) as {
      provider: string;
      model: string;
    };
    expect(saved.provider).toBe('openai');
    expect(saved.model).toBe('text-embedding-3-small');
  });
});
