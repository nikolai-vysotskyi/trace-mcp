/**
 * Behavioural coverage for `planTurn()` in
 * `src/tools/navigation/plan-turn.ts` (the implementation behind the
 * `plan_turn` MCP tool). Opening-move router: BM25 search + session
 * journal signals + framework-aware scaffolds + risk + budget advisor.
 *
 * Result envelope: { task, intent, verdict, confidence, reasoning,
 * targets, insertion_points, prior_negative, budget, next_actions }.
 *
 * Uses an in-memory Store + minimal mocked context so we exercise the
 * router contract without standing up the full indexing pipeline. The
 * existing tests/tools/plan-turn.test.ts covers the Laravel fixture
 * path; this file pins the public contract + edge-case envelopes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import { SavingsTracker } from '../../../src/savings.js';
import { SessionJournal } from '../../../src/session/journal.js';
import { type PlanTurnContext, planTurn } from '../../../src/tools/navigation/plan-turn.js';
import { Store } from '../../../src/db/store.js';
import { createTestStore } from '../../test-utils.js';

function seedAuth(store: Store): void {
  const f = store.insertFile('src/auth.ts', 'typescript', 'h-auth', 400);
  store.insertSymbol(f, {
    symbolId: 'src/auth.ts::AuthController#class',
    name: 'AuthController',
    kind: 'class',
    fqn: 'AuthController',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 10,
    signature: 'class AuthController',
  });
  store.insertSymbol(f, {
    symbolId: 'src/auth.ts::login#method',
    name: 'login',
    kind: 'method',
    fqn: 'AuthController.login',
    byteStart: 90,
    byteEnd: 180,
    lineStart: 12,
    lineEnd: 20,
    signature: 'login()',
  });
}

function buildCtx(store: Store): PlanTurnContext {
  return {
    store,
    projectRoot: '/tmp/trace-mcp-fake',
    journal: new SessionJournal(),
    savings: new SavingsTracker('/tmp/trace-mcp-fake'),
    registry: new PluginRegistry(),
    has: () => false,
  };
}

describe('planTurn() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns the documented envelope shape', async () => {
    seedAuth(store);
    const result = await planTurn(buildCtx(store), { task: 'AuthController' });
    expect(typeof result.task).toBe('string');
    expect(typeof result.intent).toBe('string');
    expect(typeof result.verdict).toBe('string');
    expect(typeof result.confidence).toBe('number');
    expect(typeof result.reasoning).toBe('string');
    expect(Array.isArray(result.targets)).toBe(true);
    expect(Array.isArray(result.insertion_points)).toBe(true);
    expect(Array.isArray(result.prior_negative)).toBe(true);
    expect(typeof result.budget).toBe('object');
    expect(Array.isArray(result.next_actions)).toBe(true);
  });

  it('verdict is one of exists / partial / missing / ambiguous', async () => {
    seedAuth(store);
    const result = await planTurn(buildCtx(store), { task: 'AuthController' });
    expect(['exists', 'partial', 'missing', 'ambiguous']).toContain(result.verdict);
  });

  it('intent override wins over keyword inference', async () => {
    seedAuth(store);
    const result = await planTurn(buildCtx(store), {
      task: 'add a new endpoint for webhooks', // would normally classify as new_feature
      intent: 'bugfix',
    });
    expect(result.intent).toBe('bugfix');
  });

  it('maxTargets caps the targets list', async () => {
    // Seed enough symbols that the underlying search could return >2 candidates.
    for (let i = 0; i < 10; i++) {
      const f = store.insertFile(`src/c${i}.ts`, 'typescript', `h-c${i}`, 100);
      store.insertSymbol(f, {
        symbolId: `src/c${i}.ts::Controller${i}#class`,
        name: `Controller${i}`,
        kind: 'class',
        byteStart: 0,
        byteEnd: 30,
        lineStart: 1,
        lineEnd: 1,
        signature: `class Controller${i}`,
      });
    }
    const result = await planTurn(buildCtx(store), { task: 'controller', maxTargets: 2 });
    expect(result.targets.length).toBeLessThanOrEqual(2);
  });

  it('empty task returns a clear missing verdict with no targets', async () => {
    const result = await planTurn(buildCtx(store), { task: '' });
    expect(result.verdict).toBe('missing');
    expect(result.confidence).toBe(1);
    expect(result.targets).toEqual([]);
    expect(result.insertion_points).toEqual([]);
    expect(result.reasoning).toMatch(/empty/i);
  });

  it('empty index against a real task returns missing verdict', async () => {
    const result = await planTurn(buildCtx(store), { task: 'add a new feature' });
    expect(result.verdict).toBe('missing');
    expect(result.targets).toEqual([]);
  });
});
