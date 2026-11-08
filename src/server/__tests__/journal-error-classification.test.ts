/**
 * Error classification in journal broadcast (TRA-2981).
 *
 * Fast 1-11ms errors in get_symbol, get_outline, find_usages (NOT_FOUND, ambiguous,
 * unindexed, root session) must be classified in params_summary diagnostic label so
 * activity logs and QA can distinguish expected client misses from genuine resolution defects.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../config.js';
import { SessionJournal } from '../../session/journal.js';
import type { SessionTracker } from '../../session/tracker.js';
import type { JournalEntryCallbackData } from '../journal-broadcast.js';
import {
  classifyErrorResponse,
  createGatedCallback,
  type GatedCallbackContext,
  type WrappedToolResponse,
} from '../tool-gate-helpers.js';
import { notFound, securityViolation, formatToolError } from '../../errors.js';

function buildCtx(name: string, emitted: JournalEntryCallbackData[]): GatedCallbackContext {
  const savings = {
    recordCall: vi.fn(),
    recordActualTokens: vi.fn(),
    recordFailedCall: vi.fn(),
    recordLatency: vi.fn(),
    getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }),
  };
  return {
    name,
    config: {} as TraceMcpConfig,
    savings: savings as unknown as SessionTracker,
    journal: new SessionJournal(),
    j: (v: unknown) => JSON.stringify(v),
    extractResultCount: (res: unknown) => {
      const resp = res as WrappedToolResponse;
      return resp?.isError ? 0 : 1;
    },
    extractCompactResult: (tool) => ({ _result_count: 1, tool }),
    stripMetaFields: () => undefined,
    recordToolCall: vi.fn(),
    onJournalEntry: (data: JournalEntryCallbackData) => {
      emitted.push(data);
    },
    sessionId: 'sess-classification-test',
  };
}

describe('classifyErrorResponse (TRA-2981)', () => {
  it('classifies missing symbol as NOT_FOUND:unknown_symbol', () => {
    const err = formatToolError(notFound('missingFunc', undefined, 'unknown_symbol'));
    const res: WrappedToolResponse = {
      content: [{ type: 'text', text: JSON.stringify(err) }],
      isError: true,
    };
    expect(classifyErrorResponse(res)).toBe('NOT_FOUND:unknown_symbol');
  });

  it('classifies ambiguous candidates as NOT_FOUND:ambiguous', () => {
    const err = formatToolError(
      notFound('apply', ['f1.ts::apply#function', 'f2.ts::apply#function'], 'unknown_symbol'),
    );
    const res: WrappedToolResponse = {
      content: [{ type: 'text', text: JSON.stringify(err) }],
      isError: true,
    };
    expect(classifyErrorResponse(res)).toBe('NOT_FOUND:ambiguous');
  });

  it('classifies missing file as NOT_FOUND:not_found', () => {
    const err = formatToolError(notFound('src/missing.ts', undefined, 'not_found'));
    const res: WrappedToolResponse = {
      content: [{ type: 'text', text: JSON.stringify(err) }],
      isError: true,
    };
    expect(classifyErrorResponse(res)).toBe('NOT_FOUND:not_found');
  });

  it('classifies unindexed file as NOT_FOUND:not_indexed', () => {
    const err = formatToolError(notFound('src/unindexed.ts', undefined, 'not_indexed'));
    const res: WrappedToolResponse = {
      content: [{ type: 'text', text: JSON.stringify(err) }],
      isError: true,
    };
    expect(classifyErrorResponse(res)).toBe('NOT_FOUND:not_indexed');
  });

  it('classifies filesystem root session errors', () => {
    const res: WrappedToolResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'Symbol not found (session root has empty index)',
            reason: 'filesystem_root_session',
          }),
        },
      ],
      isError: true,
    };
    expect(classifyErrorResponse(res)).toBe('NOT_FOUND:filesystem_root_session');
  });

  it('classifies descendant project error', () => {
    const res: WrappedToolResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: {
              code: 'DESCENDANT_PROJECT',
              message: 'Belongs to descendant',
            },
          }),
        },
      ],
      isError: true,
    };
    expect(classifyErrorResponse(res)).toBe('DESCENDANT_PROJECT');
  });

  it('classifies security guard violations', () => {
    const err = formatToolError(securityViolation('Path escapes project root'));
    const res: WrappedToolResponse = {
      content: [{ type: 'text', text: JSON.stringify(err) }],
      isError: true,
    };
    expect(classifyErrorResponse(res)).toBe('SECURITY_VIOLATION');
  });

  it('handles non-JSON or missing error gracefully', () => {
    expect(classifyErrorResponse(undefined)).toBe('ERROR');
    expect(
      classifyErrorResponse({
        content: [{ type: 'text', text: 'plain text error' }],
        isError: true,
      }),
    ).toBe('ERROR');
  });
});

describe('gated callback journal classification integration (TRA-2981)', () => {
  it('appends diagnostic classifier to params_summary on is_error', async () => {
    const emitted: JournalEntryCallbackData[] = [];
    const ctx = buildCtx('get_symbol', emitted);
    const err = formatToolError(notFound('useRedirectCheckout', undefined, 'unknown_symbol'));
    const cb = createGatedCallback(ctx, async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(err) }],
      isError: true,
    }));

    await cb({ symbol_id: 'useRedirectCheckout' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      tool: 'get_symbol',
      params_summary: 'get_symbol useRedirectCheckout [NOT_FOUND:unknown_symbol]',
      is_error: true,
      result_count: 0,
    });
  });

  it('keeps normal params_summary without classification suffix on success', async () => {
    const emitted: JournalEntryCallbackData[] = [];
    const ctx = buildCtx('get_symbol', emitted);
    const cb = createGatedCallback(ctx, async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ name: 'foo' }) }],
    }));

    await cb({ symbol_id: 'foo' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      tool: 'get_symbol',
      params_summary: 'get_symbol foo',
      is_error: false,
      result_count: 1,
    });
  });

  it('appends THROW classifier on thrown exceptions', async () => {
    const emitted: JournalEntryCallbackData[] = [];
    const ctx = buildCtx('get_outline', emitted);
    const cb = createGatedCallback(ctx, async () => {
      throw new TypeError('unexpected null pointer');
    });

    await expect(cb({ path: 'src/index.ts' })).rejects.toThrow('unexpected null pointer');

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      tool: 'get_outline',
      params_summary: 'get_outline src/index.ts [THROW:TypeError]',
      is_error: true,
      result_count: 0,
    });
  });
});
