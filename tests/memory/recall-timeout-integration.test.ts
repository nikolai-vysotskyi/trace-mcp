/**
 * Integration coverage for the recall-timeout boundary applied to memory tools.
 *
 * The unit suite in `src/utils/__tests__/recall-timeout.test.ts` pins the helper's
 * behaviour in isolation. This file exercises the *shape* contract that the tool
 * handlers in `src/tools/register/memory.ts` and `src/tools/register/navigation.ts`
 * rely on:
 *
 *   - When a recall-style call exceeds its budget, the helper must surface the
 *     caller-supplied fallback verbatim — including the `degraded: true` marker.
 *   - The fallback must NOT be mutated by a late-arriving real result.
 *
 * Wiring a full MCP server with stubbed DecisionStore would dwarf the actual
 * assertions, so we model the boundary the same way the production handlers do:
 * pass a slow `() => store.queryDecisions(...)` closure into `withRecallTimeout`
 * and assert the returned envelope.
 */
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/logger.js';
import { withRecallTimeout } from '../../src/utils/recall-timeout.js';

interface DecisionRowLike {
  id: number;
  title: string;
}

interface QueryDecisionsEnvelope {
  decisions: DecisionRowLike[];
  total_results: number;
  degraded?: boolean;
}

describe('recall-timeout integration — query_decisions handler shape', () => {
  it('returns the degraded fallback envelope when DecisionStore.queryDecisions is slow', async () => {
    // Suppress the structured warning emitted on timeout so the test output stays clean.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    // Stubbed store: 200ms latency simulates SQLite contention / FTS5 rebuild.
    const slowStore = {
      queryDecisions: () =>
        new Promise<DecisionRowLike[]>((resolve) => {
          setTimeout(() => resolve([{ id: 1, title: 'late-row' }]), 200);
        }),
    };

    const fallback: QueryDecisionsEnvelope = {
      decisions: [],
      total_results: 0,
      degraded: true,
    };

    const result = await withRecallTimeout<QueryDecisionsEnvelope>(
      async () => {
        const decisions = await slowStore.queryDecisions();
        return { decisions, total_results: decisions.length };
      },
      {
        timeoutMs: 50,
        toolName: 'query_decisions',
        fallback,
      },
    );

    expect(result.degraded).toBe(true);
    expect(result.decisions).toEqual([]);
    expect(result.total_results).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [meta] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(meta).toMatchObject({ toolName: 'query_decisions', timeoutMs: 50 });

    // Let the abandoned promise settle so it doesn't bleed into other tests.
    await new Promise((resolve) => setTimeout(resolve, 250));

    // The fallback object must not have been mutated by the late-arriving result.
    expect(fallback.decisions).toEqual([]);
    expect(fallback.total_results).toBe(0);
    expect(fallback.degraded).toBe(true);

    warnSpy.mockRestore();
  });

  it('returns the real envelope when DecisionStore.queryDecisions finishes under budget', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const fastStore = {
      queryDecisions: () => Promise.resolve([{ id: 7, title: 'on-time' }]),
    };

    const fallback: QueryDecisionsEnvelope = {
      decisions: [],
      total_results: 0,
      degraded: true,
    };

    const result = await withRecallTimeout<QueryDecisionsEnvelope>(
      async () => {
        const decisions = await fastStore.queryDecisions();
        return { decisions, total_results: decisions.length };
      },
      {
        timeoutMs: 500,
        toolName: 'query_decisions',
        fallback,
      },
    );

    expect(result.degraded).toBeUndefined();
    expect(result.decisions).toEqual([{ id: 7, title: 'on-time' }]);
    expect(result.total_results).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
