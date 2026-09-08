/**
 * State-recall benchmark: the falsifiable half of the SKILL.state claim.
 *
 * `state-benchmark.ts` is a closed-form token model and `state-trace-replay.ts`
 * measures prompt cost on real sessions. Neither can fail: both arms always
 * "succeed" because neither has a task to succeed at. Roadmap item 12 asks for
 * an A/B where an arm CAN come out wrong, so this one has a graded outcome.
 *
 * The task is long-horizon fact retention. Over T turns an agent is handed
 * synthetic tool output; scattered through it are constraints, dead ends and
 * concrete details, each carrying a distinctive literal token. At the end the
 * agent is asked what it learned. A fact counts as retained only if its literal
 * appears in the answer, so scoring is exact-match and needs no judge.
 *
 * Four arms, one shared per-turn prompt budget:
 *   - `full`        — whole transcript, no budget. The ceiling; it cannot fail
 *                     from truncation, only from the model not reading carefully.
 *   - `truncated`   — whole transcript trimmed to the budget by dropping the
 *                     OLDEST turns. This is the arm that can fail: anything
 *                     learned early is gone.
 *   - `state`       — the two-phase loop (prose rewrite). Each turn the model rewrites
 *                     a compact state block; the prompt is goal + state + the last two
 *                     turns, under the same budget. This arm can fail too, and
 *                     differently: a fact the model declined to write into state
 *                     is lost permanently, where truncation at least keeps recent
 *                     turns verbatim.
 *   - `state_patch` — the shipped two-phase loop (RFC 7396 merge patch). Each turn
 *                     the model emits a merge patch applied through StateEngine.
 *                     Keys not named survive across turns by construction.
 *
 * ponytail: the corpus is synthetic. Real long sessions would be better
 * evidence, but no public corpus labels "which facts did this session need to
 * still know at turn 40", and our own sessions have no success labels either
 * (see docs/SKILL_STATE.md). Synthetic buys an exact-match grader and a planted
 * ground truth; upgrade path is replacing `generateTasks` with mined sessions
 * once TRA-1090's harness has per-fact labels.
 */

import { estimateTokens } from '../utils/token-counter.js';

export type FactKind = 'constraint' | 'dead_end' | 'detail';

export interface PlantedFact {
  id: string;
  /** 1-based turn whose tool output carries this fact. */
  turn: number;
  kind: FactKind;
  /** Distinctive literal that must appear in the answer for the fact to count. */
  literal: string;
  /** The sentence planted in the tool output. */
  text: string;
}

export interface Turn {
  n: number;
  tool: string;
  /** What the agent asked for on this turn. */
  call: string;
  /** What came back, noise plus any planted fact. */
  output: string;
}

export interface RecallTask {
  id: string;
  goal: string;
  turns: Turn[];
  facts: PlantedFact[];
}

/** Deterministic 32-bit PRNG so a regenerated corpus is byte-identical. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODULES = [
  'edge-resolver',
  'symbol-index',
  'fts-writer',
  'daemon-pool',
  'lsp-bridge',
  'graph-packer',
  'watch-queue',
  'preset-router',
];

const TOOLS = ['search', 'get_outline', 'get_symbol', 'find_usages', 'get_call_graph'];

const FACT_TEMPLATES: { kind: FactKind; render: (lit: string, mod: string) => string }[] = [
  {
    kind: 'constraint',
    render: (lit, mod) =>
      `CONSTRAINT ${lit}: ${mod} must keep accepting the legacy positional argument; three downstream callers still pass it.`,
  },
  {
    kind: 'constraint',
    render: (lit, mod) =>
      `CONSTRAINT ${lit}: any change to ${mod} has to stay under the 200 ms budget the daemon health check asserts.`,
  },
  {
    kind: 'dead_end',
    render: (lit, mod) =>
      `DEAD END ${lit}: caching ${mod} results in memory was tried and abandoned — resident size grew past the 512 MB ceiling.`,
  },
  {
    kind: 'dead_end',
    render: (lit, mod) =>
      `DEAD END ${lit}: rewriting ${mod} on top of the watcher was abandoned; the watcher fires before the write lands.`,
  },
  {
    kind: 'detail',
    render: (lit, mod) =>
      `DETAIL ${lit}: the retry timeout in ${mod} is 4700 ms, not the 1000 ms the docs claim.`,
  },
  {
    kind: 'detail',
    render: (lit, mod) =>
      `DETAIL ${lit}: ${mod} writes its journal to a path taken from TRACE_MCP_HOME, not the project directory.`,
  },
];

/** ~110 words of plausible, fact-free tool output. */
function noise(rng: () => number, mod: string, tool: string): string {
  const lines: string[] = [];
  const count = 6 + Math.floor(rng() * 4);
  for (let i = 0; i < count; i++) {
    const file = `src/${mod}/${MODULES[Math.floor(rng() * MODULES.length)]}-${i}.ts`;
    const line = 20 + Math.floor(rng() * 400);
    const sym = `handle${Math.floor(rng() * 900) + 100}`;
    lines.push(
      `${file}:${line}  ${sym}(ctx: Context, opts: Options): Promise<Result> — called from ${count - i} site(s), complexity ${2 + Math.floor(rng() * 9)}`,
    );
  }
  return `${tool} returned ${count} results:\n${lines.join('\n')}`;
}

export interface GenerateOptions {
  taskCount: number;
  turnsPerTask: number;
  factsPerTask: number;
  seed: number;
}

export function generateTasks(opts: GenerateOptions): RecallTask[] {
  const rng = mulberry32(opts.seed);
  const tasks: RecallTask[] = [];

  for (let t = 0; t < opts.taskCount; t++) {
    const mod = MODULES[t % MODULES.length];
    const id = `recall-${String(t + 1).padStart(2, '0')}`;

    // Facts land in the first 60% of the run: that is what a truncating
    // baseline loses and what a state block is supposed to carry forward.
    const horizon = Math.max(2, Math.floor(opts.turnsPerTask * 0.6));
    const factTurns = new Set<number>();
    while (factTurns.size < opts.factsPerTask) {
      factTurns.add(1 + Math.floor(rng() * horizon));
    }
    const ordered = [...factTurns].sort((a, b) => a - b);

    const facts: PlantedFact[] = ordered.map((turn, i) => {
      const tpl = FACT_TEMPLATES[(t + i) % FACT_TEMPLATES.length];
      const literal = `${mod.toUpperCase().replace(/-/g, '_')}_${String(1000 + Math.floor(rng() * 9000))}`;
      return {
        id: `${id}-f${i + 1}`,
        turn,
        kind: tpl.kind,
        literal,
        text: tpl.render(literal, mod),
      };
    });

    const turns: Turn[] = [];
    for (let n = 1; n <= opts.turnsPerTask; n++) {
      const tool = TOOLS[Math.floor(rng() * TOOLS.length)];
      const planted = facts.filter((f) => f.turn === n);
      const body = noise(rng, mod, tool);
      turns.push({
        n,
        tool,
        call: `${tool}({ query: "${mod}", limit: 20 })`,
        output: planted.length ? `${body}\n\n${planted.map((f) => f.text).join('\n')}` : body,
      });
    }

    tasks.push({
      id,
      goal: `Harden the ${mod} module: find every constraint the change has to respect and every approach already ruled out.`,
      turns,
      facts,
    });
  }

  return tasks;
}

/** Render one turn the way both arms show it. */
export function renderTurn(turn: Turn): string {
  return `### Turn ${turn.n}\n> ${turn.call}\n${turn.output}`;
}

/**
 * Drop the oldest turns until the rendered transcript fits the budget.
 * Returns the surviving turns; always keeps at least the last one.
 */
export function truncateToBudget(turns: Turn[], budgetTokens: number): Turn[] {
  let start = 0;
  while (start < turns.length - 1) {
    const text = turns.slice(start).map(renderTurn).join('\n\n');
    if (estimateTokens(text) <= budgetTokens) break;
    start++;
  }
  return turns.slice(start);
}

export interface RecallScore {
  retained: string[];
  missed: string[];
  /** Share of planted facts whose literal appears in the answer. */
  recall: number;
  /** Strict success: every planted fact retained. */
  passed: boolean;
  /** Literals invented that were never planted anywhere in the corpus. */
  fabricated: number;
}

/**
 * Exact-match grading. A fact counts only when its literal is quoted back;
 * paraphrase does not, which is strict but identical across arms.
 */
export function scoreAnswer(answer: string, task: RecallTask): RecallScore {
  const up = answer.toUpperCase();
  const retained: string[] = [];
  const missed: string[] = [];
  for (const f of task.facts) {
    if (up.includes(f.literal)) retained.push(f.id);
    else missed.push(f.id);
  }
  const own = new Set(task.facts.map((f) => f.literal));
  // An ALL_CAPS_1234 code the answer quotes that was never planted in this task
  // is invented. The state arm is the one with an incentive to invent: it is
  // rewriting facts from memory rather than copying them out of a transcript.
  const fabricated = new Set(
    (up.match(/\b[A-Z][A-Z_]{3,}_\d{4}\b/g) ?? []).filter((lit) => !own.has(lit)),
  ).size;
  return {
    retained,
    missed,
    recall: task.facts.length ? retained.length / task.facts.length : 0,
    passed: missed.length === 0,
    fabricated,
  };
}

export const QUESTION = `The session above is over. Report what it established, as a list.

For every constraint the change must respect, every approach already ruled out,
and every concrete detail worth carrying forward, give one line containing that
item's identifier code exactly as it appeared (the ALL_CAPS_1234 token) followed
by what it means.

Report only items this session actually established. Do not invent identifier
codes. If you no longer have an item, leave it out.`;
