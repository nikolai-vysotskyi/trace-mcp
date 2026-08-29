/**
 * Retired-tool hints (TRA-412).
 *
 * The behaviour that matters is on the wire: calling a name retired in v2.0.0
 * must come back naming its replacement, while an ordinary typo must keep the
 * SDK's message and every live tool must stay callable. So this drives a real
 * McpServer + Client pair rather than calling the wrapper directly.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { installRetiredToolHints, RETIRED_TOOL_REPLACEMENTS } from '../retired-tools.js';

async function harness() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  server.tool('search', 'Run search.', { q: z.string() }, async () => ({
    content: [{ type: 'text' as const, text: 'search ran' }],
  }));
  installRetiredToolHints(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

/** The error text the SDK surfaces for a failed tools/call. */
async function callError(client: Client, name: string): Promise<string> {
  try {
    const res = await client.callTool({ name, arguments: {} });
    return (res.content as Array<{ text: string }>)[0]?.text ?? '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('retired-tool hints (TRA-412)', () => {
  it('names the replacement for every tool retired in v2.0.0', async () => {
    const { client } = await harness();
    for (const [retired, replacement] of Object.entries(RETIRED_TOOL_REPLACEMENTS)) {
      const text = await callError(client, retired);
      expect(text, retired).toContain(`Tool ${retired} was removed in trace-mcp v2.0.0`);
      expect(text, retired).toContain(replacement);
    }
    await client.close();
  });

  it('leaves an ordinary unknown name on the SDK message', async () => {
    const { client } = await harness();
    expect(await callError(client, 'get_dead_exprots')).toMatch(/get_dead_exprots not found/);
    await client.close();
  });

  it('does not disturb a live tool', async () => {
    const { client } = await harness();
    const res = await client.callTool({ name: 'search', arguments: { q: 'x' } });
    expect((res.content as Array<{ text: string }>)[0].text).toBe('search ran');
    await client.close();
  });

  it('keeps the retired names off tools/list, so the schema saving stands', async () => {
    const { client } = await harness();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['search']);
    await client.close();
  });
});
