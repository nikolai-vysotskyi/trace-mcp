import type { BbPluginApi, PluginAgentToolContext } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { traceHostContract } from './contract.js';

const MAX_RESULT_CHARS = 64_000;
const HOST_CALL_TIMEOUT_MS = 180_000;

export default async function tracePlugin(bb: BbPluginApi): Promise<void> {
  const host = bb.hosts.experimental_client({ contract: traceHostContract });

  async function target(ctx: PluginAgentToolContext) {
    const thread = await bb.sdk.threads.get({ threadId: ctx.threadId, signal: ctx.signal });
    if (thread.environmentId === null)
      throw new Error('Select a bb environment with a repository before using trace-mcp.');
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
      signal: ctx.signal,
    });
    if (environment.path === null)
      throw new Error('The bb environment has no local path for trace-mcp.');
    return { path: environment.path, hostId: environment.hostId };
  }

  async function call(name: string, args: Record<string, unknown>, ctx: PluginAgentToolContext) {
    const { path, hostId } = await target(ctx);
    const result = await host.call(
      'call',
      { path, name, args },
      {
        hostId,
        signal: ctx.signal,
        timeoutMs: HOST_CALL_TIMEOUT_MS,
      },
    );
    return {
      isError: result.isError,
      content: result.content.map((part) =>
        part.type === 'text'
          ? {
              type: 'text' as const,
              text:
                part.text.length > MAX_RESULT_CHARS
                  ? `${part.text.slice(0, MAX_RESULT_CHARS)}\n[trace-mcp result shortened; narrow the query or use pagination]`
                  : part.text,
            }
          : part,
      ),
    };
  }

  bb.agents.registerTool({
    name: 'trace_search',
    description:
      'Search the indexed repository for symbols and relevant code with compact results.',
    instructions: 'Use trace_search to locate code before opening whole files.',
    parameters: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    execute: (args, ctx) => call('search', args, ctx),
  });
  bb.agents.registerTool({
    name: 'trace_get_symbol',
    description:
      'Read the exact indexed definition of a symbol, using its symbol ID or fully qualified name.',
    parameters: z
      .object({
        symbol_id: z.string().optional(),
        fqn: z.string().optional(),
        max_lines: z.number().int().min(1).optional(),
      })
      .refine((v) => Boolean(v.symbol_id || v.fqn)),
    execute: (args, ctx) => call('get_symbol', args, ctx),
  });
  bb.agents.registerTool({
    name: 'trace_get_outline',
    description: 'Get a compact outline of symbols in a repository file.',
    parameters: z.object({ path: z.string().min(1) }),
    execute: (args, ctx) => call('get_outline', args, ctx),
  });
  bb.agents.registerTool({
    name: 'trace_query_decisions',
    description: 'Recall project decisions previously stored by trace-mcp.',
    parameters: z.object({ search: z.string().min(1) }),
    execute: (args, ctx) => call('query_decisions', args, ctx),
  });
  bb.agents.registerTool({
    name: 'trace_tools',
    description:
      'Discover additional trace-mcp tools by name or description without loading its entire catalog into context.',
    parameters: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(30).default(12),
    }),
    async execute({ query, limit }, ctx) {
      const { path, hostId } = await target(ctx);
      const result = await host.call(
        'list',
        { path },
        {
          hostId,
          signal: ctx.signal,
          timeoutMs: HOST_CALL_TIMEOUT_MS,
        },
      );
      const needle = query.toLowerCase();
      const matches = result.tools
        .filter((tool) => `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(needle))
        .slice(0, limit);
      return matches.length === 0
        ? 'No matching trace-mcp tools.'
        : matches.map((tool) => `${tool.name}: ${tool.description ?? ''}`).join('\n');
    },
  });
  bb.agents.registerTool({
    name: 'trace_call',
    description:
      'Call a trace-mcp tool discovered with trace_tools. Supports the complete trace-mcp tool surface.',
    parameters: z.object({
      name: z.string().regex(/^[a-z][a-z0-9_]*$/),
      arguments: z.record(z.string(), z.unknown()).default({}),
    }),
    execute: async ({ name, arguments: args }, ctx) => {
      const { path, hostId } = await target(ctx);
      const available = await host.call(
        'list',
        { path },
        {
          hostId,
          signal: ctx.signal,
          timeoutMs: HOST_CALL_TIMEOUT_MS,
        },
      );
      if (!available.tools.some((tool) => tool.name === name))
        throw new Error(`Unknown trace-mcp tool: ${name}`);
      return call(name, args, ctx);
    },
  });
}
