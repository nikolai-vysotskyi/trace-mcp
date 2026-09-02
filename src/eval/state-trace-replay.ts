/**
 * Trace-replay benchmark for SKILL.state (TRA-600).
 *
 * `state-benchmark.ts` is a closed-form simulation: every input (steps, tool
 * output size, state size) is a constant chosen by hand, so its "savings" number
 * is a restatement of those constants. This harness replaces the constants with
 * measurements taken from real agent sessions:
 *
 * - the ReAct arm is not modelled at all — it is the prompt size the provider
 *   actually billed on every turn (`input + cache_creation + cache_read`);
 * - the state block is built from what the session really did (its TodoWrite
 *   plan, the files it really edited, the symbols it really looked up) and sized
 *   with the shipped serializer.
 *
 * One thing stays counterfactual and cannot be measured from a transcript: whether
 * an agent carrying only the state block plus the last K tool results would have
 * reached the same result. This harness measures prompt cost, not task success.
 */

import { readFileSync } from 'node:fs';
import { AgentExecutionStateSchema } from '../state/schema.js';
import { estimateTokenCount, serializeStateToMarkdown } from '../state/serializer.js';
import type { AgentExecutionState } from '../state/types.js';

export interface ReplayTurn {
  /** Prompt tokens the provider actually saw on this turn. */
  promptTokens: number;
  /** Tokens read from prompt cache (billed at ~0.1x). */
  cacheReadTokens: number;
}

export interface ReplaySession {
  sessionId: string;
  /** Turns of the longest run without a context reset (compaction / new prefix). */
  turns: ReplayTurn[];
  state: AgentExecutionState;
}

export interface ReplayResult {
  sessionId: string;
  turns: number;
  stateTokens: number;
  baseTokens: number;
  reactTotalTokens: number;
  stateTotalTokens: number;
  savingsPercent: number;
  /** Same comparison priced with Anthropic cache multipliers. */
  reactBilledTokens: number;
  stateBilledTokens: number;
  billedSavingsPercent: number;
}

/** Anthropic prompt-cache pricing multipliers relative to a plain input token. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Replays one session against the linear-state arm.
 *
 * @param session Measured turns plus the state reconstructed from the transcript.
 * @param windowSize Recent tool results the state arm keeps verbatim.
 */
export function replaySession(session: ReplaySession, windowSize = 2): ReplayResult {
  const { turns } = session;
  const stateMarkdown = serializeStateToMarkdown(session.state);
  const stateTokens = estimateTokenCount(stateMarkdown);
  const base = turns[0]?.promptTokens ?? 0;

  // Growth attributable to turn t: what the transcript gained since the previous turn.
  const growth = turns.map((turn, i) =>
    i === 0 ? 0 : Math.max(0, turn.promptTokens - turns[i - 1]!.promptTokens),
  );

  let reactTotal = 0;
  let stateTotal = 0;
  let reactBilled = 0;
  let stateBilled = 0;

  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t]!;
    reactTotal += turn.promptTokens;
    reactBilled +=
      turn.cacheReadTokens * CACHE_READ_MULTIPLIER +
      Math.max(0, turn.promptTokens - turn.cacheReadTokens);

    let window = 0;
    for (let k = Math.max(0, t - windowSize + 1); k <= t; k++) window += growth[k]!;
    const statePrompt = base + stateTokens + window;
    stateTotal += statePrompt;

    // ponytail: the state arm rewrites its tail every turn, so only the fixed
    // base prefix can stay cached. Upper bound on how well it can cache.
    stateBilled +=
      t === 0
        ? statePrompt * CACHE_WRITE_MULTIPLIER
        : base * CACHE_READ_MULTIPLIER + (stateTokens + window) * CACHE_WRITE_MULTIPLIER;
  }

  return {
    sessionId: session.sessionId,
    turns: turns.length,
    stateTokens,
    baseTokens: base,
    reactTotalTokens: reactTotal,
    stateTotalTokens: stateTotal,
    savingsPercent: pct(reactTotal, stateTotal),
    reactBilledTokens: Math.round(reactBilled),
    stateBilledTokens: Math.round(stateBilled),
    billedSavingsPercent: pct(reactBilled, stateBilled),
  };
}

function pct(from: number, to: number): number {
  if (from <= 0) return 0;
  return Number((((from - to) / from) * 100).toFixed(1));
}

interface RawEntry {
  type?: string;
  isSidechain?: boolean;
  sessionId?: string;
  message?: {
    id?: string;
    role?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    content?: unknown;
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => {
      const rec = b as { type?: string; text?: unknown };
      return rec.type === 'text' && typeof rec.text === 'string';
    })
    .map((b) => b.text)
    .join('\n');
}

function toolUses(content: unknown): Array<{ name: string; input: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const block of content) {
    const rec = block as { type?: string; name?: unknown; input?: unknown };
    if (rec.type === 'tool_use' && typeof rec.name === 'string') {
      out.push({ name: rec.name, input: (rec.input as Record<string, unknown>) ?? {} });
    }
  }
  return out;
}

function hasErrorResult(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const rec = block as { type?: string; is_error?: boolean; content?: unknown };
    if (rec.type === 'tool_result' && rec.is_error) {
      return textOf(rec.content).slice(0, 200) || 'tool call failed';
    }
  }
  return null;
}

const uniq = (xs: string[], limit: number): string[] => [...new Set(xs)].slice(0, limit);

/**
 * Parses one Claude Code session log into measured turns plus the state a
 * SKILL.state agent would have been carrying by the end of it.
 */
export function parseSessionLog(sessionId: string, jsonl: string): ReplaySession | null {
  const turns: ReplayTurn[] = [];
  const files: string[] = [];
  const symbols: string[] = [];
  let goal = '';
  let todos: Array<{ content?: string; status?: string }> = [];
  let lastError: string | null = null;
  // One assistant message is logged once per content block; count it once.
  const countedMessages = new Set<string>();

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: RawEntry;
    try {
      entry = JSON.parse(line) as RawEntry;
    } catch {
      continue;
    }
    // Subagent turns and resumed/forked branches run in their own context window.
    if (entry.isSidechain) continue;
    if (entry.sessionId && entry.sessionId !== sessionId) continue;

    if (entry.type === 'user' && !goal) {
      const text = textOf(entry.message?.content).trim();
      // Skip the harness preamble blocks; the first real sentence is the goal.
      if (text && !text.startsWith('<')) goal = text.replace(/\s+/g, ' ').slice(0, 240);
    }

    if (entry.type === 'user') {
      const err = hasErrorResult(entry.message?.content);
      if (err) lastError = err;
    }

    if (entry.type !== 'assistant') continue;

    for (const call of toolUses(entry.message?.content)) {
      const input = call.input;
      if (call.name === 'TodoWrite' && Array.isArray(input.todos)) {
        todos = input.todos as Array<{ content?: string; status?: string }>;
      }
      const path = input.file_path ?? input.path;
      if ((call.name === 'Edit' || call.name === 'Write') && typeof path === 'string') {
        files.push(path);
      }
      const sym = input.fqn ?? input.symbol_id;
      if (typeof sym === 'string' && sym) symbols.push(sym);
    }

    const usage = entry.message?.usage;
    const messageId = entry.message?.id;
    if (!usage || !messageId || countedMessages.has(messageId)) continue;
    countedMessages.add(messageId);
    const promptTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    if (promptTokens <= 0) continue;
    turns.push({ promptTokens, cacheReadTokens: usage.cache_read_input_tokens ?? 0 });
  }

  const segment = longestNonResetSegment(turns);
  if (segment.length < 5) return null;

  const state = AgentExecutionStateSchema.parse({
    task_id: sessionId.slice(0, 8),
    goal: goal || 'unspecified task',
    plan: {
      steps: todos.slice(0, 12).map((todo, i) => ({
        id: `s${i + 1}`,
        title: (todo.content ?? `step ${i + 1}`).slice(0, 120),
        status:
          todo.status === 'completed'
            ? 'completed'
            : todo.status === 'in_progress'
              ? 'in_progress'
              : 'pending',
      })),
    },
    facts: { key_symbols: uniq(symbols, 12) },
    working_context: {
      modified_files: uniq(files, 12),
      test_targets: uniq(
        files.filter((f) => /test|spec/.test(f)),
        6,
      ),
    },
    blockers_and_dead_ends: { last_error: lastError },
  }) as AgentExecutionState;

  return { sessionId, turns: segment, state };
}

/**
 * A transcript can be compacted or restarted mid-session, which drops the prompt
 * back down. Those are separate contexts — compare within one, not across.
 */
export function longestNonResetSegment(turns: ReplayTurn[]): ReplayTurn[] {
  let best: ReplayTurn[] = [];
  let current: ReplayTurn[] = [];
  for (const turn of turns) {
    const prev = current[current.length - 1];
    if (prev && turn.promptTokens < prev.promptTokens * 0.7) {
      if (current.length > best.length) best = current;
      current = [];
    }
    current.push(turn);
  }
  return current.length > best.length ? current : best;
}

export function loadSession(path: string, sessionId: string): ReplaySession | null {
  return parseSessionLog(sessionId, readFileSync(path, 'utf8'));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
