/**
 * Behavioural coverage for the `reject_decision` MCP tool. The tool wraps
 * `DecisionStore.setReviewStatus(id, 'rejected')`. Rejected rows stay in the
 * database for audit but are hidden from every default query path.
 *
 * Cases:
 *  - rejecting a pending row flips status to 'rejected' and keeps it hidden
 *    from the default query
 *  - rejected rows are findable when `review_status: 'rejected'`
 *  - `include_pending: true` does NOT surface rejected rows — it only adds
 *    the pending tier (documented contract on DecisionQuery)
 *  - idempotent on already-rejected (UPDATE still matches → true)
 *  - non-existent id returns false
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../../src/memory/decision-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

const PROJECT = '/projects/reject-decision-fixture';

describe('reject_decision — behavioural contract', () => {
  let store: DecisionStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir('reject-decision-behav-');
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
  });

  it('rejecting a pending row flips status to "rejected" and keeps it hidden from default queries', () => {
    const pending = store.addDecision({
      title: 'Drop the feature',
      content: 'Not worth the maintenance burden',
      type: 'tradeoff',
      project_root: PROJECT,
      review_status: 'pending',
    });

    const ok = store.setReviewStatus(pending.id, 'rejected');
    expect(ok).toBe(true);
    expect(store.getDecision(pending.id)?.review_status).toBe('rejected');

    // Default query — hidden.
    const def = store.queryDecisions({ project_root: PROJECT });
    expect(def.some((r) => r.id === pending.id)).toBe(false);
  });

  it('rejected rows are findable via review_status: "rejected"', () => {
    const pending = store.addDecision({
      title: 'Find me when rejected',
      content: 'auditable',
      type: 'preference',
      project_root: PROJECT,
      review_status: 'pending',
    });
    store.setReviewStatus(pending.id, 'rejected');

    const rejected = store.queryDecisions({
      project_root: PROJECT,
      review_status: 'rejected',
    });
    expect(rejected.some((r) => r.id === pending.id)).toBe(true);
    expect(rejected.every((r) => r.review_status === 'rejected')).toBe(true);
  });

  it('include_pending: true does not surface rejected rows (only adds the pending tier)', () => {
    const willPend = store.addDecision({
      title: 'Stays pending',
      content: '...',
      type: 'preference',
      project_root: PROJECT,
      review_status: 'pending',
    });
    const willReject = store.addDecision({
      title: 'Gets rejected',
      content: '...',
      type: 'preference',
      project_root: PROJECT,
      review_status: 'pending',
    });
    store.setReviewStatus(willReject.id, 'rejected');

    const withPending = store.queryDecisions({
      project_root: PROJECT,
      include_pending: true,
    });
    expect(withPending.some((r) => r.id === willPend.id)).toBe(true);
    expect(withPending.some((r) => r.id === willReject.id)).toBe(false);
  });

  it('idempotent on already-rejected (returns true; status unchanged)', () => {
    const pending = store.addDecision({
      title: 'Double reject',
      content: '...',
      type: 'preference',
      project_root: PROJECT,
      review_status: 'pending',
    });

    expect(store.setReviewStatus(pending.id, 'rejected')).toBe(true);
    expect(store.getDecision(pending.id)?.review_status).toBe('rejected');
    // Second call returns true (UPDATE still matches the row); end state preserved.
    expect(store.setReviewStatus(pending.id, 'rejected')).toBe(true);
    expect(store.getDecision(pending.id)?.review_status).toBe('rejected');
  });

  it('non-existent id returns false', () => {
    expect(store.setReviewStatus(999_999, 'rejected')).toBe(false);
  });
});
