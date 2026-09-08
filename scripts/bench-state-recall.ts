#!/usr/bin/env tsx
/**
 * Roadmap item 12 — the A/B where an arm can fail.
 *
 * The Phase-4 SKILL.state run reported −66.8% prompt tokens at Pass@1 100% in
 * BOTH arms, which is not evidence that compression is free: it is evidence
 * that nothing in that harness was hard enough to get wrong. This one grades a
 * task with a planted ground truth, so a wrong answer is possible and visible.
 * Design and scoring live in `src/eval/state-recall.ts`; thresholds are pinned
 * in `benchmarks/state-recall/preregistration.md` and were committed before any
 * model call was made.
 *
 * Usage:
 *   tsx scripts/bench-state-recall.ts --generate     # rewrite the pinned corpus
 *   tsx scripts/bench-state-recall.ts [--limit N] [--concurrency N] [--budget N]
 *
 * Outputs: benchmarks/state-recall/results.json
 *
 * ponytail: reaches the model through the `claude` CLI in headless mode, same
 * as bench-pr-quality.ts and for the same reason — no ANTHROPIC_API_KEY in this
 * runtime. The CLI's own system-prompt overhead is a constant identical in all
 * three arms, and no tool is callable, but it means absolute prompt-token
 * figures here are the harness's own estimate, not the provider's bill. Swap
 * `askModel` for an SDK call if a key appears.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  QUESTION,
  type RecallTask,
  generateTasks,
  renderTurn,
  scoreAnswer,
  truncateToBudget,
} from '../src/eval/state-recall.js';
import { StateEngine } from '../src/state/state-engine.js';
import { serializeStateToMarkdown } from '../src/state/serializer.js';
import { estimateTokens } from '../src/utils/token-counter.js';

const ROOT = process.cwd();
const BENCH_DIR = path.join(ROOT, 'benchmarks/state-recall');
const CORPUS_PATH = path.join(BENCH_DIR, 'corpus.json');
const OUT_PATH = path.join(BENCH_DIR, 'results.json');
/** Scratch cwd so the CLI never picks up this repo's settings or index. */
const SANDBOX = path.join(ROOT, 'node_modules/.cache/state-recall-sandbox');

const MODEL = 'claude-sonnet-4-5';
const WINDOW = 2;

/** Corpus shape, pinned in preregistration.md. */
const CORPUS = { taskCount: 12, turnsPerTask: 20, factsPerTask: 6, seed: 1115 };
/** Per-turn prompt budget in tokens; see preregistration.md for how it was set. */
const DEFAULT_BUDGET = 4500;

const AGENT_SYSTEM =
  'You are a coding agent working through a long task. Answer only with what is asked for, no preamble.';

const STATE_SYSTEM = `You are a coding agent running the two-phase loop: act, then rewrite your
execution state. Your state block is the ONLY thing that survives to the next
turn besides the last two tool results — anything you leave out is gone for
good. Keep it under 350 tokens. Answer with the new state block and nothing
else.`;

const STATE_PATCH_SYSTEM = `You are a coding agent running the two-phase loop: act, then patch your execution state.
Your state is maintained by StateEngine and is the ONLY thing that survives to the next turn besides the last two tool results.
Emit an RFC 7396 JSON merge patch to update state so it carries everything this task will still need at the end.
Only include fields you are adding or updating. Fields not mentioned in the patch survive unchanged.
Valid state fields:
- facts: { architecture_notes?: string[], key_symbols?: string[], learned_constraints?: string[] }
- blockers_and_dead_ends: { last_error?: string | null, dead_ends?: { approach: string, reason: string }[] }
- working_context: { modified_files?: string[], test_targets?: string[], open_questions?: string[] }
- next_action?: string | null

Note: In RFC 7396, arrays replace previous array values, so when updating an array field (e.g. learned_constraints, dead_ends, architecture_notes), include both prior and new elements to retain them.
Answer with ONLY the JSON patch object, no explanation, no markdown fencing.`;

interface Answer {
  text: string;
  api_ms: number;
  output_tokens: number;
}

function spawnCli(system: string, prompt: string): Promise<string> {
  const args = [
    '-p',
    '--model',
    MODEL,
    '--output-format',
    'json',
    '--system-prompt',
    system,
    '--exclude-dynamic-system-prompt-sections',
    '--allowed-tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--no-session-persistence',
  ];
  const home = process.env.HOME?.replace(/\/\.agy\/.*$/, '') || process.env.HOME;
  return new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: SANDBOX,
      env: { ...process.env, HOME: home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else
        reject(
          new Error(
            `claude exited ${code}: ${(err.slice(-400) || out.slice(-400) || '(empty)').trim()}`,
          ),
        );
    });
    child.stdin.end(prompt);
  });
}

/**
 * One pinned model call. Under concurrency the CLI intermittently exits 1 with
 * an empty stderr — a transient refusal, not a bad prompt. Retried rather than
 * dropped: dropping tasks would quietly reshape the corpus the preregistration
 * pinned, and the survivors would be the easy ones.
 */
async function askModel(system: string, prompt: string): Promise<Answer> {
  let last: Error | undefined;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const d = JSON.parse(await spawnCli(system, prompt)) as {
        is_error?: boolean;
        result: string;
        duration_api_ms: number;
        usage?: { output_tokens?: number };
      };
      if (d.is_error) throw new Error(`model error: ${String(d.result).slice(0, 300)}`);
      return {
        text: d.result,
        api_ms: d.duration_api_ms,
        output_tokens: d.usage?.output_tokens ?? 0,
      };
    } catch (e) {
      last = e as Error;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
  throw last;
}

function transcriptPrompt(task: RecallTask, turns: RecallTask['turns'], dropped: number): string {
  const head =
    dropped > 0
      ? `[${dropped} earlier turn(s) fell out of the context window and are not shown]\n\n`
      : '';
  return `## Goal\n${task.goal}\n\n## Session transcript\n${head}${turns
    .map(renderTurn)
    .join('\n\n')}\n\n## Question\n${QUESTION}`;
}

interface ArmRun {
  answer: string;
  prompt_tokens: number;
  api_ms: number;
  calls: number;
  /** State arm only. The diagnostic that separates "never written down" from
   * "written down, then dropped by a later rewrite". */
  state_final?: string;
  state_fact_life?: { id: string; literal: string; written_at: number | null; survived: boolean }[];
}

async function runFull(task: RecallTask): Promise<ArmRun> {
  const prompt = transcriptPrompt(task, task.turns, 0);
  const a = await askModel(AGENT_SYSTEM, prompt);
  return { answer: a.text, prompt_tokens: estimateTokens(prompt), api_ms: a.api_ms, calls: 1 };
}

async function runTruncated(task: RecallTask, budget: number): Promise<ArmRun> {
  const kept = truncateToBudget(task.turns, budget);
  const prompt = transcriptPrompt(task, kept, task.turns.length - kept.length);
  const a = await askModel(AGENT_SYSTEM, prompt);
  return { answer: a.text, prompt_tokens: estimateTokens(prompt), api_ms: a.api_ms, calls: 1 };
}

/**
 * Facts still inside the truncated window — the truncated arm's mechanical
 * ceiling. Reported so its recall is never mistaken for a model failure when
 * the fact was simply not on screen.
 */
function visibleCeiling(task: RecallTask, budget: number): number {
  const first = truncateToBudget(task.turns, budget)[0].n;
  return task.facts.filter((f) => f.turn >= first).length / task.facts.length;
}

async function runState(task: RecallTask): Promise<ArmRun> {
  let state = `# State\n- goal: ${task.goal}\n- status: in_progress\n- findings: (none yet)\n- next_action: read the first tool result`;
  let promptTokens = 0;
  let apiMs = 0;
  let calls = 0;
  const trace: string[] = [];

  for (const turn of task.turns) {
    const window = task.turns.slice(Math.max(0, turn.n - 1 - WINDOW), turn.n - 1);
    const prompt = `## Goal\n${task.goal}\n\n## Current state\n${state}\n\n## Recent turns\n${
      window.length ? window.map(renderTurn).join('\n\n') : '(none)'
    }\n\n## New tool result\n${renderTurn(turn)}\n\nRewrite the state block so it carries everything this task will still need at the end.`;
    const a = await askModel(STATE_SYSTEM, prompt);
    state = a.text.trim();
    trace.push(state);
    promptTokens += estimateTokens(prompt);
    apiMs += a.api_ms;
    calls++;
  }

  const tail = task.turns.slice(-WINDOW);
  const finalPrompt = `## Goal\n${task.goal}\n\n## Execution state\n${state}\n\n## Last ${WINDOW} turns\n${tail
    .map(renderTurn)
    .join('\n\n')}\n\n## Question\n${QUESTION}`;
  const a = await askModel(AGENT_SYSTEM, finalPrompt);
  return {
    answer: a.text,
    prompt_tokens: promptTokens + estimateTokens(finalPrompt),
    api_ms: apiMs + a.api_ms,
    calls: calls + 1,
    state_final: state,
    state_fact_life: task.facts.map((f) => {
      const at = trace.findIndex((block) => block.toUpperCase().includes(f.literal));
      return {
        id: f.id,
        literal: f.literal,
        written_at: at === -1 ? null : at + 1,
        survived: state.toUpperCase().includes(f.literal),
      };
    }),
  };
}

function parsePatchJson(text: string): Record<string, unknown> {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  }
  return JSON.parse(cleaned);
}

async function runStatePatch(task: RecallTask): Promise<ArmRun> {
  const engine = new StateEngine(new Database(':memory:'));
  engine.initState(task.id, task.goal, ['Inspect tool outputs and track facts']);
  let currentMd = serializeStateToMarkdown(engine.getState(task.id)!.state, 1);
  let promptTokens = 0;
  let apiMs = 0;
  let calls = 0;
  const trace: string[] = [];

  try {
    for (const turn of task.turns) {
      const window = task.turns.slice(Math.max(0, turn.n - 1 - WINDOW), turn.n - 1);
      const prompt = `## Goal\n${task.goal}\n\n## Current state\n${currentMd}\n\n## Recent turns\n${
        window.length ? window.map(renderTurn).join('\n\n') : '(none)'
      }\n\n## New tool result\n${renderTurn(turn)}\n\nEmit an RFC 7396 JSON merge patch to update the state with any newly discovered constraints, dead ends, details, or progress.`;
      const a = await askModel(STATE_PATCH_SYSTEM, prompt);
      try {
        const patch = parsePatchJson(a.text);
        if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
          if (
            Array.isArray(patch.learned_constraints) ||
            Array.isArray(patch.architecture_notes) ||
            Array.isArray(patch.key_symbols)
          ) {
            patch.facts = {
              ...(typeof patch.facts === 'object' && patch.facts !== null
                ? (patch.facts as Record<string, unknown>)
                : {}),
              ...(Array.isArray(patch.learned_constraints)
                ? { learned_constraints: patch.learned_constraints }
                : {}),
              ...(Array.isArray(patch.architecture_notes)
                ? { architecture_notes: patch.architecture_notes }
                : {}),
              ...(Array.isArray(patch.key_symbols) ? { key_symbols: patch.key_symbols } : {}),
            };
          }
          if (patch.blockers_and_dead_ends && typeof patch.blockers_and_dead_ends === 'object') {
            const b = patch.blockers_and_dead_ends as Record<string, unknown>;
            if (Array.isArray(b.dead_ends)) {
              b.dead_ends = b.dead_ends.map((item) =>
                typeof item === 'string' ? { approach: item, reason: item } : item,
              );
            }
          }
          engine.patchState(task.id, patch);
        }
      } catch {
        // Invalid patch: state remains unchanged
      }
      const stateEntry = engine.getState(task.id)!;
      currentMd = serializeStateToMarkdown(stateEntry.state, stateEntry.version);
      trace.push(currentMd);
      promptTokens += estimateTokens(prompt);
      apiMs += a.api_ms;
      calls++;
    }

    const tail = task.turns.slice(-WINDOW);
    const finalPrompt = `## Goal\n${task.goal}\n\n## Execution state\n${currentMd}\n\n## Last ${WINDOW} turns\n${tail
      .map(renderTurn)
      .join('\n\n')}\n\n## Question\n${QUESTION}`;
    const a = await askModel(AGENT_SYSTEM, finalPrompt);
    return {
      answer: a.text,
      prompt_tokens: promptTokens + estimateTokens(finalPrompt),
      api_ms: apiMs + a.api_ms,
      calls: calls + 1,
      state_final: currentMd,
      state_fact_life: task.facts.map((f) => {
        const at = trace.findIndex((block) => block.toUpperCase().includes(f.literal));
        return {
          id: f.id,
          literal: f.literal,
          written_at: at === -1 ? null : at + 1,
          survived: currentMd.toUpperCase().includes(f.literal),
        };
      }),
    };
  } finally {
    engine.close();
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  fs.mkdirSync(BENCH_DIR, { recursive: true });

  if (argv.includes('--generate')) {
    const tasks = generateTasks(CORPUS);
    fs.writeFileSync(CORPUS_PATH, `${JSON.stringify({ ...CORPUS, tasks }, null, 2)}\n`);
    const sizes = tasks.map((t) => estimateTokens(t.turns.map(renderTurn).join('\n\n')));
    console.log(
      `wrote ${tasks.length} tasks → ${path.relative(ROOT, CORPUS_PATH)}\n` +
        `transcript tokens: min ${Math.min(...sizes)} median ${sizes.sort((a, b) => a - b)[sizes.length >> 1]} max ${Math.max(...sizes)}`,
    );
    return;
  }

  const budget = Number(flag('--budget') ?? DEFAULT_BUDGET);
  const concurrency = Number(flag('--concurrency') ?? 3);
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf-8')) as { tasks: RecallTask[] };
  const limit = Number(flag('--limit') ?? corpus.tasks.length);
  const tasks = corpus.tasks.slice(0, limit);

  fs.mkdirSync(SANDBOX, { recursive: true });

  const failed: string[] = [];
  let completed = 0;
  const startedAt = Date.now();
  const rows = (
    await mapLimit(tasks, concurrency, async (task) => {
      const taskStart = Date.now();
      try {
        const [full, truncated, state, state_patch] = await Promise.all([
          runFull(task),
          runTruncated(task, budget),
          runState(task),
          runStatePatch(task),
        ]);
        const arms = { full, truncated, state, state_patch };
        const res = {
          task_id: task.id,
          facts: task.facts.length,
          visible_ceiling: Number(visibleCeiling(task, budget).toFixed(4)),
          arms: Object.fromEntries(
            Object.entries(arms).map(([k, v]) => {
              const s = scoreAnswer(v.answer, task);
              const kept = new Set(s.retained);
              const byKind = Object.fromEntries(
                (['constraint', 'dead_end', 'detail'] as const).map((kind) => {
                  const of = task.facts.filter((f) => f.kind === kind);
                  return [
                    kind,
                    of.length ? of.filter((f) => kept.has(f.id)).length / of.length : null,
                  ];
                }),
              );
              return [k, { ...v, ...s, by_kind: byKind, answer: v.answer.slice(0, 4000) }];
            }),
          ),
        };
        completed++;
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        const taskSec = ((Date.now() - taskStart) / 1000).toFixed(0);
        console.log(
          `[${completed}/${tasks.length}] ${task.id} (${taskSec}s, total ${elapsed}s) — ` +
            `full: ${(res.arms.full.recall * 100).toFixed(0)}%, ` +
            `trunc: ${(res.arms.truncated.recall * 100).toFixed(0)}%, ` +
            `state: ${(res.arms.state.recall * 100).toFixed(0)}%, ` +
            `patch: ${(res.arms.state_patch.recall * 100).toFixed(0)}%`,
        );
        return res;
      } catch (e) {
        completed++;
        failed.push(`${task.id}: ${(e as Error).message}`);
        console.error(`[${completed}/${tasks.length}] ${task.id} FAILED: ${(e as Error).message}`);
        return null;
      }
    })
  ).filter((r): r is NonNullable<typeof r> => r !== null);

  const agg = Object.fromEntries(
    (['full', 'truncated', 'state', 'state_patch'] as const).map((arm) => {
      const xs = rows.map((r) => r.arms[arm]);
      return [
        arm,
        {
          recall: Number(mean(xs.map((x) => x.recall)).toFixed(4)),
          pass_rate: Number(mean(xs.map((x) => (x.passed ? 1 : 0))).toFixed(4)),
          fabricated_per_task: Number(mean(xs.map((x) => x.fabricated)).toFixed(3)),
          mean_prompt_tokens: Math.round(mean(xs.map((x) => x.prompt_tokens))),
          mean_calls: Number(mean(xs.map((x) => x.calls)).toFixed(1)),
          recall_by_kind: Object.fromEntries(
            (['constraint', 'dead_end', 'detail'] as const).map((kind) => [
              kind,
              Number(
                mean(
                  xs.map((x) => x.by_kind[kind]).filter((v): v is number => typeof v === 'number'),
                ).toFixed(4),
              ),
            ]),
          ),
        },
      ];
    }),
  );

  const out = {
    generated_at: new Date().toISOString(),
    model: MODEL,
    transport: 'claude CLI headless (-p), no tools, no MCP, no settings sources',
    corpus: { ...CORPUS, tasks_run: rows.length },
    budget_tokens: budget,
    /** Share of planted facts the truncated arm can still see. Its ceiling. */
    truncated_visible_ceiling: Number(mean(rows.map((r) => r.visible_ceiling)).toFixed(4)),
    window: WINDOW,
    grading: 'exact match on planted literals; no judge model',
    aggregates: agg,
    failed,
    rows,
  };
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`);

  console.log(`\n${rows.length} tasks, budget ${budget} tok, model ${MODEL}`);
  console.table(agg);
  if (failed.length) console.log(`failed: ${failed.length}\n${failed.join('\n')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
