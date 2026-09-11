import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { stripRedundantSchemaKeyword } from '../schema-shim.js';
import { z } from 'zod';

/** Drives a real tools/list over an in-memory transport pair. */
async function listToolsOverWire(applyShim: boolean) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  server.tool(
    'echo',
    'Echo a string back.',
    { text: z.string().describe('text to echo') },
    async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(applyShim ? stripRedundantSchemaKeyword(serverTransport) : serverTransport),
    client.connect(clientTransport),
  ]);

  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

function fakeTransport() {
  // Keep the spy separate — the shim replaces `transport.send` itself.
  const sent = vi.fn(async (_message: JSONRPCMessage) => {});
  const transport = {
    send: sent,
    start: async () => {},
    close: async () => {},
  } as unknown as Transport;
  return { transport, sent };
}

describe('stripRedundantSchemaKeyword', () => {
  // Premise guard: if a future SDK/zod bump stops stamping $schema, the shim
  // becomes a silent no-op — this test fails loudly instead.
  it('the unpatched SDK still emits $schema on inputSchema and default execution', async () => {
    const tools = await listToolsOverWire(false);
    expect(tools).toHaveLength(1);
    expect(tools[0].inputSchema).toHaveProperty('$schema');
    expect(tools[0].execution).toEqual({ taskSupport: 'forbidden' });
  });

  it('strips $schema and default execution from tools/list end-to-end while keeping the tool usable', async () => {
    const tools = await listToolsOverWire(true);
    expect(tools).toHaveLength(1);
    expect(tools[0].inputSchema).not.toHaveProperty('$schema');
    expect(tools[0]).not.toHaveProperty('execution');
    expect(tools[0].inputSchema.type).toBe('object');
    expect(tools[0].inputSchema.properties).toHaveProperty('text');
    expect(tools[0].description).toBe('Echo a string back.');
  });

  it('strips inputSchema $schema, outputSchema $schema, and default execution in place, leaving everything else intact', async () => {
    const { transport, sent } = fakeTransport();
    const message = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'x',
            inputSchema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
            },
            outputSchema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
            },
            execution: {
              taskSupport: 'forbidden',
            },
          },
          {
            name: 'task-tool',
            inputSchema: { type: 'object' },
            execution: {
              taskSupport: 'required',
            },
          },
        ],
      },
    } as unknown as JSONRPCMessage;

    await stripRedundantSchemaKeyword(transport).send(message);

    // Same object reference must reach the wire — a copy would mean the real
    // message still carries $schema.
    expect(sent.mock.calls[0][0]).toBe(message);
    expect(sent.mock.calls[0][0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
          {
            name: 'task-tool',
            inputSchema: { type: 'object' },
            execution: { taskSupport: 'required' },
          },
        ],
      },
    });
  });

  it('forwards non-tools/list messages unmodified', async () => {
    const { transport, sent } = fakeTransport();
    const wrapped = stripRedundantSchemaKeyword(transport);
    const messages = [
      { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'hi' }] } },
      { jsonrpc: '2.0', id: 3, result: { protocolVersion: '2025-06-18', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'nope' } },
    ] as unknown as JSONRPCMessage[];

    for (const msg of messages) await wrapped.send(msg);

    for (const [i, msg] of messages.entries()) {
      expect(sent.mock.calls[i][0]).toEqual(msg);
    }
  });
});
