/**
 * Fail-open correctness for staleness verification (Task 3).
 *
 * The module docstring promises: "if verification itself errors, the decision
 * is NOT hidden" (fail-open). A crash inside the verifier must never turn into
 * silent data loss (dropping a decision) OR a thrown error that fails the whole
 * `query_decisions` recall. These tests force the verification path to throw and
 * assert the decision is still returned, unflagged.
 *
 * This is the safety property the shipped 8 tests only exercise via the
 * benign "no git repo" case. Here we make the Store itself blow up.
 */
import type { SymbolRow } from '../../src/db/store.js';
import { Store } from '../../src/db/store.js';
import { describe, expect, it } from 'vitest';
import type { DecisionRow } from '../../src/memory/decision-types.js';
import { verifyDecision, verifyDecisions } from '../../src/memory/decision-verification.js';

function makeDecisionRow(over: Partial<DecisionRow>): DecisionRow {
  return {
    id: 1,
    title: 't',
    content: 'c',
    type: 'architecture_decision',
    project_root: '/p',
    service_name: null,
    symbol_id: 'src/foo.ts::foo#function',
    file_path: 'src/foo.ts',
    tags: null,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_until: null,
    session_id: null,
    source: 'manual',
    confidence: 1,
    git_branch: null,
    review_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    hit_count: 0,
    last_hit_at: null,
    ...over,
  };
}

/**
 * A Store stand-in whose symbol lookup throws — simulates a locked/corrupt
 * index DB, an internal invariant violation, etc. Only the members the
 * verifier touches are implemented.
 */
function throwingStore(): Store {
  return {
    getSymbolBySymbolId(): SymbolRow | undefined {
      throw new Error('simulated index failure (DB locked)');
    },
    getFileById(): undefined {
      throw new Error('should not be reached');
    },
  } as unknown as Store;
}

describe('staleness verification — fail-open on internal error', () => {
  it('verifyDecision returns ok (fail-open) when the Store throws', () => {
    const store = throwingStore();
    const decision = makeDecisionRow({});
    // Must NOT propagate the Store error and must NOT flag the row stale.
    const v = verifyDecision(decision, store, '/nonexistent-root');
    expect(v.verification).toBe('ok');
    expect(v.stale).toBe(false);
  });

  it('verifyDecisions does not drop or crash on a throwing Store (fail-open)', () => {
    const store = throwingStore();
    const anchored = makeDecisionRow({ id: 1, symbol_id: 'src/foo.ts::foo#function' });
    const bare = makeDecisionRow({ id: 2, symbol_id: null });

    // Fail-open: both rows come back, neither flagged, no throw.
    const out = verifyDecisions([anchored, bare], store, '/nonexistent-root');
    expect(out.map((d) => d.id).sort()).toEqual([1, 2]);
    for (const d of out) {
      expect(d).not.toHaveProperty('stale');
    }
  });

  it('verifyDecisions withhold=true still returns rows when verification throws (no silent loss)', () => {
    const store = throwingStore();
    const anchored = makeDecisionRow({ id: 1, symbol_id: 'src/foo.ts::foo#function' });

    // A throw must NOT be treated as "stale" and withheld — that would be a
    // fail-closed silent-data-loss bug. Fail-open: the row survives.
    const out = verifyDecisions([anchored], store, '/nonexistent-root', { withhold: true });
    expect(out.map((d) => d.id)).toEqual([1]);
  });
});
