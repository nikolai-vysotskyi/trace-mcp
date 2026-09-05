/**
 * `batch` is the door for preset-deferred tools (TRA-675).
 *
 * The daemon-backed path has always behaved this way — the proxy filters on the
 * outer tool name only, so an inner call reaches the daemon's full registry —
 * while the local path answered "Unknown tool" for the same call, because a
 * deferred tool is registered-but-disabled and never lands in `toolHandlers`.
 * The `router` preset (empty membership) depends on that door, so this pins the
 * behaviour on the local half; proxy-tool-preset.test.ts pins the other half.
 *
 * `tools.exclude` is the one thing that must not pass through it: a preset is a
 * deferral, an exclusion is a restriction.
 */
import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { MetaContext } from '../../../server/types.js';
import { registerSessionTools } from '../session.js';
import { metaCtx } from './_capture-tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content?: Array<{ type: string; text: string }>;
}>;

/** Register the session tools and hand back `batch`'s callback. */
function buildBatch(opts: { loaded?: string[]; deferred?: string[]; exclude?: string[] }): Handler {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: () => undefined,
    resource: () => undefined,
    prompt: () => undefined,
  };
  const ctx = metaCtx({
    config: { tools: { exclude: opts.exclude } },
    savings: {
      recordCall: () => undefined,
      recordActualTokens: () => undefined,
      recordFailedCall: () => undefined,
    },
  }) as unknown as Record<string, unknown>;
  const stub =
    (name: string): Handler =>
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ ran: name }) }],
    });
  ctx._originalTool = (
    name: string,
    _description: string,
    _shape: Record<string, z.ZodTypeAny>,
    handler: Handler,
  ) => {
    handlers.set(name, handler);
  };
  ctx.toolHandlers = new Map((opts.loaded ?? []).map((n) => [n, stub(n)]));
  ctx.deferredTools = new Map(
    (opts.deferred ?? []).map((n) => [n, { registered: { enabled: false }, handler: stub(n) }]),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSessionTools(server as any, ctx as unknown as MetaContext);
  const batch = handlers.get('batch');
  if (!batch) throw new Error('batch was not registered');
  return batch;
}

async function runBatch(
  handler: Handler,
  tools: string[],
): Promise<Array<{ tool: string; result?: unknown; error?: string }>> {
  const response = await handler({ calls: tools.map((tool) => ({ tool, args: {} })) });
  return JSON.parse(response.content?.[0]?.text ?? '{}').batch_results;
}

describe('batch dispatches past the preset, but never past tools.exclude (TRA-675)', () => {
  it('runs a tool the session preset deferred', async () => {
    const batch = buildBatch({ loaded: ['search'], deferred: ['get_pagerank'] });
    const [result] = await runBatch(batch, ['get_pagerank']);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ ran: 'get_pagerank' });
  });

  it('refuses a tools.exclude entry even though it is registered', async () => {
    const batch = buildBatch({
      loaded: ['search'],
      deferred: ['get_pagerank'],
      exclude: ['get_pagerank'],
    });
    const [result] = await runBatch(batch, ['get_pagerank']);
    expect(result.result).toBeUndefined();
    expect(result.error).toContain('excluded');
  });

  it('refuses an excluded tool that is otherwise fully loaded', async () => {
    // The exclusion has to be checked before the handler lookup, not as a
    // side effect of the tool being absent from the map.
    const batch = buildBatch({ loaded: ['search'], exclude: ['search'] });
    const [result] = await runBatch(batch, ['search']);
    expect(result.error).toContain('excluded');
  });

  it('still reports a genuinely unknown tool', async () => {
    const batch = buildBatch({ loaded: ['search'] });
    const [result] = await runBatch(batch, ['no_such_tool']);
    expect(result.error).toContain('Unknown tool');
  });
});
