// @ts-nocheck
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'demo-server', version: '1.0.0' });

server.tool('get_user', 'Fetch a user by ID', { id: { type: 'string' } }, async ({ id }) => {
  return { content: [{ type: 'text', text: `User ${id}` }] };
});

server.tool('create_item', 'Create a new item', { name: { type: 'string' } }, async ({ name }) => {
  return { content: [{ type: 'text', text: `Created ${name}` }] };
});

server.resource('config://app', async () => {
  return { contents: [{ uri: 'config://app', text: '{}' }] };
});

server.prompt('code_review', async () => {
  return { messages: [{ role: 'user', content: { type: 'text', text: 'Review this code' } }] };
});

server.prompt('summarize', async () => {
  return { messages: [{ role: 'user', content: { type: 'text', text: 'Summarize' } }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
