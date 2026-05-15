/**
 * Behavioural coverage for the `check_embedding_drift` MCP tool.
 *
 * IMPL NOTE: `check_embedding_drift` is inline-registered in
 * `src/tools/register/session.ts` and forwards to
 * `checkEmbeddingDrift(embeddingService, opts)` from
 * `src/runtime/embedding-drift.ts`. We assert the underlying contract
 * (same approach as `get-env-vars.behavioural.test.ts`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingService } from '../../../src/ai/interfaces.js';
import { CANARY_STRINGS, checkEmbeddingDrift } from '../../../src/runtime/embedding-drift.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

function makeFakeEmbedding(transform: (text: string) => number[]): EmbeddingService {
  return {
    embed: vi.fn(async (text: string) => transform(text)),
  } as unknown as EmbeddingService;
}

/** Deterministic 3-D hash → stable identity check for the canary set. */
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

describe('check_embedding_drift (checkEmbeddingDrift) — behavioural contract', () => {
  let tmpDir: string;
  let canaryFile: string;

  beforeEach(() => {
    tmpDir = createTmpDir('check-drift-');
    canaryFile = path.join(tmpDir, 'embedding-canary.json');
  });
  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('capture=true on first call writes the baseline and reports status="baseline_captured"', async () => {
    const svc = makeFakeEmbedding((t) => hashEmbedding(t));
    const r = await checkEmbeddingDrift(svc, { filePath: canaryFile, capture: true });
    expect(r.status).toBe('baseline_captured');
    expect(typeof r.message).toBe('string');
    expect(fs.existsSync(canaryFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(canaryFile, 'utf-8')) as { strings: string[] };
    expect(saved.strings).toEqual([...CANARY_STRINGS]);
  });

  it('subsequent call without capture compares vs baseline and returns max_distance + per_string', async () => {
    const svc = makeFakeEmbedding((t) => hashEmbedding(t));
    await checkEmbeddingDrift(svc, { filePath: canaryFile });

    const r = await checkEmbeddingDrift(svc, { filePath: canaryFile });
    expect(r.status).toBe('ok');
    expect(typeof r.max_distance).toBe('number');
    expect(typeof r.mean_distance).toBe('number');
    expect(Array.isArray(r.per_string)).toBe(true);
    expect(r.per_string!.length).toBe(CANARY_STRINGS.length);
    for (const entry of r.per_string!) {
      expect(typeof entry.text).toBe('string');
      expect(typeof entry.distance).toBe('number');
    }
  });

  it('threshold parameter is respected: rotated embeddings above threshold flag drift', async () => {
    // Capture baseline with one transformation.
    const svc1 = makeFakeEmbedding((t) => hashEmbedding(t));
    await checkEmbeddingDrift(svc1, { filePath: canaryFile });

    // Switch to a rotation/perturbation that pushes cosine distance up.
    const svc2 = makeFakeEmbedding((t) => {
      const [a, b, c] = hashEmbedding(t);
      return [-(b ?? 0), a ?? 0, (c ?? 0) * 2];
    });
    const r = await checkEmbeddingDrift(svc2, { filePath: canaryFile, threshold: 0.05 });
    expect(r.status).toBe('drift');
    expect(r.threshold).toBe(0.05);
    expect(r.max_distance).toBeGreaterThan(0.05);
  });

  it('no embedding service yields a clear envelope guiding the caller', async () => {
    const r = await checkEmbeddingDrift(null, { filePath: canaryFile });
    expect(r.status).toBe('no_provider');
    expect(typeof r.message).toBe('string');
    expect(r.message.length).toBeGreaterThan(0);
    // No distance fields should be reported when no provider is available.
    expect(r.max_distance).toBeUndefined();
    expect(r.per_string).toBeUndefined();
  });

  it('output shape: drift report always carries { status, message } plus optional metrics', async () => {
    const svc = makeFakeEmbedding((t) => hashEmbedding(t));
    const captured = await checkEmbeddingDrift(svc, { filePath: canaryFile, capture: true });
    expect(typeof captured.status).toBe('string');
    expect(typeof captured.message).toBe('string');

    const compared = await checkEmbeddingDrift(svc, { filePath: canaryFile });
    expect(typeof compared.status).toBe('string');
    expect(typeof compared.message).toBe('string');
    // When comparing, optional metric fields are present.
    expect('max_distance' in compared).toBe(true);
    expect('mean_distance' in compared).toBe(true);
    expect('per_string' in compared).toBe(true);
  });
});
