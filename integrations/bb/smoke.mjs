import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const client = new Client({ name: 'bb-plugin-smoke', version: '0.1.0' });
const windows = process.platform === 'win32';
const transport = new StdioClientTransport({
  command: windows ? 'cmd.exe' : 'npm',
  args: [
    ...(windows ? ['/d', '/s', '/c', 'npm'] : []),
    'exec',
    '--yes',
    '--package=trace-mcp@3.34.8',
    '--',
    'trace-mcp',
    'serve',
    '--preset',
    'full',
  ],
  cwd: resolve('../..'),
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (chunk) => {
  stderr = `${stderr}${String(chunk)}`.slice(-2000);
});
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ['search', 'get_symbol', 'get_outline', 'query_decisions']) {
    if (!names.includes(name)) throw new Error(`Missing ${name}`);
  }
  const result = await client.callTool({ name: 'get_outline', arguments: { path: 'src/cli.ts' } });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const health = await client.callTool({ name: 'get_index_health', arguments: {} });
  if (health.isError || typeof JSON.parse(health.content[0].text).stats?.totalFiles !== 'number') {
    throw new Error('get_index_health did not return index statistics');
  }
  const decisions = await client.callTool({
    name: 'query_decisions',
    arguments: { limit: 1, index_only: true, verify: false },
  });
  if (decisions.isError || !Array.isArray(JSON.parse(decisions.content[0].text).decisions)) {
    throw new Error('query_decisions did not return a decision list');
  }
  console.log(JSON.stringify({ outline: 'ok', indexHealth: 'ok', decisions: 'ok' }));
} catch (error) {
  throw new Error(`MCP smoke failed: ${stderr}`, { cause: error });
} finally {
  await client.close();
}
