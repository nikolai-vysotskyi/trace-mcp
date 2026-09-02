import { describe, expect, it } from 'vitest';
import type { AgentExecutionState } from '../../state/types.js';
import {
  longestNonResetSegment,
  parseSessionLog,
  replaySession,
  type ReplayTurn,
} from '../state-trace-replay.js';

interface UsageShape {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function assistant(
  id: string,
  usage: UsageShape,
  content: unknown[] = [{ type: 'text', text: 'ok' }],
): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'sess',
    message: { id, content, usage },
  });
}

/** A plain turn with everything billed as ordinary input. */
function turn(promptTokens: number, state: AgentExecutionState): ReplayTurn {
  return {
    promptTokens,
    inputTokens: promptTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    state,
  };
}

const goalLine = JSON.stringify({
  type: 'user',
  sessionId: 'sess',
  message: { content: 'Fix the edge resolver' },
});

function baseSession() {
  const log = [
    goalLine,
    ...['m1', 'm2', 'm3', 'm4', 'm5'].map((id, i) =>
      assistant(id, { input_tokens: (i + 1) * 1000 }),
    ),
  ].join('\n');
  return parseSessionLog('sess', log)!;
}

describe('longestNonResetSegment', () => {
  it('splits at a compaction drop and keeps the longer run', () => {
    const state = baseSession().turns[0]!.state;
    const turns = [100, 200, 300, 400, 10, 20].map((n) => turn(n, state));
    expect(longestNonResetSegment(turns).map((t) => t.promptTokens)).toEqual([100, 200, 300, 400]);
  });
});

describe('parseSessionLog', () => {
  const lines = [
    goalLine,
    assistant('m1', { input_tokens: 1000 }, [
      { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } },
    ]),
    // Same message id repeated (one log line per content block) must count once.
    assistant('m1', { input_tokens: 1000 }),
    assistant('m2', { input_tokens: 2000 }),
    assistant('m3', { input_tokens: 3000 }),
    assistant('m4', { input_tokens: 4000 }),
    assistant('m5', { input_tokens: 5000 }),
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
    const last = session!.turns[4]!.state;
    expect(last.goal).toBe('Fix the edge resolver');
    expect(last.working_context.modified_files).toEqual(['src/a.ts']);
  });

  it('carries only what earlier turns established into each turn', () => {
    const session = parseSessionLog('sess', lines)!;
    // The Edit happened in turn 1's own response, so turn 1's prompt cannot know it.
    expect(session.turns[0]!.state.working_context.modified_files).toEqual([]);
    expect(session.turns[1]!.state.working_context.modified_files).toEqual(['src/a.ts']);
  });

  it('rejects sessions too short to say anything', () => {
    expect(parseSessionLog('sess', assistant('m1', { input_tokens: 100 }))).toBeNull();
  });
});

describe('replaySession', () => {
  it('does not let a final tool call change any already-observed prompt', () => {
    const head = ['m1', 'm2', 'm3', 'm4'].map((id, i) =>
      assistant(id, { input_tokens: (i + 1) * 1000 }),
    );
    const plain = [goalLine, ...head, assistant('m5', { input_tokens: 5000 })].join('\n');
    const withTrailingEdit = [
      goalLine,
      ...head,
      assistant('m5', { input_tokens: 5000 }, [
        { type: 'tool_use', name: 'Edit', input: { file_path: 'src/very/long/path/to/file.ts' } },
      ]),
    ].join('\n');

    const a = replaySession(parseSessionLog('sess', plain)!);
    const b = replaySession(parseSessionLog('sess', withTrailingEdit)!);
    expect(b.stateTotalTokens).toBe(a.stateTotalTokens);
    expect(b.stateTokens).toBe(a.stateTokens);
  });

  it('reports a saving when history dwarfs the state block', () => {
    const state = baseSession().turns[0]!.state;
    const turns = [1000, 6000, 11000, 16000, 21000].map((n) => turn(n, state));
    const result = replaySession({ sessionId: 'sess', turns }, 2);
    expect(result.reactTotalTokens).toBe(55000);
    expect(result.stateTotalTokens).toBeLessThan(result.reactTotalTokens);
    expect(result.savingsPercent).toBeGreaterThan(20);
  });

  it('prices cache writes at 1.25x in both arms', () => {
    const state = baseSession().turns[0]!.state;
    const cheap: ReplayTurn[] = [1000, 1100, 1200, 1300, 1400].map((n) => ({
      promptTokens: n,
      inputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: n,
      state,
    }));
    const expensive = cheap.map((t) => ({
      ...t,
      cacheCreationTokens: t.cacheReadTokens,
      cacheReadTokens: 0,
    }));
    // Same prompt sizes, all cache writes instead of reads: ReAct pays 12.5x more.
    expect(
      replaySession({ sessionId: 'sess', turns: expensive }).reactBilledTokens,
    ).toBeGreaterThan(replaySession({ sessionId: 'sess', turns: cheap }).reactBilledTokens * 12);
  });

  it('goes negative on billed cost when the history was fully cached', () => {
    const state = baseSession().turns[0]!.state;
    const turns: ReplayTurn[] = [10000, 10100, 10200, 10300, 10400].map((n) => ({
      promptTokens: n,
      inputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: n,
      state,
    }));
    const result = replaySession({ sessionId: 'sess', turns }, 2);
    expect(result.billedSavingsPercent).toBeLessThan(0);
  });
});
