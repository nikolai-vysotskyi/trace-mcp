import { stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { z } from 'zod';
import { traceHostContract } from './contract.js';

const sessions = new Map<string, Promise<Client>>();
const contentSchema = z.array(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  ]),
);

async function connect(path: string): Promise<Client> {
  if (!sessions.has(path)) {
    const pending = (async () => {
      if (!(await stat(path)).isDirectory())
        throw new Error('bb environment path is not a directory');
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
        cwd: path,
        stderr: 'inherit',
      });
      const client = new Client({ name: 'bb-plugin-trace-mcp', version: '0.2.0' });
      client.onclose = () => sessions.delete(path);
      try {
        await client.connect(transport);
      } catch (error) {
        await Promise.allSettled([client.close()]);
        throw error;
      }
      return client;
    })();
    sessions.set(path, pending);
    pending.catch(() => sessions.delete(path));
  }
  return sessions.get(path)!;
}

export default experimental_defineHostEntry({
  contract: traceHostContract,
  handlers: {
    async call({ path, name, args }, context) {
      const client = await connect(path);
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal: context.signal,
      });
      const content = contentSchema.parse(result.content);
      return { content, isError: result.isError === true };
    },
    async list({ path }) {
      const client = await connect(path);
      const result = await client.listTools();
      return {
        tools: result.tools.map(({ name, description }) => ({
          name,
          ...(description === undefined ? {} : { description }),
        })),
      };
    },
  },
  async dispose() {
    const clients = await Promise.allSettled(sessions.values());
    await Promise.allSettled(
      clients
        .filter((result): result is PromiseFulfilledResult<Client> => result.status === 'fulfilled')
        .map(({ value }) => value.close()),
    );
    sessions.clear();
  },
});
