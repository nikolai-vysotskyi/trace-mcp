/**
 * Every executed tool call must reach the durable activity journal (TRA-1868).
 *
 * journal_entries went silently blind for 2+ hours while traffic kept
 * flowing. Three gate paths never emitted: dedup cache hits, throwing
 * callbacks, and (covered in batch/relay suites) raw in-process dispatch.
 * These pin the gate half: normal, dedup-hit, and throw all broadcast.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../config.js';
import { SessionJournal } from '../../session/journal.js';
import type { SessionTracker } from '../../session/tracker.js';
import type { JournalEntryCallbackData } from '../journal-broadcast.js';
import { createGatedCallback, type GatedCallbackContext } from '../tool-gate-helpers.js';

function buildCtx(emitted: JournalEntryCallbackData[]): GatedCallbackContext {
  const savings = {
    recordCall: vi.fn(),
    recordActualTokens: vi.fn(),
    recordFailedCall: vi.fn(),
    recordLatency: vi.fn(),
    getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }),
  };
  return {
    name: 'get_symbol',
    config: {} as TraceMcpConfig,
    savings: savings as unknown as SessionTracker,
    journal: new SessionJournal(),
    j: (v: unknown) => JSON.stringify(v),
    extractResultCount: () => 1,
    extractCompactResult: (tool) => ({ _result_count: 1, tool }),
    stripMetaFields: () => undefined,
    recordToolCall: vi.fn(),
    onJournalEntry: (data: JournalEntryCallbackData) => {
      emitted.push(data);
    },
    sessionId: 'sess-1',
  };
}

function okResponse(text = '{"ok":true}'): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text }] };
}

describe('gated callback journal broadcast (TRA-1868)', () => {
  it('emits the normal path with result metadata', async () => {
    const emitted: JournalEntryCallbackData[] = [];
    const cb = createGatedCallback(buildCtx(emitted), async () => okResponse());
    await cb({ symbol_id: 'foo' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      tool: 'get_symbol',
      params_summary: 'get_symbol foo',
      result_count: 1,
      is_error: false,
      session_id: 'sess-1',
    });
    expect(emitted[0].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits dedup cache hits instead of going blind on them', async () => {
    const emitted: JournalEntryCallbackData[] = [];
    const ctx = buildCtx(emitted);
    const params = { symbol_id: 'foo' };
    await createGatedCallback(ctx, async () => okResponse())(params);
    // Identical second call is served from the session cache (no execution).
    await createGatedCallback(ctx, async () => {
      throw new Error('must not execute on a dedup hit');
    })({ ...params });
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ tool: 'get_symbol', is_error: false });
  });

  it('emits throwing calls as errors so is_error stops undercounting', async () => {
    const emitted: JournalEntryCallbackData[] = [];
    const ctx = buildCtx(emitted);
    const cb = createGatedCallback(ctx, async () => {
      throw new Error('boom');
    });
    await expect(cb({ symbol_id: 'foo' })).rejects.toThrow('boom');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ tool: 'get_symbol', is_error: true, result_count: 0 });
    expect(ctx.recordToolCall).toHaveBeenCalledWith(false);
  });

  it('stays silent without a session — same contract as before', async () => {
    const emitted: JournalEntryCallbackData[] = [];
    const ctx = buildCtx(emitted);
    delete ctx.sessionId;
    await createGatedCallback(ctx, async () => okResponse())({ symbol_id: 'foo' });
    expect(emitted).toHaveLength(0);
  });
});
