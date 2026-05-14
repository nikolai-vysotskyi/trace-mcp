/**
 * Behavioural coverage for `DecisionStore.queryDecisions()` (the
 * `query_decisions` MCP tool). Asserts filter contracts: tag, service_name,
 * review_status, include_invalidated, and full-text search returning matching
 * rows rather than the whole table.
 *
 * NOTE: the implementation sorts by `valid_from DESC`, NOT by FTS relevance.
 * The brief's "sorted by relevance" expectation does not match the current
 * source — we assert the documented behaviour (matching subset + DESC order)
 * instead of asserting a relevance ranking the code does not provide.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../../src/memory/decision-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

const PROJECT = '/projects/behavioural-fixture';

describe('DecisionStore.queryDecisions() — behavioural contract', () => {
  let store: DecisionStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir('decision-behav-');
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);

    store.addDecision({
      title: 'Switched cache to Redis',
      content: 'Adopted Redis to handle session storage at scale.',
      type: 'architecture_decision',
      project_root: PROJECT,
      service_name: 'auth-api',
      tags: ['caching', 'performance'],
      valid_from: '2024-01-01T00:00:00.000Z',
    });
    store.addDecision({
      title: 'Pinned Node to 20 LTS',
      content: 'Runtime support window aligned with LTS releases.',
      type: 'tech_choice',
      project_root: PROJECT,
      service_name: 'auth-api',
      tags: ['runtime'],
      valid_from: '2024-02-01T00:00:00.000Z',
    });
    store.addDecision({
      title: 'Drop GraphQL gateway',
      content: 'Frontend now talks to REST directly; cache removed.',
      type: 'architecture_decision',
      project_root: PROJECT,
      service_name: 'gateway',
      tags: ['performance'],
      valid_from: '2024-03-01T00:00:00.000Z',
    });
    store.addDecision({
      title: 'Pending — investigate retries',
      content: 'Should we add exponential backoff to outbound webhooks?',
      type: 'tradeoff',
      project_root: PROJECT,
      tags: ['reliability'],
      review_status: 'pending',
      valid_from: '2024-04-01T00:00:00.000Z',
    });
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
  });

  it('full-text search returns only matching rows', () => {
    const results = store.queryDecisions({ project_root: PROJECT, search: 'Redis' });
    expect(results.length).toBeGreaterThan(0);
    for (const row of results) {
      const blob = `${row.title} ${row.content}`.toLowerCase();
      expect(blob).toContain('redis');
    }
    // Non-matching decisions are excluded from the result set.
    expect(results.every((r) => !r.title.includes('GraphQL'))).toBe(true);
  });

  it('full-text results are sorted by valid_from DESC (documented order)', () => {
    // Hit a broader query so we get >=2 matches.
    const results = store.queryDecisions({ project_root: PROJECT, search: 'cache OR Redis' });
    expect(results.length).toBeGreaterThan(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].valid_from >= results[i].valid_from).toBe(true);
    }
  });

  it('tag filter respected', () => {
    const results = store.queryDecisions({ project_root: PROJECT, tag: 'performance' });
    expect(results.length).toBeGreaterThan(0);
    for (const row of results) {
      expect(row.tags ?? '').toContain('performance');
    }
  });

  it('service_name filter scopes to the subproject', () => {
    const results = store.queryDecisions({ project_root: PROJECT, service_name: 'auth-api' });
    expect(results.length).toBeGreaterThan(0);
    for (const row of results) {
      expect(row.service_name).toBe('auth-api');
    }
    // Verify a different service yields different rows.
    const gw = store.queryDecisions({ project_root: PROJECT, service_name: 'gateway' });
    expect(gw.length).toBeGreaterThan(0);
    expect(gw.every((r) => r.service_name === 'gateway')).toBe(true);
  });

  it('review_status filter narrows to pending queue when set', () => {
    const pending = store.queryDecisions({ project_root: PROJECT, review_status: 'pending' });
    expect(pending.length).toBeGreaterThan(0);
    for (const row of pending) {
      expect(row.review_status).toBe('pending');
    }
    // Default query hides pending rows.
    const def = store.queryDecisions({ project_root: PROJECT });
    expect(def.every((r) => r.review_status !== 'pending')).toBe(true);
  });

  it('include_invalidated default false hides invalidated rows', () => {
    const all = store.queryDecisions({ project_root: PROJECT });
    expect(all.length).toBeGreaterThan(0);

    // Invalidate one row, then re-query.
    const victim = all[0];
    const ok = store.invalidateDecision(victim.id);
    expect(ok).toBe(true);

    const afterDefault = store.queryDecisions({ project_root: PROJECT });
    expect(afterDefault.some((r) => r.id === victim.id)).toBe(false);

    const withInvalidated = store.queryDecisions({
      project_root: PROJECT,
      include_invalidated: true,
    });
    expect(withInvalidated.some((r) => r.id === victim.id)).toBe(true);
  });
});
