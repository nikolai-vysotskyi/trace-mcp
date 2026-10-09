import {
  cliCommand,
  defineCli,
  PluginCliError,
  type BbPluginApi,
  type PluginAgentToolContext,
  type PluginCliContext,
} from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { traceHostContract } from './contract.js';
import { decisionTypeSchema, traceUiRpcContract } from './ui-contract.js';

const MAX_RESULT_CHARS = 64_000;
const HOST_CALL_TIMEOUT_MS = 180_000;
const indexPayloadSchema = z
  .object({
    status: z.string().optional(),
    stats: z
      .object({ totalFiles: z.number().optional(), totalSymbols: z.number().optional() })
      .passthrough()
      .optional(),
    warnings: z.array(z.unknown()).optional(),
  })
  .passthrough();
const decisionsPayloadSchema = z
  .object({
    decisions: z.array(
      z
        .object({
          id: z.union([z.string(), z.number()]),
          title: z.string(),
          type: z.string(),
          summary: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function toolPayload(result: {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
}): unknown {
  const text = result.content.find((part) => part.type === 'text')?.text;
  if (text === undefined) throw new Error('trace-mcp returned no text result');
  if (result.isError) throw new Error(text.slice(0, 500));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('trace-mcp returned a non-JSON result');
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function displayHealthWarning(warning: string): string {
  if (warning.startsWith('Semantic search is disabled')) {
    return 'Semantic search is off. Indexed text search remains available.';
  }
  if (warning.startsWith('The OS dropped file-system events')) {
    return 'Recent file changes may be temporarily behind. Reindex if results look stale.';
  }
  return warning.length > 180 ? `${warning.slice(0, 177)}…` : warning;
}

export default async function tracePlugin(bb: BbPluginApi): Promise<void> {
  const host = bb.hosts.experimental_client({ contract: traceHostContract });

  async function targetThread(threadId: string, signal?: AbortSignal) {
    const thread = await bb.sdk.threads.get({ threadId, signal });
    if (thread.environmentId === null)
      throw new Error('Select a bb environment with a repository before using trace-mcp.');
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
      signal,
    });
    if (environment.path === null)
      throw new Error('The bb environment has no local path for trace-mcp.');
    return { path: environment.path, hostId: environment.hostId };
  }

  function target(ctx: PluginAgentToolContext) {
    return targetThread(ctx.threadId, ctx.signal);
  }

  async function callRaw(
    name: string,
    args: Record<string, unknown>,
    destination: { path: string; hostId: string },
    timeoutMs = HOST_CALL_TIMEOUT_MS,
  ) {
    return host.call(
      'call',
      { path: destination.path, name, args },
      {
        hostId: destination.hostId,
        timeoutMs,
      },
    );
  }

  const handlers = {
    async readOverview({
      threadId,
      search,
    }: z.output<typeof traceUiRpcContract.readOverview.input>) {
      const destination = await targetThread(threadId);
      const [healthResult, decisionsResult, contextResult] = await Promise.allSettled([
        callRaw('get_index_health', {}, destination),
        callRaw(
          'query_decisions',
          {
            ...(search?.trim() ? { search: search.trim() } : {}),
            limit: 10,
            index_only: true,
            verify: false,
          },
          destination,
        ),
        bb.sdk.threads.context({ threadId }),
      ]);
      let index = { status: 'unavailable', files: 0, symbols: 0, warnings: [] as string[] };
      let indexError: string | null = null;
      if (healthResult.status === 'fulfilled') {
        try {
          const payload = indexPayloadSchema.parse(toolPayload(healthResult.value));
          index = {
            status: payload.status ?? 'unknown',
            files: Math.max(0, Math.trunc(payload.stats?.totalFiles ?? 0)),
            symbols: Math.max(0, Math.trunc(payload.stats?.totalSymbols ?? 0)),
            warnings: (payload.warnings ?? [])
              .filter((warning): warning is string => typeof warning === 'string')
              .slice(0, 3)
              .map(displayHealthWarning),
          };
        } catch (error) {
          indexError = errorMessage(error);
        }
      } else {
        indexError = errorMessage(healthResult.reason);
      }
      let decisions: Array<{ id: string; title: string; type: string; summary: string | null }> =
        [];
      let decisionsError: string | null = null;
      if (decisionsResult.status === 'fulfilled') {
        try {
          const payload = decisionsPayloadSchema.parse(toolPayload(decisionsResult.value));
          decisions = payload.decisions.map((decision) => ({
            id: String(decision.id),
            title: decision.title,
            type: decision.type,
            summary: decision.summary ?? null,
          }));
        } catch (error) {
          decisionsError = errorMessage(error);
        }
      } else {
        decisionsError = errorMessage(decisionsResult.reason);
      }
      const usage = contextResult.status === 'fulfilled' ? contextResult.value.usage : null;
      const context =
        usage && usage.modelContextWindow > 0
          ? {
              usedTokens: Math.max(0, usage.usedTokens),
              modelContextWindow: usage.modelContextWindow,
              estimated: usage.estimated,
            }
          : null;
      return { index, indexError, context, decisions, decisionsError };
    },
    async saveDecision({
      threadId,
      title,
      content,
      type,
    }: z.output<typeof traceUiRpcContract.saveDecision.input>) {
      const destination = await targetThread(threadId);
      const payload = z
        .object({ added: z.object({ id: z.union([z.string(), z.number()]) }).passthrough() })
        .passthrough()
        .parse(toolPayload(await callRaw('add_decision', { title, content, type }, destination)));
      return { id: String(payload.added.id) };
    },
    async reindex({ threadId }: z.output<typeof traceUiRpcContract.reindex.input>) {
      const destination = await targetThread(threadId);
      const payload = z
        .object({
          status: z.string(),
          indexed: z.number().optional(),
          errors: z.number().optional(),
        })
        .passthrough()
        .parse(
          toolPayload(await callRaw('reindex', { postprocess: 'full' }, destination, 600_000)),
        );
      return {
        status: payload.status,
        indexed: Math.max(0, Math.trunc(payload.indexed ?? 0)),
        errors: Math.max(0, Math.trunc(payload.errors ?? 0)),
      };
    },
  };
  bb.rpc.register(traceUiRpcContract, handlers);

  function requiredThread(value: string | undefined, context: PluginCliContext): string {
    const threadId = value ?? context.threadId;
    if (!threadId) {
      throw new PluginCliError('A bb thread is required for this command.', {
        code: 'thread_required',
        hint: 'Run the command inside a bb thread or pass --thread <id>.',
      });
    }
    return threadId;
  }

  const threadOption = {
    type: 'string',
    description: 'BB thread ID; defaults to the invoking thread',
  } as const;
  const jsonOption = { type: 'boolean', description: 'Emit machine-readable JSON' } as const;
  bb.cli.register(
    defineCli({
      name: 'trace',
      summary: 'Inspect indexed context and project decisions',
      commands: {
        status: cliCommand({
          summary: 'Show repository index and bb context-window usage',
          options: { thread: threadOption, json: jsonOption },
          async run(input, context) {
            const snapshot = await handlers.readOverview({
              threadId: requiredThread(input.options.thread, context),
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(snapshot)
                : `Index: ${snapshot.index.status} · ${snapshot.index.files} files · ${snapshot.index.symbols} symbols\nContext: ${snapshot.context ? `${snapshot.context.usedTokens} of ${snapshot.context.modelContextWindow} tokens${snapshot.context.estimated ? ' (estimated)' : ''}` : 'not reported by provider'}${snapshot.indexError ? `\nIndex error: ${snapshot.indexError}` : ''}`,
            };
          },
        }),
        decisions: cliCommand({
          summary: 'Search compact project decision summaries',
          positionals: [
            { name: 'query', description: 'Words to search', required: true, variadic: true },
          ],
          options: { thread: threadOption, json: jsonOption },
          async run(input, context) {
            const snapshot = await handlers.readOverview({
              threadId: requiredThread(input.options.thread, context),
              search: input.positionals.query.join(' '),
            });
            if (snapshot.decisionsError)
              throw new PluginCliError(snapshot.decisionsError, { code: 'decisions_unavailable' });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ decisions: snapshot.decisions })
                : snapshot.decisions
                    .map(
                      (decision) =>
                        `${decision.title} (${decision.type})${decision.summary ? ` — ${decision.summary}` : ''}`,
                    )
                    .join('\n') || 'No matching decisions.',
            };
          },
        }),
        remember: cliCommand({
          summary: 'Manually save a project decision',
          options: {
            thread: threadOption,
            title: { type: 'string', required: true, description: 'Short decision title' },
            content: {
              type: 'string',
              required: true,
              description: 'Reason, context, and tradeoffs',
            },
            type: {
              type: 'enum',
              values: decisionTypeSchema.options,
              default: 'tech_choice',
              description: 'Decision type',
            },
            json: jsonOption,
          },
          async run(input, context) {
            const saved = await handlers.saveDecision({
              threadId: requiredThread(input.options.thread, context),
              title: input.options.title,
              content: input.options.content,
              type: input.options.type,
            });
            return {
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify(saved) : `Decision recorded: ${saved.id}`,
            };
          },
        }),
        index: cliCommand({
          summary: 'Reindex the bb thread repository',
          options: { thread: threadOption, json: jsonOption },
          async run(input, context) {
            const result = await handlers.reindex({
              threadId: requiredThread(input.options.thread, context),
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(result)
                : `Indexed ${result.indexed} files with ${result.errors} errors.`,
            };
          },
        }),
      },
    }),
  );

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
    name: 'trace_remember_decision',
    description: 'Save a project decision to shared trace-mcp memory with bb thread deduplication.',
    parameters: z.object({
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(5000),
      type: decisionTypeSchema,
      tags: z.array(z.string().max(64)).max(20).optional(),
    }),
    execute: (args, ctx) => call('remember_decision', { ...args, session_id: ctx.threadId }, ctx),
  });
  bb.agents.registerTool({
    name: 'trace_get_index_health',
    description: 'Check whether the bb environment repository is indexed and ready for queries.',
    parameters: z.object({}),
    execute: (args, ctx) => call('get_index_health', args, ctx),
  });
  bb.agents.registerTool({
    name: 'trace_get_project_memo',
    description: 'Recall the compact project memo and durable decisions before a task.',
    parameters: z.object({}),
    execute: (args, ctx) => call('get_project_memo', args, ctx),
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
    execute: ({ name, arguments: args }, ctx) => call(name, args, ctx),
  });
}
