/**
 * TRA-951: `get_preset_info` on the daemon path must describe *this* session.
 *
 * Forwarded to the daemon it answered from the daemon's own configuration —
 * reporting `active_preset: minimal, registered_tools: 18` in a session where
 * tools outside `minimal` were answering normally. That is the wrong answer to
 * the one question a user asks when a tool is unexpectedly missing, so the
 * proxy answers it from the session's own filter instead.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../../config.js';
import { createToolFilter } from '../../../server/tool-filter.js';
import { TOOL_PRESETS } from '../../../tools/project/presets.js';
import { ProxyBackend, type ProxyTransport } from '../proxy-backend.js';

const DAEMON_TOOLS = ['search', 'get_symbol', 'get_tests_for', 'get_pagerank', 'get_preset_info'];

/** Stands in for the daemon: full surface on list, echo on call. */
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
            description: `stub ${name}`,
            inputSchema: { type: 'object', properties: {} },
          })),
        },
      } as unknown as JSONRPCMessage);
    } else if (m.method === 'tools/call') {
      this.onmessage?.({
        jsonrpc: '2.0',
        id: m.id,
        result: { content: [{ type: 'text', text: 'daemon answered get_preset_info' }] },
      } as unknown as JSONRPCMessage);
    }
  }
}

const backends: ProxyBackend[] = [];
afterEach(async () => {
  for (const b of backends.splice(0)) await b.stop();
});

async function callPresetInfo(
  config: TraceMcpConfig,
  presetName: string | undefined,
  daemonTools = DAEMON_TOOLS,
): Promise<{ reply: unknown; transport: FakeDaemonTransport }> {
  const transport = new FakeDaemonTransport(daemonTools);
  const toClient: JSONRPCMessage[] = [];
  const backend = new ProxyBackend({
    daemonUrl: 'http://127.0.0.1:0',
    projectRoot: '/nonexistent/fake-project',
    clientId: 'tra-951-test',
    toolFilter: createToolFilter(config),
    presetName,
    transportFactory: () => transport,
  });
  backend.onmessage = (m) => toClient.push(m);
  backends.push(backend);
  await backend.start();
  await backend.send({
    jsonrpc: '2.0',
    id: 42,
    method: 'tools/call',
    params: { name: 'get_preset_info', arguments: {} },
  } as unknown as JSONRPCMessage);
  return { reply: toClient.at(-1), transport };
}

function payload(reply: unknown): Record<string, unknown> {
  const r = reply as { id?: unknown; result?: { content?: Array<{ text?: string }> } };
  expect(r.id).toBe(42);
  return JSON.parse(r.result?.content?.[0]?.text ?? '{}');
}

describe('get_preset_info over the daemon proxy (TRA-951)', () => {
  it("reports the session's preset and surface, not the daemon's", async () => {
    const { reply, transport } = await callPresetInfo(
      { tools: { preset: 'full' } } as TraceMcpConfig,
      'full',
    );
    const info = payload(reply);
    expect(info.active_preset).toBe('full');
    expect(info.tool_names).toContain('get_tests_for');
    expect(info.registered_tools).toBe(DAEMON_TOOLS.length);
    expect(info.deferred_tools).toEqual([]);
    // Answered locally — never forwarded as a tools/call.
    expect(
      transport.forwarded.some((m) => (m as Record<string, unknown>).method === 'tools/call'),
    ).toBe(false);
  });

  it('reports the deferred half for a narrow preset', async () => {
    const { reply } = await callPresetInfo(
      { tools: { preset: 'minimal' } } as TraceMcpConfig,
      'minimal',
    );
    const info = payload(reply);
    expect(info.active_preset).toBe('minimal');
    expect(info.deferred_tools).toContain('get_tests_for');
    expect(info.tool_names).not.toContain('get_tests_for');
    // Sanity: the tool we assert on really is outside `minimal`.
    expect(TOOL_PRESETS.minimal as string[]).not.toContain('get_tests_for');
  });

  it('forwards to the daemon when the catalog is unavailable rather than reporting an empty surface', async () => {
    const { reply, transport } = await callPresetInfo(
      { tools: { preset: 'full' } } as TraceMcpConfig,
      'full',
      [],
    );
    expect(
      transport.forwarded.some((m) => (m as Record<string, unknown>).method === 'tools/call'),
    ).toBe(true);
    const r = reply as { result?: { content?: Array<{ text?: string }> } };
    expect(r.result?.content?.[0]?.text).toBe('daemon answered get_preset_info');
  });
});
