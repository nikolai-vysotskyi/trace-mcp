import { describe, expect, it } from 'vitest';
import {
  type RecallTask,
  generateTasks,
  renderTurn,
  scoreAnswer,
  truncateToBudget,
} from '../state-recall.js';
import { estimateTokens } from '../../utils/token-counter.js';

const OPTS = { taskCount: 12, turnsPerTask: 20, factsPerTask: 6, seed: 1115 };

describe('generateTasks', () => {
  it('is deterministic for a seed', () => {
    expect(generateTasks(OPTS)).toEqual(generateTasks(OPTS));
  });

  it('gives every task the requested shape', () => {
    for (const t of generateTasks(OPTS)) {
      expect(t.turns).toHaveLength(20);
      expect(t.facts).toHaveLength(6);
      expect(new Set(t.facts.map((f) => f.literal)).size).toBe(6);
    }
  });

  it('plants no literal in more than one task', () => {
    const seen = new Set<string>();
    for (const t of generateTasks(OPTS)) {
      for (const f of t.facts) {
        expect(seen.has(f.literal)).toBe(false);
        seen.add(f.literal);
      }
    }
  });

  it('puts each fact literally into its own turn and nowhere else', () => {
    for (const t of generateTasks(OPTS)) {
      for (const f of t.facts) {
        const carrying = t.turns.filter((turn) => turn.output.includes(f.literal));
        expect(carrying.map((turn) => turn.n)).toEqual([f.turn]);
      }
    }
  });

  it('keeps facts inside the first 60% of the run, so truncation can bite', () => {
    for (const t of generateTasks(OPTS)) {
      for (const f of t.facts) expect(f.turn).toBeLessThanOrEqual(12);
    }
  });
});

describe('truncateToBudget', () => {
  const task = generateTasks(OPTS)[0];

  it('drops oldest turns until the transcript fits', () => {
    const kept = truncateToBudget(task.turns, 4500);
    expect(estimateTokens(kept.map(renderTurn).join('\n\n'))).toBeLessThanOrEqual(4500);
    expect(kept.at(-1)).toEqual(task.turns.at(-1));
    expect(kept.length).toBeLessThan(task.turns.length);
  });

  it('keeps everything when the budget is large enough', () => {
    expect(truncateToBudget(task.turns, 1_000_000)).toEqual(task.turns);
  });

  it('never returns an empty transcript', () => {
    expect(truncateToBudget(task.turns, 1)).toHaveLength(1);
  });

  it('leaves the preregistered ceiling where preregistration.md says it is', () => {
    // 43.1% of planted facts still visible at budget 4500. The whole benchmark
    // is read against this number, so it is pinned rather than described.
    const tasks = generateTasks(OPTS);
    let visible = 0;
    let total = 0;
    for (const t of tasks) {
      const first = truncateToBudget(t.turns, 4500)[0].n;
      visible += t.facts.filter((f) => f.turn >= first).length;
      total += t.facts.length;
    }
    expect(Number(((100 * visible) / total).toFixed(1))).toBe(43.1);
  });
});

describe('scoreAnswer', () => {
  const task: RecallTask = {
    id: 't',
    goal: 'g',
    turns: [],
    facts: [
      { id: 'f1', turn: 1, kind: 'constraint', literal: 'ALPHA_1111', text: '' },
      { id: 'f2', turn: 2, kind: 'detail', literal: 'BETA_2222', text: '' },
    ],
  };

  it('counts a literal quoted back, in any case', () => {
    const s = scoreAnswer('we must respect alpha_1111 here', task);
    expect(s.retained).toEqual(['f1']);
    expect(s.missed).toEqual(['f2']);
    expect(s.recall).toBe(0.5);
    expect(s.passed).toBe(false);
  });

  it('passes only when every fact is retained', () => {
    const s = scoreAnswer('ALPHA_1111 and BETA_2222', task);
    expect(s.passed).toBe(true);
    expect(s.recall).toBe(1);
  });

  it('does not credit a paraphrase without the literal', () => {
    expect(scoreAnswer('there was a constraint about legacy arguments', task).recall).toBe(0);
  });

  it('counts an unplanted code as fabricated, once per distinct code', () => {
    const s = scoreAnswer('ALPHA_1111, GAMMA_3333, GAMMA_3333, DELTA_4444', task);
    expect(s.fabricated).toBe(2);
  });

  it('does not treat a planted literal as fabricated', () => {
    expect(scoreAnswer('ALPHA_1111 BETA_2222', task).fabricated).toBe(0);
  });
});

describe('StateEngine RFC 7396 merge patch retention', () => {
  it('preserves unmentioned keys across successive patches', async () => {
    const { StateEngine } = await import('../../state/state-engine.js');
    const { serializeStateToMarkdown } = await import('../../state/serializer.js');
    const Database = (await import('better-sqlite3')).default;

    const engine = new StateEngine(new Database(':memory:'));
    try {
      engine.initState('task-1', 'Goal', ['step 1']);
      // Turn 1: adds constraint
      engine.patchState('task-1', {
        facts: {
          learned_constraints: ['CONSTRAINT ALPHA_1111: legacy mode required'],
        },
      });
      // Turn 2: adds dead end without mentioning facts
      engine.patchState('task-1', {
        blockers_and_dead_ends: {
          dead_ends: [{ approach: 'DEAD END BETA_2222', reason: 'oom' }],
        },
      });
      // Turn 3: updates next_action
      engine.patchState('task-1', {
        next_action: 'proceed to verify',
      });

      const md = serializeStateToMarkdown(engine.getState('task-1')!.state, 3);
      expect(md).toContain('ALPHA_1111');
      expect(md).toContain('BETA_2222');
    } finally {
      engine.close();
    }
  });
});
