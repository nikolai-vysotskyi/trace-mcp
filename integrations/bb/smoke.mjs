import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const client = new Client({ name: 'bb-plugin-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
  args: ['--yes', 'trace-mcp@3.34.8', 'serve', '--preset', 'full'],
  cwd: resolve('../..'),
  stderr: 'pipe',
});
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ['search', 'get_symbol', 'get_outline', 'query_decisions']) {
    if (!names.includes(name)) throw new Error(`Missing ${name}`);
  }
  const result = await client.callTool({ name: 'get_outline', arguments: { path: 'src/cli.ts' } });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  console.log(JSON.stringify({ toolCount: names.length, outline: 'ok' }));
} finally {
  await client.close();
}
