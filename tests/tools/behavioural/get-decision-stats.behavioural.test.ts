/**
 * Behavioural coverage for `DecisionStore.getStats()` (the `get_decision_stats`
 * MCP tool surface).
 *
 * Asserts:
 *   - Empty store returns zeroed counters with empty buckets.
 *   - With seeded decisions, `{ total, active, invalidated, by_type, by_source }`
 *     reflects the data accurately.
 *   - `by_type` bucket counts match the seeded distribution.
 *   - `invalidated` count matches the number of invalidate_decision calls and
 *     `active = total - invalidated`.
 *   - `projectRoot` filter narrows totals to that project only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../../src/memory/decision-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

const PROJECT = '/projects/decision-stats-fixture';
const OTHER_PROJECT = '/projects/other-fixture';

describe('get_decision_stats — behavioural contract', () => {
  let store: DecisionStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('decision-stats-behav-');
    store = new DecisionStore(path.join(tmpDir, 'decisions.db'));
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
  });

  it('empty store returns zeroed counters with empty buckets', () => {
    const stats = store.getStats();
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.invalidated).toBe(0);
    expect(stats.by_type).toEqual({});
    expect(stats.by_source).toEqual({});
  });

  it('seeded decisions reflect in total, active, by_type, by_source', () => {
    store.addDecision({
      title: 'Picked Redis',
      content: 'Cache layer.',
      type: 'architecture_decision',
      project_root: PROJECT,
      source: 'manual',
    });
    store.addDecision({
      title: 'Picked Postgres',
      content: 'Primary DB.',
      type: 'architecture_decision',
      project_root: PROJECT,
      source: 'manual',
    });
    store.addDecision({
      title: 'Node 20 LTS',
      content: 'Pinned runtime.',
      type: 'tech_choice',
      project_root: PROJECT,
      source: 'mined',
    });

    const stats = store.getStats(PROJECT);
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(3);
    expect(stats.invalidated).toBe(0);
    expect(stats.by_type.architecture_decision).toBe(2);
    expect(stats.by_type.tech_choice).toBe(1);
    expect(stats.by_source.manual).toBe(2);
    expect(stats.by_source.mined).toBe(1);
  });

  it('invalidating decisions increments invalidated count and decrements active', () => {
    const a = store.addDecision({
      title: 'A',
      content: 'a',
      type: 'preference',
      project_root: PROJECT,
    });
    store.addDecision({
      title: 'B',
      content: 'b',
      type: 'preference',
      project_root: PROJECT,
    });
    store.addDecision({
      title: 'C',
      content: 'c',
      type: 'preference',
      project_root: PROJECT,
    });

    expect(store.getStats(PROJECT)).toMatchObject({
      total: 3,
      active: 3,
      invalidated: 0,
    });

    expect(store.invalidateDecision(a.id)).toBe(true);

    const after = store.getStats(PROJECT);
    expect(after.total).toBe(3);
    expect(after.active).toBe(2);
    expect(after.invalidated).toBe(1);
  });

  it('projectRoot filter scopes counters to that project only', () => {
    store.addDecision({
      title: 'In project',
      content: '.',
      type: 'tech_choice',
      project_root: PROJECT,
    });
    store.addDecision({
      title: 'Elsewhere',
      content: '.',
      type: 'tech_choice',
      project_root: OTHER_PROJECT,
    });

    const here = store.getStats(PROJECT);
    expect(here.total).toBe(1);
    expect(here.by_type.tech_choice).toBe(1);

    const there = store.getStats(OTHER_PROJECT);
    expect(there.total).toBe(1);
    expect(there.by_type.tech_choice).toBe(1);

    const all = store.getStats();
    expect(all.total).toBe(2);
    expect(all.by_type.tech_choice).toBe(2);
  });

  it('return shape exposes the documented keys regardless of contents', () => {
    const stats = store.getStats();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('active');
    expect(stats).toHaveProperty('invalidated');
    expect(stats).toHaveProperty('by_type');
    expect(stats).toHaveProperty('by_source');
    expect(typeof stats.total).toBe('number');
    expect(typeof stats.active).toBe('number');
    expect(typeof stats.invalidated).toBe('number');
    expect(typeof stats.by_type).toBe('object');
    expect(typeof stats.by_source).toBe('object');
  });
});
