/**
 * End-to-end verification that the search-time heat-decay multiplier (Task 11)
 * actually changes `order_by:'heat'` ranking with REAL timestamps — not just
 * "the multiplier function exists and returns 1.5/0.3 in isolation".
 *
 * The multiplier boosts (~1.5x) rows whose most-recent activity is within
 * `recencyDays` (default 7) and dampens (~0.3x) rows older than `staleDays`
 * (default 90). These tests drive whole rows through `queryDecisions` and
 * assert the resulting order.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';
import { computeHeat } from '../../src/memory/heat.js';

describe('queryDecisions — search-time heat decay affects ranking', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/heat-decay-e2e';

  const nowMs = Date.now();
  const daysAgoIso = (n: number) => new Date(nowMs - n * 86_400_000).toISOString();

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-heat-decay-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  /**
   * Force a row's created_at + valid_from to a specific timestamp. addDecision
   * always stamps created_at = now(), so we rewrite it directly to simulate an
   * aged decision.
   */
  function ageRow(id: number, iso: string): void {
    store.db
      .prepare('UPDATE decisions SET created_at = ?, valid_from = ? WHERE id = ?')
      .run(iso, iso, id);
  }

  it('ranks a recently-created decision ABOVE an old textually-similar one', () => {
    // Two near-identical decisions; the only material difference is age.
    const oldD = store.addDecision({
      title: 'Use Redis for the session cache',
      content: 'Adopt Redis as the session cache backend.',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    const recentD = store.addDecision({
      title: 'Use Redis for the session cache layer',
      content: 'Adopt Redis as the session cache backend (revised).',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    // Age the "old" one to 200 days ago (past staleDays=90 → 0.3x dampen),
    // keep the "recent" one at ~1 day ago (within recencyDays=7 → 1.5x boost).
    ageRow(oldD.id, daysAgoIso(200));
    ageRow(recentD.id, daysAgoIso(1));

    const res = store.queryDecisions({ project_root: projectRoot, order_by: 'heat' });
    expect(res[0].id).toBe(recentD.id);
    expect(res[res.length - 1].id).toBe(oldD.id);
  });

  it('lets the decay multiplier OVERRIDE a raw-hit advantage held by a stale row', () => {
    // The stale row has MANY hits (higher base heat), but its most-recent
    // activity is long ago → dampened. The fresh row has ZERO hits but is
    // brand new → boosted. This isolates the multiplier: without it, the
    // heavily-hit stale row would win.
    const staleHot = store.addDecision({
      title: 'Legacy auth flow',
      content: 'Old but frequently referenced.',
      type: 'architecture_decision',
      project_root: projectRoot,
    });
    const freshCold = store.addDecision({
      title: 'New auth flow',
      content: 'Just decided, not yet referenced.',
      type: 'architecture_decision',
      project_root: projectRoot,
    });
    ageRow(freshCold.id, daysAgoIso(0.5)); // ~12h old → boost
    ageRow(staleHot.id, daysAgoIso(300)); // very old created_at

    // Give the stale row hits — but stamp last_hit_at far in the past so its
    // most-recent ACTIVITY is still old (still dampened). computeHeat's hit
    // term also decays, so this is a fair fight the fresh row should win.
    store.recordHits([staleHot.id, staleHot.id, staleHot.id, staleHot.id, staleHot.id]);
    store.db
      .prepare('UPDATE decisions SET last_hit_at = ? WHERE id = ?')
      .run(daysAgoIso(200), staleHot.id);

    const res = store.queryDecisions({ project_root: projectRoot, order_by: 'heat' });
    expect(res[0].id).toBe(freshCold.id);
  });

  it('the multiplier itself — not the pre-existing freshness floor — drives the ranking gap', () => {
    // Isolation test: pick ages where computeHeat's OWN exponential freshness
    // floor (halfLifeDays/freshnessDays default 14/7) has already fully
    // decayed to ~0 for BOTH rows, so a bare computeHeat comparison is a near
    // tie. Only the search-time decay multiplier (recencyDays=7 boost,
    // staleDays=90 dampen) can produce a decisive, correctly-ordered gap here.
    const recentD = store.addDecision({
      title: 'Adopt structured logging',
      content: 'Switch to structured JSON logs.',
      type: 'convention',
      project_root: projectRoot,
    });
    const oldD = store.addDecision({
      title: 'Adopt structured logging format',
      content: 'Switch to structured JSON logs (v1).',
      type: 'convention',
      project_root: projectRoot,
    });
    // Use a tiny `heat_freshness_days` override so computeHeat's OWN
    // exponential floor decays to ~0 for BOTH rows well before day 5 — i.e.
    // computeHeat alone cannot meaningfully separate them. The multiplier
    // (heatDecayMultiplier) is NOT parameterized by the query and keeps its
    // own defaults (recencyDays=7 boost, staleDays=90 dampen), so it is the
    // ONLY mechanism that can still tell day-5 (inside the window) apart
    // from day-200 (stale) here.
    const freshnessDaysOverride = 1;
    ageRow(recentD.id, daysAgoIso(5));
    ageRow(oldD.id, daysAgoIso(200));

    // 1) Baseline: computeHeat alone (matching the query's own override, no
    // multiplier) — confirm it does NOT already produce a meaningful,
    // decisive gap on its own; both floors are already flattened to ~0.
    const now = new Date();
    const baseRecent = computeHeat(
      { hit_count: 0, last_hit_at: null, created_at: daysAgoIso(5) },
      { now, freshnessDays: freshnessDaysOverride },
    );
    const baseOld = computeHeat(
      { hit_count: 0, last_hit_at: null, created_at: daysAgoIso(200) },
      { now, freshnessDays: freshnessDaysOverride },
    );
    expect(baseRecent).toBeLessThan(0.05);
    expect(baseOld).toBeLessThan(0.05);
    expect(Math.abs(baseRecent - baseOld)).toBeLessThan(0.05);

    // 2) Actual ranking through queryDecisions applies the multiplier on top
    // of that same near-zero base heat — it must still decisively separate
    // the two, in the right direction, proving the multiplier (not the
    // freshness floor) is what drives the ranking here.
    const res = store.queryDecisions({
      project_root: projectRoot,
      order_by: 'heat',
      heat_freshness_days: freshnessDaysOverride,
    });
    expect(res[0].id).toBe(recentD.id);
    expect(res[1].id).toBe(oldD.id);
  });

  it('recent recall of an OLD decision re-boosts it above an untouched mid-age one', () => {
    // Old created_at but a hit yesterday → activity is recent → boosted.
    // A mid-age decision (30 days, neutral 1.0x) should rank below it.
    const oldButRecalled = store.addDecision({
      title: 'Payment provider choice',
      content: 'Old decision, still hot.',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    const midAge = store.addDecision({
      title: 'Logging format choice',
      content: 'Neither fresh nor stale.',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    ageRow(oldButRecalled.id, daysAgoIso(400));
    ageRow(midAge.id, daysAgoIso(30));
    // Recall the old one yesterday → its activity window is fresh → 1.5x boost.
    store.recordHits([oldButRecalled.id]);
    store.db
      .prepare('UPDATE decisions SET last_hit_at = ? WHERE id = ?')
      .run(daysAgoIso(1), oldButRecalled.id);

    const res = store.queryDecisions({ project_root: projectRoot, order_by: 'heat' });
    const recalledIdx = res.findIndex((r) => r.id === oldButRecalled.id);
    const midIdx = res.findIndex((r) => r.id === midAge.id);
    expect(recalledIdx).toBeLessThan(midIdx);
  });
});
