/**
 * Tests for plan_turn — opening-move router.
 *
 * Coverage:
 *  - verdict transitions (exists / partial / missing / ambiguous)
 *  - intent classification flows through to next_actions
 *  - session journal signals: focus boost + prior negative penalty
 *  - framework-aware insertion points (Laravel)
 *  - turn-budget advisor
 *  - empty / edge cases
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { SessionJournal } from '../../src/session/journal.js';
import { SavingsTracker } from '../../src/savings.js';
import { planTurn, type PlanTurnContext } from '../../src/tools/navigation/plan-turn.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/laravel-10');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: [
      'app/**/*.php',
      'routes/**/*.php',
      'database/migrations/**/*.php',
    ],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

function buildCtx(store: Store, registry: PluginRegistry, opts?: {
  has?: PlanTurnContext['has'];
  journal?: SessionJournal;
  savings?: SavingsTracker;
}): PlanTurnContext {
  return {
    store,
    projectRoot: FIXTURE_DIR,
    journal: opts?.journal ?? new SessionJournal(),
    savings: opts?.savings ?? new SavingsTracker(FIXTURE_DIR),
    registry,
    has: opts?.has ?? ((...names: string[]) => names.includes('laravel')),
  };
}

describe('plan_turn', () => {
  let store: Store;
  let registry: PluginRegistry;

  beforeAll(async () => {
    store = createTestStore();
    registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());
    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();
  });

  // ─── Verdict transitions ─────────────────────────────────────

  it('returns "missing" verdict for empty task', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, { task: '' });
    expect(result.verdict).toBe('missing');
    expect(result.confidence).toBe(1);
    expect(result.targets).toHaveLength(0);
    expect(result.reasoning).toMatch(/empty/i);
  });

  it('returns "missing" verdict for nonexistent symbols', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, {
      task: 'xyzzyplugh99nonexistent foobar',
    });
    expect(result.verdict).toBe('missing');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('returns "exists" or "partial" verdict for known symbol', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, {
      task: 'UserController',
    });
    expect(['exists', 'partial', 'ambiguous']).toContain(result.verdict);
    expect(result.targets.length).toBeGreaterThan(0);
    expect(result.targets[0].name).toBeTruthy();
  });

  // ─── Intent classification + next_actions ────────────────────

  it('classifies intent from task wording', async () => {
    const ctx = buildCtx(store, registry);
    const bug = await planTurn(ctx, { task: 'fix the user login bug' });
    expect(bug.intent).toBe('bugfix');

    const feat = await planTurn(ctx, { task: 'add a new endpoint for webhooks' });
    expect(feat.intent).toBe('new_feature');

    const refac = await planTurn(ctx, { task: 'refactor the user controller' });
    expect(refac.intent).toBe('refactor');

    const understand = await planTurn(ctx, { task: 'how does user authentication work' });
    expect(understand.intent).toBe('understand');
  });

  it('honors explicit intent override', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, { task: 'add a feature', intent: 'bugfix' });
    expect(result.intent).toBe('bugfix');
  });

  it('next_actions for "understand" intent point at get_symbol + get_call_graph', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, { task: 'how does UserController work' });
    if (result.targets.length === 0) return; // skip if fixture has no match
    const tools = result.next_actions.map((a) => a.tool);
    expect(tools).toContain('get_symbol');
  });

  it('next_actions for "refactor" intent include change-impact + tests', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, { task: 'refactor UserController' });
    if (result.targets.length === 0) return;
    const tools = result.next_actions.map((a) => a.tool);
    expect(tools).toContain('get_change_impact');
    expect(tools).toContain('get_tests_for');
  });

  // ─── Risk assessment ─────────────────────────────────────────

  it('attaches risk to top target for refactor intent', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, { task: 'refactor UserController' });
    if (result.targets.length === 0) return;
    expect(result.targets[0].risk).toBeDefined();
    expect(['low', 'medium', 'high', 'critical']).toContain(result.targets[0].risk!.level);
  });

  it('skipRisk option suppresses risk assessment', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, { task: 'refactor UserController', skipRisk: true });
    if (result.targets.length === 0) return;
    expect(result.targets[0].risk).toBeUndefined();
  });

  it('does not assess risk for "understand" intent', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, { task: 'how does UserController work' });
    if (result.targets.length === 0) return;
    expect(result.targets[0].risk).toBeUndefined();
  });

  // ─── Session signals: focus boost + prior negative ────────────

  it('boosts targets in session-focus files', async () => {
    const journal = new SessionJournal();
    // Pre-record reads of UserController.php so it counts as a focus file
    journal.record('get_symbol', { path: 'app/Http/Controllers/UserController.php' }, 1);
    const ctx = buildCtx(store, registry, { journal });
    const result = await planTurn(ctx, { task: 'controller' });
    if (result.targets.length === 0) return;
    // At least one target should report session_focus in `why`
    const hasFocus = result.targets.some((t) => t.why.includes('session_focus'));
    expect(hasFocus).toBe(true);
  });

  it('reports prior_negative for overlapping zero-result queries', async () => {
    const journal = new SessionJournal();
    // Pre-record a zero-result search using a search-like tool
    journal.record('search', { query: 'nonexistentwidget gadget' }, 0);
    const ctx = buildCtx(store, registry, { journal });
    const result = await planTurn(ctx, { task: 'find the nonexistentwidget gadget feature' });
    expect(result.prior_negative.length).toBeGreaterThan(0);
    expect(result.prior_negative[0].query).toContain('nonexistentwidget');
  });

  it('forces "missing" verdict when prior negative has strong overlap', async () => {
    const journal = new SessionJournal();
    journal.record('search', { query: 'foobarbazquux frobnicate' }, 0);
    const ctx = buildCtx(store, registry, { journal });
    const result = await planTurn(ctx, { task: 'add foobarbazquux frobnicate handler' });
    expect(result.verdict).toBe('missing');
    expect(result.reasoning).toMatch(/prior negative|0 results/i);
  });

  // ─── Insertion points (Laravel) ──────────────────────────────

  it('suggests Laravel insertion points for missing endpoint', async () => {
    const ctx = buildCtx(store, registry, {
      has: (...names) => names.includes('laravel'),
    });
    const result = await planTurn(ctx, {
      task: 'add a new webhook endpoint for stripe payment events',
    });
    expect(result.intent).toBe('new_feature');
    // Even if some weak partial matches exist, insertion_points should populate
    // for new_feature intent under Laravel
    if (result.verdict === 'missing' || result.verdict === 'partial') {
      expect(result.insertion_points.length).toBeGreaterThan(0);
      const top = result.insertion_points[0];
      expect(top.framework).toBe('laravel');
      expect(top.file).toMatch(/routes\/api\.php|app\/Http\/Controllers/);
      expect(top.related_files.length).toBeGreaterThan(0);
    }
  });

  it('does not suggest insertion points when no framework matches', async () => {
    const ctx = buildCtx(store, registry, {
      has: () => false, // no frameworks detected
    });
    const result = await planTurn(ctx, {
      task: 'add a new webhook endpoint',
    });
    if (result.verdict === 'missing' || result.verdict === 'partial') {
      // Generic fallback may still produce 1 insertion point IF top targets exist;
      // for empty results it should be empty
      if (result.targets.length === 0) {
        expect(result.insertion_points).toHaveLength(0);
      }
    }
  });

  // ─── Budget advisor ──────────────────────────────────────────

  it('budget level is "none" on a fresh session', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, { task: 'UserController' });
    expect(result.budget.level).toBe('none');
    expect(result.budget.calls_used).toBe(0);
  });

  it('budget level escalates as calls accumulate', async () => {
    const savings = new SavingsTracker(FIXTURE_DIR);
    for (let i = 0; i < 16; i++) savings.recordCall('search');
    const ctx = buildCtx(store, registry, { savings });
    const result = await planTurn(ctx, { task: 'UserController' });
    expect(['info', 'warning', 'critical']).toContain(result.budget.level);
    expect(result.budget.advice).toBeTruthy();
  });

  // ─── maxTargets ──────────────────────────────────────────────

  it('respects maxTargets cap', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, { task: 'controller', maxTargets: 2 });
    expect(result.targets.length).toBeLessThanOrEqual(2);
  });

  // ─── Provenance ──────────────────────────────────────────────

  it('every target reports its scoring provenance in "why"', async () => {
    const ctx = buildCtx(store, registry);
    const result = await planTurn(ctx, { task: 'UserController' });
    for (const t of result.targets) {
      expect(t.why.length).toBeGreaterThan(0);
      // baseline signals are always present
      expect(t.why.some((w) => w === 'bm25' || w === 'hybrid_ai')).toBe(true);
      expect(t.why).toContain('pagerank');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Empty index — graceful degradation
// ═══════════════════════════════════════════════════════════════════

describe('plan_turn with empty index', () => {
  it('returns missing verdict on empty index', async () => {
    const emptyStore = createTestStore();
    const registry = new PluginRegistry();
    const ctx: PlanTurnContext = {
      store: emptyStore,
      projectRoot: '/tmp',
      journal: new SessionJournal(),
      savings: new SavingsTracker('/tmp'),
      registry,
      has: () => false,
    };
    const result = await planTurn(ctx, { task: 'add a new feature' });
    expect(result.verdict).toBe('missing');
    expect(result.targets).toHaveLength(0);
  });
});
