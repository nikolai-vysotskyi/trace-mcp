import { describe, it, expect } from 'vitest';
import { FallbackProvider } from '../../src/ai/fallback.js';

describe('FallbackProvider', () => {
  it('isAvailable() returns false', async () => {
    const provider = new FallbackProvider();
    expect(await provider.isAvailable()).toBe(false);
  });

  it('embedding().embed() returns empty array', async () => {
    const provider = new FallbackProvider();
    const result = await provider.embedding().embed('test');
    expect(result).toEqual([]);
  });

  it('embedding().embedBatch() returns empty array', async () => {
    const provider = new FallbackProvider();
    const result = await provider.embedding().embedBatch(['a', 'b']);
    expect(result).toEqual([]);
  });

  it('embedding().dimensions() returns 0', () => {
    const provider = new FallbackProvider();
    expect(provider.embedding().dimensions()).toBe(0);
  });

  it('inference().generate() returns empty string', async () => {
    const provider = new FallbackProvider();
    const result = await provider.inference().generate('test prompt');
    expect(result).toBe('');
  });
});
