/**
 * Regression guard for TRA-250: the tool preset must survive the daemon proxy.
 *
 * The registration-time gate (tool-gate.ts) was already correct and already
 * guarded by tool-schema-budget.test.ts — and the shipped default path
 * (daemon-backed) still advertised all 172 tools regardless of preset, because
 * the daemon registers every tool once and serves many sessions. So this suite
 * asserts on the surface that actually reaches a client: the `tools/list`
 * response after it has passed through ProxyBackend, plus the callability of a
 * tool the preset filtered out.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../../config.js';
import { createToolFilter, UNGATED_META_TOOLS } from '../../../server/tool-filter.js';
import { TOOL_PRESETS } from '../../../tools/project/presets.js';
import { ProxyBackend, type ProxyTransport } from '../proxy-backend.js';

/** Every tool name the daemon would advertise — presets are subsets of this. */
function allDaemonToolNames(): string[] {
  const registerDir = fileURLToPath(new URL('../../../tools/register', import.meta.url));
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      for (const m of readFileSync(full, 'utf8').matchAll(
        /(?:server\.tool|_originalTool)\(\s*['"]([a-zA-Z0-9_]+)['"]/g,
      )) {
        names.add(m[1]);
      }
    }
  };
  walk(registerDir);
  return [...names];
}

/** Stands in for the daemon: answers tools/list with its full tool surface. */
class FakeDaemonTransport implements ProxyTransport {
  onmessage?: (msg: JSONRPCMessage) => void;
  onerror?: (err: Error) => void;
  readonly forwarded: JSONRPCMessage[] = [];

  constructor(private readonly toolNames: string[]) {}

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  async send(msg: JSONRPCMessage): Promise<void> {
    this.forwarded.push(msg);
    const m = msg as Record<string, unknown>;
    if (m.method === 'tools/list') {
      this.onmessage?.({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          tools: this.toolNames.map((name) => ({
            name,
            description: `stub description for ${name}`,
            inputSchema: { type: 'object', properties: {} },
          })),
        },
      } as unknown as JSONRPCMessage);
    } else if (m.method === 'tools/call') {
      this.onmessage?.({
        jsonrpc: '2.0',
        id: m.id,
        result: { content: [{ type: 'text', text: 'daemon executed the tool' }] },
      } as unknown as JSONRPCMessage);
    }
  }
}

const DAEMON_TOOLS = allDaemonToolNames();

const backends: ProxyBackend[] = [];
afterEach(async () => {
  for (const b of backends.splice(0)) await b.stop();
  delete process.env.TRACE_MCP_PRESET;
});

async function startProxy(
  config: TraceMcpConfig,
): Promise<{ backend: ProxyBackend; transport: FakeDaemonTransport; toClient: JSONRPCMessage[] }> {
  const transport = new FakeDaemonTransport(DAEMON_TOOLS);
  const toClient: JSONRPCMessage[] = [];
  const backend = new ProxyBackend({
    daemonUrl: 'http://127.0.0.1:0',
    projectRoot: '/nonexistent/fake-project',
    clientId: 'tra-250-test',
    toolFilter: createToolFilter(config),
    transportFactory: () => transport,
  });
  backend.onmessage = (m) => toClient.push(m);
  backends.push(backend);
  await backend.start();
  return { backend, transport, toClient };
}

async function proxiedToolNames(config: TraceMcpConfig): Promise<string[]> {
  const { backend, toClient } = await startProxy(config);
  await backend.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage);
  const reply = toClient.at(-1) as { result?: { tools?: Array<{ name: string }> } };
  return (reply.result?.tools ?? []).map((t) => t.name);
}

describe('daemon proxy honours the session tool preset (TRA-250)', () => {
  it('the fake daemon advertises the full surface these presets are subsets of', () => {
    expect(DAEMON_TOOLS.length).toBeGreaterThan(150);
  });

  for (const preset of ['minimal', 'standard', 'review', 'architecture'] as const) {
    it(`filters the proxied tools/list down to the "${preset}" preset`, async () => {
      const names = await proxiedToolNames({ tools: { preset } } as TraceMcpConfig);
      const expected = new Set([...(TOOL_PRESETS[preset] as string[]), ...UNGATED_META_TOOLS]);
      const unexpected = names.filter((n) => !expected.has(n));
      expect(
        unexpected,
        `Tools leaked past the "${preset}" preset: ${unexpected.join(', ')}`,
      ).toEqual([]);
      expect(names.length).toBeLessThan(DAEMON_TOOLS.length);
    });
  }

  it('passes the full surface through untouched for the "full" preset', async () => {
    const names = await proxiedToolNames({ tools: { preset: 'full' } } as TraceMcpConfig);
    expect(names.length).toBe(DAEMON_TOOLS.length);
  });

  it('applies the shipped default (minimal) when no preset is configured', async () => {
    // The default moved standard → minimal in TRA-402, once load_tools made
    // everything outside the preset one call away instead of gone for good.
    const names = await proxiedToolNames({} as TraceMcpConfig);
    const expected = new Set([...(TOOL_PRESETS.minimal as string[]), ...UNGATED_META_TOOLS]);
    expect(names.filter((n) => !expected.has(n))).toEqual([]);
    // The whole point of the issue: the default must not be the full surface.
    expect(names.length).toBeLessThan(DAEMON_TOOLS.length / 4);
    expect(names, 'the default surface must carry its own escape hatch').toContain('load_tools');
  });

  it('lets TRACE_MCP_PRESET override the config on the proxied path', async () => {
    process.env.TRACE_MCP_PRESET = 'minimal';
    const names = await proxiedToolNames({ tools: { preset: 'full' } } as TraceMcpConfig);
    const expected = new Set([...(TOOL_PRESETS.minimal as string[]), ...UNGATED_META_TOOLS]);
    expect(names.filter((n) => !expected.has(n))).toEqual([]);
  });

  it('honours tools.exclude and tools.include over the preset', async () => {
    const names = await proxiedToolNames({
      tools: { preset: 'minimal', include: ['get_pagerank'], exclude: ['search_text'] },
    } as TraceMcpConfig);
    expect(names).toContain('get_pagerank');
    expect(names).not.toContain('search_text');
  });

  it('keeps a filtered-out tool genuinely uncallable, not merely hidden', async () => {
    const { backend, transport, toClient } = await startProxy({
      tools: { preset: 'standard' },
    } as TraceMcpConfig);
    await backend.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'get_pagerank', arguments: {} },
    } as unknown as JSONRPCMessage);

    const reply = toClient.at(-1) as { id?: unknown; error?: { code: number; message: string } };
    expect(reply.id).toBe(7);
    expect(reply.error?.code).toBe(-32601);
    expect(reply.error?.message).toContain('get_pagerank');
    // Never reached the daemon — hiding a tool while still executing it would
    // leave the token win without the behavioural guarantee.
    expect(
      transport.forwarded.some((m) => (m as { method?: string }).method === 'tools/call'),
    ).toBe(false);
  });

  it('still forwards a permitted tools/call to the daemon', async () => {
    const { backend, transport, toClient } = await startProxy({
      tools: { preset: 'standard' },
    } as TraceMcpConfig);
    await backend.send({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'x' } },
    } as unknown as JSONRPCMessage);
    expect(
      transport.forwarded.some((m) => (m as { method?: string }).method === 'tools/call'),
    ).toBe(true);
    expect((toClient.at(-1) as { error?: unknown }).error).toBeUndefined();
  });
});

describe('proxied tools/list token budget (TRA-250)', () => {
  // Serialized-char ceilings on the *proxied* surface, measured against the
  // real presets. The registration-time budget in tool-schema-budget.test.ts
  // was green throughout the regression this suite exists to catch, because it
  // never looked at what a daemon-backed client actually receives.
  //
  // Real measurement (2026-08-28, v1.51.0 daemon + `dist/cli.js serve`):
  // minimal 32,914 chars / ~9.1k tokens, standard 68,818 / ~19.1k,
  // full 187,790 / ~52.2k. This suite's stub descriptions are far smaller, so
  // it asserts on tool *counts* — the ratio that produced those numbers —
  // rather than re-deriving char totals from fake prose.
  const PRESET_MAX_TOOLS: Record<string, number> = { minimal: 30, standard: 60 };

  for (const [preset, max] of Object.entries(PRESET_MAX_TOOLS)) {
    it(`keeps the proxied "${preset}" surface at or under ${max} tools`, async () => {
      const names = await proxiedToolNames({ tools: { preset } } as TraceMcpConfig);
      expect(
        names.length,
        `The proxied "${preset}" surface grew to ${names.length} tools. Every tool here is ` +
          'paid in tools/list schema tokens by every session on the default daemon path (TRA-250).',
      ).toBeLessThanOrEqual(max);
    });
  }
});

describe('daemon proxy answers load_tools locally (TRA-402)', () => {
  /**
   * The daemon serves one full surface to every session, so a forwarded
   * `load_tools` would report "nothing is deferred" and escalation would
   * silently do nothing on the shipped path. These assert the proxy handles it
   * itself and that the escalation actually widens what the client can see.
   */
  async function startEscalatingProxy(config: TraceMcpConfig) {
    const transport = new FakeDaemonTransport(DAEMON_TOOLS);
    const toClient: JSONRPCMessage[] = [];
    const loaded = new Set<string>();
    const base = createToolFilter(config);
    const backend = new ProxyBackend({
      daemonUrl: 'http://127.0.0.1:0',
      projectRoot: '/nonexistent/fake-project',
      clientId: 'tra-402-test',
      toolFilter: (name) => base(name) || loaded.has(name),
      toolSurface: {
        isExcluded: (name) => (config.tools?.exclude ?? []).includes(name),
        load: (names) => {
          for (const n of names) loaded.add(n);
        },
      },
      transportFactory: () => transport,
    });
    backend.onmessage = (m) => toClient.push(m);
    backends.push(backend);
    await backend.start();

    let id = 0;
    const listTools = async (): Promise<string[]> => {
      await backend.send({
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/list',
        params: {},
      } as JSONRPCMessage);
      const reply = toClient.at(-1) as { result?: { tools?: Array<{ name: string }> } };
      return (reply.result?.tools ?? []).map((t) => t.name);
    };
    const loadTools = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      await backend.send({
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/call',
        params: { name: 'load_tools', arguments: args },
      } as unknown as JSONRPCMessage);
      const reply = toClient.at(-1) as { result?: { content?: Array<{ text: string }> } };
      return JSON.parse(reply.result?.content?.[0]?.text ?? '{}');
    };
    return { backend, transport, toClient, listTools, loadTools };
  }

  const minimalConfig = { tools: { preset: 'minimal' } } as TraceMcpConfig;

  it('never forwards load_tools to the daemon', async () => {
    const p = await startEscalatingProxy(minimalConfig);
    await p.listTools();
    await p.loadTools({ tools: ['get_pagerank'] });
    expect(
      p.transport.forwarded.some(
        (m) =>
          (m as { method?: string }).method === 'tools/call' &&
          ((m as { params?: { name?: string } }).params?.name ?? '') === 'load_tools',
      ),
    ).toBe(false);
  });

  it('widens the proxied tools/list after a load', async () => {
    const p = await startEscalatingProxy(minimalConfig);
    expect(await p.listTools()).not.toContain('get_pagerank');
    const result = await p.loadTools({ tools: ['get_pagerank'] });
    expect(result.loaded).toEqual(['get_pagerank']);
    expect(await p.listTools()).toContain('get_pagerank');
  });

  it('makes a loaded tool callable, where it was rejected before', async () => {
    const p = await startEscalatingProxy(minimalConfig);
    await p.listTools();
    await p.loadTools({ tools: ['get_pagerank'] });
    await p.backend.send({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'get_pagerank', arguments: {} },
    } as unknown as JSONRPCMessage);
    expect((p.toClient.at(-1) as { error?: unknown }).error).toBeUndefined();
  });

  it('pushes notifications/tools/list_changed at the client, once per load', async () => {
    const p = await startEscalatingProxy(minimalConfig);
    await p.listTools();
    await p.loadTools({ preset: 'architecture' });
    const notifications = p.toClient.filter(
      (m) => (m as { method?: string }).method === 'notifications/tools/list_changed',
    );
    expect(notifications).toHaveLength(1);
  });

  it('returns the loaded tools schemas so a client ignoring the notification can still use them', async () => {
    const p = await startEscalatingProxy(minimalConfig);
    await p.listTools();
    const result = (await p.loadTools({ tools: ['get_pagerank'] })) as {
      tools: Array<{ name: string; description?: string; input_schema?: unknown }>;
      hint?: string;
    };
    expect(result.tools[0]).toMatchObject({ name: 'get_pagerank' });
    expect(result.tools[0].input_schema).toBeDefined();
    expect(result.hint).toContain('batch');
  });

  it('lists the deferred surface when called with no arguments', async () => {
    const p = await startEscalatingProxy(minimalConfig);
    await p.listTools();
    const result = (await p.loadTools({})) as { deferred_tools: string[] };
    expect(result.deferred_tools).toContain('get_pagerank');
    expect(result.deferred_tools).not.toContain('search');
  });

  it('refuses to escalate a tools.exclude entry', async () => {
    const p = await startEscalatingProxy({
      tools: { preset: 'minimal', exclude: ['get_pagerank'] },
    } as TraceMcpConfig);
    await p.listTools();
    const result = await p.loadTools({ preset: 'full' });
    expect(result.blocked).toEqual(['get_pagerank']);
    expect(await p.listTools()).not.toContain('get_pagerank');
  });

  it('lists the deferred surface even when no tools/list came through this backend', async () => {
    // The swap case (session starts local, router moves it to the proxy): the
    // client already listed tools through the *other* backend, so the proxy
    // never saw a tools/list and reported an empty catalog — the discovery half
    // of progressive disclosure silently gone (TRA-675). It primes itself now.
    const p = await startEscalatingProxy(minimalConfig);
    const result = (await p.loadTools({})) as { deferred_tools: string[] };
    expect(result.deferred_tools.length).toBeGreaterThan(100);
    expect(result.deferred_tools).toContain('get_pagerank');
    expect(result.deferred_tools).not.toContain('search');
  });

  it('swallows a prime reply that arrives after its own timeout', async () => {
    // The prime is answered on a race with a 5s timeout. A reply that loses
    // that race still arrives eventually, and the client never sent the
    // request it answers — forwarding it hands the MCP host a response with an
    // id it cannot match. Recognised by id prefix, not by a live pending entry.
    const p = await startEscalatingProxy(minimalConfig);
    await p.loadTools({});
    const primeId = p.transport.forwarded
      .map((m) => (m as { id?: unknown }).id)
      .find((id) => typeof id === 'string' && id.startsWith('__trace_prime_tools_list_'));
    expect(primeId, 'the proxy should have primed itself').toBeDefined();

    const before = p.toClient.length;
    p.transport.onmessage?.({
      jsonrpc: '2.0',
      id: primeId,
      result: { tools: [{ name: 'search' }] },
    } as unknown as JSONRPCMessage);
    expect(p.toClient.length, 'a late prime reply must not reach the client').toBe(before);
  });

  it('passes toolSurface when constructing ProxyBackend, or escalation is dead on the shipped path', () => {
    const src = readFileSync(fileURLToPath(new URL('../session.ts', import.meta.url)), 'utf8');
    const ctor = src.slice(src.indexOf('new ProxyBackend('));
    expect(ctor.slice(0, ctor.indexOf('});'))).toContain('toolSurface:');
  });
});

describe('StdioSession wires the filter into every proxy backend (TRA-250)', () => {
  // The original regression was not a broken filter — it was the absence of
  // one on the shipped path. A ProxyBackend constructed without `toolFilter`
  // forwards the daemon's full surface, and every test above would still pass.
  // Source-level assertion because buildProxyBackend is private and the real
  // path needs a live daemon.
  it('passes toolFilter when constructing ProxyBackend', () => {
    const src = readFileSync(fileURLToPath(new URL('../session.ts', import.meta.url)), 'utf8');
    const ctor = src.slice(src.indexOf('new ProxyBackend('));
    expect(ctor.slice(0, ctor.indexOf('});')), 'session.ts must pass toolFilter').toContain(
      'toolFilter:',
    );
  });
});

describe('the router preset and batch-as-door (TRA-675)', () => {
  const routerConfig = { tools: { preset: 'router' } } as TraceMcpConfig;

  it('advertises exactly the ungated meta-tools and nothing else', async () => {
    const names = await proxiedToolNames(routerConfig);
    expect([...names].sort()).toEqual([...UNGATED_META_TOOLS].sort());
  });

  it('forwards a batch whose inner call is outside the preset', async () => {
    // This is what makes an empty preset usable rather than crippled: the
    // filter applies to the outer tool name, so `batch` reaches the daemon's
    // full registry with no escalation round-trip. Deliberate, not accidental.
    const { backend, transport, toClient } = await startProxy(routerConfig);
    await backend.send({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'batch', arguments: { calls: [{ tool: 'get_circular_imports', args: {} }] } },
    } as unknown as JSONRPCMessage);
    expect(
      transport.forwarded.some((m) => (m as { method?: string }).method === 'tools/call'),
    ).toBe(true);
    expect((toClient.at(-1) as { error?: unknown }).error).toBeUndefined();
  });

  it('rejects a batch whose inner call is excluded by config, without forwarding it', async () => {
    // A preset is a deferral; `tools.exclude` is a restriction. It has to hold
    // through every door, so the proxy reads the inner names for this one case.
    const transport = new FakeDaemonTransport(DAEMON_TOOLS);
    const toClient: JSONRPCMessage[] = [];
    const config = {
      tools: { preset: 'router', exclude: ['get_circular_imports'] },
    } as TraceMcpConfig;
    const backend = new ProxyBackend({
      daemonUrl: 'http://127.0.0.1:0',
      projectRoot: '/nonexistent/fake-project',
      clientId: 'tra-675-test',
      toolFilter: createToolFilter(config),
      toolSurface: {
        isExcluded: (name) => (config.tools?.exclude ?? []).includes(name),
        load: () => undefined,
      },
      transportFactory: () => transport,
    });
    backend.onmessage = (m) => toClient.push(m);
    backends.push(backend);
    await backend.start();

    await backend.send({
      jsonrpc: '2.0',
      id: 43,
      method: 'tools/call',
      params: {
        name: 'batch',
        arguments: {
          calls: [
            { tool: 'search', args: { query: 'x' } },
            { tool: 'get_circular_imports', args: {} },
          ],
        },
      },
    } as unknown as JSONRPCMessage);

    const reply = toClient.at(-1) as { id?: unknown; error?: { code: number; message: string } };
    expect(reply.id).toBe(43);
    expect(reply.error?.message).toContain('get_circular_imports');
    expect(
      transport.forwarded.some((m) => (m as { method?: string }).method === 'tools/call'),
      'an excluded tool must never reach the daemon, not even wrapped in a batch',
    ).toBe(false);
  });
});

describe('ungated meta-tool list stays in sync with session.ts (TRA-250)', () => {
  it('matches the tools registered through _originalTool', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../tools/register/session.ts', import.meta.url)),
      'utf8',
    );
    const registered = new Set(
      [...src.matchAll(/_originalTool\(\s*['"]([a-zA-Z0-9_]+)['"]/g)].map((m) => m[1]),
    );
    expect(
      [...registered].sort(),
      'Tools registered outside the preset gate must be listed in UNGATED_META_TOOLS, ' +
        'or the daemon-backed surface will differ from the local one for the same preset.',
    ).toEqual([...UNGATED_META_TOOLS].sort());
  });
});
