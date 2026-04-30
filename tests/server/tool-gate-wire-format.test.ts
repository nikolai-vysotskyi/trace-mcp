import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { installToolGate } from '../../src/server/tool-gate.js';
import { decodeWire } from '../../src/server/wire-format.js';

function createMockServer() {
  const registered: Array<{
    name: string;
    desc?: string;
    schema?: unknown;
    cb?: (...args: unknown[]) => unknown;
  }> = [];
  const server = {
    tool: vi.fn((...args: unknown[]) => {
      const name = args[0] as string;
      const desc = typeof args[1] === 'string' ? (args[1] as string) : undefined;
      const schemaIdx = typeof args[1] === 'string' ? 2 : 1;
      const schema = args.length > schemaIdx + 1 ? args[schemaIdx] : undefined;
      const cb = args[args.length - 1] as (...args: unknown[]) => unknown;
      registered.push({ name, desc, schema, cb });
    }),
  };
  return { server: server as any, registered };
}

function createMockSavings() {
  return {
    recordCall: vi.fn(),
    recordLatency: vi.fn(),
    getLatencyPerTool: vi.fn().mockReturnValue({}),
    getLatencyStats: vi.fn().mockReturnValue(null),
    getSessionStats: vi.fn().mockReturnValue({
      total_calls: 0,
      total_raw_tokens: 0,
      total_tokens_saved: 0,
      total_actual_tokens: 0,
      reduction_pct: 0,
      per_tool: {},
      started_at: new Date().toISOString(),
      latency_per_tool: {},
    }),
  } as any;
}

function createMockJournal() {
  return {
    checkDuplicate: vi.fn().mockReturnValue(null),
    record: vi.fn(),
    recordDedupSaving: vi.fn(),
    getOptimizationHint: vi.fn().mockReturnValue(null),
  } as any;
}

const j = (v: unknown) => JSON.stringify(v);
const extractResultCount = () => 1;
const extractCompactResult = () => undefined;
const stripMetaFields = () => {};

describe('tool-gate wire format integration', () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let savings: ReturnType<typeof createMockSavings>;
  let journal: ReturnType<typeof createMockJournal>;

  beforeEach(() => {
    mockServer = createMockServer();
    savings = createMockSavings();
    journal = createMockJournal();
  });

  function install(config: Partial<TraceMcpConfig> = {}, preset: Set<string> | 'all' = 'all') {
    return installToolGate(
      mockServer.server,
      config as TraceMcpConfig,
      preset,
      savings,
      journal,
      j,
      extractResultCount,
      extractCompactResult,
      stripMetaFields,
    );
  }

  const sampleResponseJson = JSON.stringify({
    items: [
      { file: 'src/services/auth.ts', line: 10, name: 'login', score: 1.5 },
      { file: 'src/services/auth.ts', line: 25, name: 'logout', score: 1.2 },
      { file: 'src/services/auth.ts', line: 40, name: 'verify', score: 0.9 },
      { file: 'src/services/auth.ts', line: 55, name: 'refresh', score: 0.7 },
    ],
    total: 4,
  });

  it('leaves response unchanged when format=json (default)', async () => {
    install({});
    const cb = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: sampleResponseJson }] });
    mockServer.server.tool('search', 'desc', cb);

    const result = await mockServer.registered[0].cb!({ query: 'test' });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe(sampleResponseJson);
  });

  it('re-encodes response to compact when _format=compact is passed', async () => {
    install({});
    const cb = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: sampleResponseJson }] });
    mockServer.server.tool('search', 'desc', cb);

    const result = await mockServer.registered[0].cb!({ query: 'test', _format: 'compact' });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.__wire).toBe('compact-v1');
    // Round-trip back to original.
    expect(decodeWire(text)).toEqual(JSON.parse(sampleResponseJson));
  });

  it('strips _format from params before passing to handler', async () => {
    install({});
    const cb = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: sampleResponseJson }] });
    mockServer.server.tool('search', 'desc', cb);

    await mockServer.registered[0].cb!({ query: 'test', _format: 'compact' });
    const passedParams = cb.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passedParams._format).toBeUndefined();
    expect(passedParams.query).toBe('test');
  });

  it('honors server-wide tools.default_format=compact', async () => {
    install({ tools: { default_format: 'compact' } });
    const cb = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: sampleResponseJson }] });
    mockServer.server.tool('search', 'desc', cb);

    const result = await mockServer.registered[0].cb!({ query: 'test' });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(text).__wire).toBe('compact-v1');
  });

  it('per-call _format=json overrides server default=compact', async () => {
    install({ tools: { default_format: 'compact' } });
    const cb = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: sampleResponseJson }] });
    mockServer.server.tool('search', 'desc', cb);

    const result = await mockServer.registered[0].cb!({ query: 'test', _format: 'json' });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe(sampleResponseJson);
  });

  it('skips compact re-encoding for error responses', async () => {
    install({});
    const errorPayload = JSON.stringify({ error: 'oops' });
    const cb = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: errorPayload }],
      isError: true,
    });
    mockServer.server.tool('search', 'desc', cb);

    const result = await mockServer.registered[0].cb!({ query: 'test', _format: 'compact' });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe(errorPayload);
  });

  it('rejects an unknown _format value (falls back to default)', async () => {
    install({});
    const cb = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: sampleResponseJson }] });
    mockServer.server.tool('search', 'desc', cb);

    await mockServer.registered[0].cb!({ query: 'test', _format: 'gobbledygook' });
    const passedParams = cb.mock.calls[0]?.[0] as Record<string, unknown>;
    // Bogus values are NOT stripped (only the canonical three are extracted).
    expect(passedParams._format).toBe('gobbledygook');
  });
});
