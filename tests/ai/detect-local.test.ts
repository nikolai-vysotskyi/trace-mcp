import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLocalLlm } from '../../src/ai/detect-local.js';

interface ProbeServer {
  port: number;
  close: () => Promise<void>;
}

function startServer(handler: http.RequestListener): Promise<ProbeServer> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        resolve({
          port: addr.port,
          close: () =>
            new Promise<void>((r) => {
              srv.close(() => r());
            }),
        });
      }
    });
  });
}

describe('detectLocalLlm', () => {
  let ollama: ProbeServer;
  let lmStudio: ProbeServer;

  beforeAll(async () => {
    ollama = await startServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'llama3.2' }, { name: 'phi3' }] }));
        return;
      }
      res.writeHead(404).end();
    });
    lmStudio = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
        return;
      }
      res.writeHead(404).end();
    });
  });

  afterAll(async () => {
    await ollama.close();
    await lmStudio.close();
  });

  it('detects an Ollama instance with model list and produces an ollama snippet', async () => {
    const result = await detectLocalLlm({
      endpoints: [
        {
          kind: 'ollama',
          baseUrl: `http://127.0.0.1:${ollama.port}`,
          modelsPath: '/api/tags',
        },
      ],
    });
    expect(result.recommended?.kind).toBe('ollama');
    expect(result.recommended?.models).toContain('llama3.2');
    expect(result.configSnippet).toEqual({
      ai: {
        enabled: true,
        provider: 'ollama',
        ollama: {
          baseUrl: `http://127.0.0.1:${ollama.port}`,
          model: 'llama3.2',
        },
      },
    });
  });

  it('detects an LM Studio instance and produces an OpenAI-compat snippet', async () => {
    const result = await detectLocalLlm({
      endpoints: [
        {
          kind: 'lm-studio',
          baseUrl: `http://127.0.0.1:${lmStudio.port}`,
          modelsPath: '/v1/models',
        },
      ],
    });
    expect(result.recommended?.kind).toBe('lm-studio');
    expect(result.recommended?.models).toEqual(['qwen2.5-7b-instruct']);
    const ai = (result.configSnippet?.ai ?? {}) as { provider: string };
    expect(ai.provider).toBe('openai');
  });

  it('returns no recommendation when nothing is reachable', async () => {
    const result = await detectLocalLlm({
      timeoutMs: 100,
      endpoints: [
        // 127.0.0.255 + a random high port that nothing listens on
        { kind: 'ollama', baseUrl: 'http://127.0.0.255:11999', modelsPath: '/api/tags' },
      ],
    });
    expect(result.recommended).toBeNull();
    expect(result.configSnippet).toBeNull();
    expect(result.probes[0].reachable).toBe(false);
  });

  it('runs probes in parallel — total time is bounded by slowest, not the sum', async () => {
    const startedAt = Date.now();
    await detectLocalLlm({
      timeoutMs: 200,
      endpoints: [
        { kind: 'ollama', baseUrl: 'http://127.0.0.255:11999', modelsPath: '/api/tags' },
        { kind: 'lm-studio', baseUrl: 'http://127.0.0.255:11998', modelsPath: '/v1/models' },
        { kind: 'llama-cpp', baseUrl: 'http://127.0.0.255:11997', modelsPath: '/v1/models' },
      ],
    });
    const elapsed = Date.now() - startedAt;
    // 3 sequential timeouts would be 600ms; parallel should stay close to 200ms.
    expect(elapsed).toBeLessThan(500);
  });

  it('returns first reachable probe when multiple endpoints answer', async () => {
    const result = await detectLocalLlm({
      endpoints: [
        // unreachable first
        { kind: 'ollama', baseUrl: 'http://127.0.0.255:11999', modelsPath: '/api/tags' },
        // reachable second
        {
          kind: 'lm-studio',
          baseUrl: `http://127.0.0.1:${lmStudio.port}`,
          modelsPath: '/v1/models',
        },
      ],
    });
    expect(result.recommended?.kind).toBe('lm-studio');
  });
});
