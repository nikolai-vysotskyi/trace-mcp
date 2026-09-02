import { describe, expect, it } from 'vitest';
import { longestNonResetSegment, parseSessionLog, replaySession } from '../state-trace-replay.js';

function assistant(id: string, promptTokens: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'sess',
    message: {
      id,
      content: extra.content ?? [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: promptTokens, cache_read_input_tokens: promptTokens - 1 },
    },
  });
}

describe('longestNonResetSegment', () => {
  it('splits at a compaction drop and keeps the longer run', () => {
    const turns = [100, 200, 300, 400, 10, 20].map((promptTokens) => ({
      promptTokens,
      cacheReadTokens: 0,
    }));
    expect(longestNonResetSegment(turns).map((t) => t.promptTokens)).toEqual([100, 200, 300, 400]);
  });
});

describe('parseSessionLog', () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      sessionId: 'sess',
      message: { content: 'Fix the edge resolver' },
    }),
    assistant('m1', 1000, {
      content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }],
    }),
    // Same message id repeated (one log line per content block) must count once.
    assistant('m1', 1000),
    assistant('m2', 2000),
    assistant('m3', 3000),
    assistant('m4', 4000),
    assistant('m5', 5000),
    // A subagent turn runs in its own context and must not be mixed in.
    JSON.stringify({
      type: 'assistant',
      sessionId: 'sess',
      isSidechain: true,
      message: { id: 'sub', content: [], usage: { input_tokens: 999999 } },
    }),
  ].join('\n');

  it('deduplicates messages, skips sidechains and reconstructs state', () => {
    const session = parseSessionLog('sess', lines);
    expect(session).not.toBeNull();
    expect(session!.turns).toHaveLength(5);
    expect(session!.state.goal).toBe('Fix the edge resolver');
    expect(session!.state.working_context.modified_files).toEqual(['src/a.ts']);
  });

  it('rejects sessions too short to say anything', () => {
    expect(parseSessionLog('sess', assistant('m1', 100))).toBeNull();
  });
});

function baseSession() {
  const log = [
    JSON.stringify({ type: 'user', sessionId: 'sess', message: { content: 'Fix it' } }),
    ...['m1', 'm2', 'm3', 'm4', 'm5'].map((id, i) => assistant(id, (i + 1) * 1000)),
  ].join('\n');
  return parseSessionLog('sess', log)!;
}

describe('replaySession', () => {
  it('reports a saving when history dwarfs the state block', () => {
    const turns = [1000, 6000, 11000, 16000, 21000].map((promptTokens) => ({
      promptTokens,
      cacheReadTokens: 0,
    }));
    const result = replaySession({ ...baseSession(), turns }, 2);
    expect(result.reactTotalTokens).toBe(55000);
    // base 1000 + state + last two 5000-token increments, summed over 5 turns.
    expect(result.stateTotalTokens).toBeLessThan(result.reactTotalTokens);
    expect(result.savingsPercent).toBeGreaterThan(20);
  });

  it('goes negative on billed cost when the history was fully cached', () => {
    // A short, heavily cached session: ReAct pays 0.1x, the state arm rewrites.
    const turns = [10000, 10100, 10200, 10300, 10400].map((promptTokens) => ({
      promptTokens,
      cacheReadTokens: promptTokens - 100,
    }));
    const result = replaySession({ ...baseSession(), turns }, 2);
    expect(result.billedSavingsPercent).toBeLessThan(0);
  });
});
