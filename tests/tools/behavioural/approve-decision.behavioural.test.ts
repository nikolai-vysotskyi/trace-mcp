/**
 * Behavioural coverage for the `approve_decision` MCP tool. The tool wraps
 * `DecisionStore.setReviewStatus(id, 'approved')`. Pending rows live outside
 * default `query_decisions` results; approval flips them into the visible
 * tier without removing them from the database.
 *
 * Cases:
 *  - approving a `review_status: 'pending'` row flips it to 'approved' and
 *    surfaces it in default queries
 *  - approving an already-approved row is idempotent (still returns true)
 *  - non-existent id returns false (the tool layer converts to error payload)
 *  - other rows in the queue are unaffected by an approval
 *  - approved rows are also queryable via review_status: 'approved' filter
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../../src/memory/decision-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

const PROJECT = '/projects/approve-decision-fixture';

describe('approve_decision — behavioural contract', () => {
  let store: DecisionStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir('approve-decision-behav-');
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
  });

  it('approving a pending row flips status to "approved" and surfaces it in default queries', () => {
    const pending = store.addDecision({
      title: 'Maybe move to gRPC',
      content: 'Borderline — needs human eyes.',
      type: 'tradeoff',
      project_root: PROJECT,
      review_status: 'pending',
    });

    // Sanity: pending row hidden by default.
    const beforeDefault = store.queryDecisions({ project_root: PROJECT });
    expect(beforeDefault.some((r) => r.id === pending.id)).toBe(false);

    const ok = store.setReviewStatus(pending.id, 'approved');
    expect(ok).toBe(true);

    const fetched = store.getDecision(pending.id);
    expect(fetched?.review_status).toBe('approved');

    // Now appears in default queries.
    const afterDefault = store.queryDecisions({ project_root: PROJECT });
    expect(afterDefault.some((r) => r.id === pending.id)).toBe(true);
  });

  it('approving an already-approved row is idempotent', () => {
    const pending = store.addDecision({
      title: 'Approve me twice',
      content: 'idempotency check',
      type: 'preference',
      project_root: PROJECT,
      review_status: 'pending',
    });

    const first = store.setReviewStatus(pending.id, 'approved');
    expect(first).toBe(true);
    expect(store.getDecision(pending.id)?.review_status).toBe('approved');

    const second = store.setReviewStatus(pending.id, 'approved');
    // UPDATE still matches the row — store returns true. The end state is
    // unchanged, which is the behavioural contract callers care about.
    expect(second).toBe(true);
    expect(store.getDecision(pending.id)?.review_status).toBe('approved');
  });

  it('non-existent id returns false', () => {
    const ok = store.setReviewStatus(999_999, 'approved');
    expect(ok).toBe(false);
  });

  it('approving one row leaves siblings in the queue unaffected', () => {
    const a = store.addDecision({
      title: 'Pending A',
      content: 'A',
      type: 'preference',
      project_root: PROJECT,
      review_status: 'pending',
    });
    const b = store.addDecision({
      title: 'Pending B',
      content: 'B',
      type: 'preference',
      project_root: PROJECT,
      review_status: 'pending',
    });
    const c = store.addDecision({
      title: 'Pending C',
      content: 'C',
      type: 'preference',
      project_root: PROJECT,
      review_status: 'pending',
    });

    expect(store.setReviewStatus(b.id, 'approved')).toBe(true);

    // A and C are still 'pending'.
    expect(store.getDecision(a.id)?.review_status).toBe('pending');
    expect(store.getDecision(c.id)?.review_status).toBe('pending');
    // B is approved.
    expect(store.getDecision(b.id)?.review_status).toBe('approved');

    // Review queue still has 2 entries.
    expect(store.countPendingReviews(PROJECT)).toBe(2);
  });

  it('approved rows are queryable via review_status: "approved" filter', () => {
    const pending = store.addDecision({
      title: 'Promote to approved',
      content: '...',
      type: 'tradeoff',
      project_root: PROJECT,
      review_status: 'pending',
    });
    store.setReviewStatus(pending.id, 'approved');

    const approved = store.queryDecisions({
      project_root: PROJECT,
      review_status: 'approved',
    });
    expect(approved.length).toBeGreaterThan(0);
    expect(approved.every((r) => r.review_status === 'approved')).toBe(true);
    expect(approved.some((r) => r.id === pending.id)).toBe(true);
  });
});
