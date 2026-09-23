/**
 * `batch` sub-calls must reach the durable activity journal (TRA-1868).
 *
 * `batch` dispatches raw handlers past the tool gate, so every batched
 * sub-call was invisible to activity.db — and agent harnesses batch
 * heavily. Each sub-call is now recorded (in-memory journal, so dedup sees
 * it too) and broadcast with its own latency/token/error outcome.
 */
import type { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { JournalEntryCallbackData } from '../../../server/journal-broadcast.js';
import type { MetaContext } from '../../../server/types.js';
import { SessionJournal } from '../../../session/journal.js';
import { registerSessionTools } from '../session.js';
import { metaCtx } from './_capture-tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function buildBatchHarness(opts: {
  subHandlers: Record<string, Handler>;
  journal?: SessionJournal;
  onJournalEntry?: (data: JournalEntryCallbackData) => void;
  sessionId?: string;
}): Handler {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: () => undefined,
    resource: () => undefined,
    prompt: () => undefined,
  };
  const ctx = metaCtx({
    config: {},
    savings: {
      recordCall: () => undefined,
      recordActualTokens: () => undefined,
      recordFailedCall: () => undefined,
    },
    journal: opts.journal ?? new SessionJournal(),
    onJournalEntry: opts.onJournalEntry,
    sessionId: opts.sessionId,
  }) as unknown as Record<string, unknown>;
  ctx._originalTool = (
    name: string,
    _description: string,
    _shape: Record<string, z.ZodTypeAny>,
    handler: Handler,
  ) => {
    handlers.set(name, handler);
  };
  ctx.toolHandlers = new Map(Object.entries(opts.subHandlers));
  ctx.deferredTools = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSessionTools(server as any, ctx as unknown as MetaContext);
  const batch = handlers.get('batch');
  if (!batch) throw new Error('batch was not registered');
  return batch;
}

describe('batch journal broadcast (TRA-1868)', () => {
  it('records + broadcasts every sub-call with its own outcome', async () => {
    const emitted: JournalEntryCallbackData[] = [];
    const journal = new SessionJournal();
    const batch = buildBatchHarness({
      subHandlers: {
        search: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ hits: [1, 2] }) }],
        }),
        broken: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ error: 'x' }) }],
          isError: true,
        }),
      },
      journal,
      onJournalEntry: (d) => emitted.push(d),
      sessionId: 'sess-batch',
    });

    const response = await batch({
      calls: [
        { tool: 'search', args: { query: 'foo' } },
        { tool: 'broken', args: {} },
      ],
    });
    const body = JSON.parse(response.content?.[0]?.text ?? '{}');
    expect(body.total).toBe(2);

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      tool: 'search',
      params_summary: 'search foo',
      is_error: false,
      session_id: 'sess-batch',
    });
    expect(emitted[0].result_tokens).toBeGreaterThan(0);
    expect(emitted[1]).toMatchObject({ tool: 'broken', is_error: true, result_count: 0 });
    // In-memory journal sees batched calls too — a later identical
    // individual call dedups against what batch already returned.
    expect(journal.getEntries()).toHaveLength(2);
  });

  it('stays silent without a session, like the gate', async () => {
    const emitted: JournalEntryCallbackData[] = [];
    const batch = buildBatchHarness({
      subHandlers: {
        search: async () => ({ content: [{ type: 'text', text: '{}' }] }),
      },
      onJournalEntry: (d) => emitted.push(d),
    });
    await batch({ calls: [{ tool: 'search', args: {} }] });
    expect(emitted).toHaveLength(0);
  });

  it('tolerates a null journal (legacy stub contexts)', async () => {
    const batch = buildBatchHarness({
      subHandlers: {
        search: async () => ({ content: [{ type: 'text', text: '{}' }] }),
      },
      journal: null as unknown as SessionJournal,
      sessionId: 's',
      onJournalEntry: () => undefined,
    });
    const response = await batch({ calls: [{ tool: 'search', args: {} }] });
    expect(JSON.parse(response.content?.[0]?.text ?? '{}').total).toBe(1);
  });

  it('does not broadcast excluded or unknown tools (nothing executed)', async () => {
    const emitted: JournalEntryCallbackData[] = [];
    const spy = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const handlers = new Map<string, Handler>();
    const server = {
      tool: () => undefined,
      resource: () => undefined,
      prompt: () => undefined,
    };
    const ctx = metaCtx({
      config: { tools: { exclude: ['search'] } },
      savings: {
        recordCall: () => undefined,
        recordActualTokens: () => undefined,
        recordFailedCall: () => undefined,
      },
      journal: new SessionJournal(),
      onJournalEntry: (d: JournalEntryCallbackData) => emitted.push(d),
      sessionId: 's',
    }) as unknown as Record<string, unknown>;
    ctx._originalTool = (
      name: string,
      _description: string,
      _shape: Record<string, z.ZodTypeAny>,
      handler: Handler,
    ) => {
      handlers.set(name, handler);
    };
    ctx.toolHandlers = new Map([['search', spy]]);
    ctx.deferredTools = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSessionTools(server as any, ctx as unknown as MetaContext);
    const batch = handlers.get('batch');
    if (!batch) throw new Error('batch was not registered');
    await batch({
      calls: [
        { tool: 'search', args: {} },
        { tool: 'nope', args: {} },
      ],
    });
    expect(emitted).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
