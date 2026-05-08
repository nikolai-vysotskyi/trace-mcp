/**
 * Tests for the one-shot stderr warning before cloud-bound embeddings.
 *
 * The contract is small but easy to break by accident:
 *   - cloud providers warn once per process
 *   - local providers never warn
 *   - TRACE_MCP_ACCEPT_CLOUD_EMBEDDINGS=1 suppresses the warning
 *   - the warning text is informative enough to act on
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetCloudWarningForTests,
  isCloudProvider,
  isLocalProvider,
  warnIfCloudEmbeddingProvider,
} from '../../src/ai/cloud-warning.js';

beforeEach(() => {
  _resetCloudWarningForTests();
});

describe('isCloudProvider / isLocalProvider', () => {
  it.each([
    'openai',
    'gemini',
    'voyage',
    'vertex',
    'minimax',
    'azure-openai',
    'groq',
  ])('recognises %s as cloud', (p) => {
    expect(isCloudProvider(p)).toBe(true);
    expect(isLocalProvider(p)).toBe(false);
  });

  it.each(['ollama', 'onnx', 'fallback'])('recognises %s as local', (p) => {
    expect(isLocalProvider(p)).toBe(true);
    expect(isCloudProvider(p)).toBe(false);
  });

  it('treats unknown providers as neither cloud nor local', () => {
    expect(isCloudProvider('mystery-co')).toBe(false);
    expect(isLocalProvider('mystery-co')).toBe(false);
  });
});

describe('warnIfCloudEmbeddingProvider', () => {
  it('emits a warning the first time for a cloud provider', () => {
    let captured = '';
    const fired = warnIfCloudEmbeddingProvider('openai', {
      env: {} as NodeJS.ProcessEnv,
      write: (msg) => {
        captured = msg;
      },
    });
    expect(fired).toBe(true);
    expect(captured).toContain('openai');
    expect(captured).toContain('TRACE_MCP_ACCEPT_CLOUD_EMBEDDINGS=1');
    expect(captured).toContain('ollama');
  });

  it('is one-shot — second call returns false and does not write', () => {
    const writes: string[] = [];
    const env = {} as NodeJS.ProcessEnv;
    expect(warnIfCloudEmbeddingProvider('openai', { env, write: (m) => writes.push(m) })).toBe(
      true,
    );
    expect(warnIfCloudEmbeddingProvider('voyage', { env, write: (m) => writes.push(m) })).toBe(
      false,
    );
    expect(writes).toHaveLength(1);
  });

  it('TRACE_MCP_ACCEPT_CLOUD_EMBEDDINGS=1 suppresses the warning', () => {
    let fired = false;
    const result = warnIfCloudEmbeddingProvider('openai', {
      env: { TRACE_MCP_ACCEPT_CLOUD_EMBEDDINGS: '1' } as NodeJS.ProcessEnv,
      write: () => {
        fired = true;
      },
    });
    expect(result).toBe(false);
    expect(fired).toBe(false);
  });

  it('does not warn for local providers', () => {
    let fired = false;
    const result = warnIfCloudEmbeddingProvider('ollama', {
      env: {} as NodeJS.ProcessEnv,
      write: () => {
        fired = true;
      },
    });
    expect(result).toBe(false);
    expect(fired).toBe(false);
  });

  it('does not warn for unknown providers (could be self-hosted)', () => {
    let fired = false;
    const result = warnIfCloudEmbeddingProvider('mystery-co', {
      env: {} as NodeJS.ProcessEnv,
      write: () => {
        fired = true;
      },
    });
    expect(result).toBe(false);
    expect(fired).toBe(false);
  });
});
