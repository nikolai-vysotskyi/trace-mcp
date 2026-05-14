/**
 * Behavioural coverage for the `invalidate_decision` MCP tool. The tool
 * wraps `DecisionStore.invalidateDecision` and is the documented path for
 * marking a decision as superseded.
 *
 * Cases:
 *  - invalidating a known id sets `valid_until` and drops the row from the
 *    default query_decisions result
 *  - non-existent id returns false (the tool layer turns that into an error
 *    payload — pinned to the store's actual boolean contract here)
 *  - invalidating an already-invalidated row returns false (NOT idempotently
 *    re-stamps `valid_until`). This is the documented contract and the bug
 *    flag if it changes; we assert what the code actually does today.
 *  - custom valid_until ISO string is respected; default = now()
 *  - invalidated rows are still findable when
 *    `query_decisions { include_invalidated: true }`
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../../src/memory/decision-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

const PROJECT = '/projects/invalidate-decision-fixture';

describe('invalidate_decision — behavioural contract', () => {
  let store: DecisionStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir('invalidate-decision-behav-');
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
  });

  it('invalidating a known id sets valid_until and drops the row from default queries', () => {
    const added = store.addDecision({
      title: 'Use Vue 2',
      content: 'Vue 2 is the current standard.',
      type: 'tech_choice',
      project_root: PROJECT,
    });

    expect(added.valid_until).toBeNull();
    const ok = store.invalidateDecision(added.id);
    expect(ok).toBe(true);

    const fetched = store.getDecision(added.id);
    expect(fetched?.valid_until).toBeTruthy();
    // ISO timestamp shape.
    expect(fetched?.valid_until).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // Default query excludes invalidated rows.
    const def = store.queryDecisions({ project_root: PROJECT });
    expect(def.some((r) => r.id === added.id)).toBe(false);
  });

  it('invalidating an already-invalidated row returns false (pin actual contract)', () => {
    const added = store.addDecision({
      title: 'Use Webpack 4',
      content: 'Bundler choice.',
      type: 'tech_choice',
      project_root: PROJECT,
    });

    const first = store.invalidateDecision(added.id);
    expect(first).toBe(true);
    const beforeSecond = store.getDecision(added.id);
    const firstUntil = beforeSecond?.valid_until;

    // Re-invalidating returns false (no-op): the WHERE clause requires
    // valid_until IS NULL, so the second UPDATE matches zero rows.
    const second = store.invalidateDecision(added.id);
    expect(second).toBe(false);

    // And the original valid_until is preserved — the row is NOT re-stamped.
    const afterSecond = store.getDecision(added.id);
    expect(afterSecond?.valid_until).toBe(firstUntil);
  });

  it('non-existent id returns false (no-op contract)', () => {
    const ok = store.invalidateDecision(999_999);
    expect(ok).toBe(false);
  });

  it('custom valid_until ISO string is respected; omission defaults to now()', () => {
    const explicit = store.addDecision({
      title: 'Use GitFlow',
      content: 'Branching model.',
      type: 'convention',
      project_root: PROJECT,
    });
    const customUntil = '2025-01-15T10:30:00.000Z';
    const ok = store.invalidateDecision(explicit.id, customUntil);
    expect(ok).toBe(true);
    expect(store.getDecision(explicit.id)?.valid_until).toBe(customUntil);

    // Omitting valid_until defaults to "now" — assert it lands within a
    // sensible window around the current time rather than the exact value.
    const implicit = store.addDecision({
      title: 'Use semver',
      content: 'Version everything.',
      type: 'convention',
      project_root: PROJECT,
    });
    const beforeMs = Date.now();
    const ok2 = store.invalidateDecision(implicit.id);
    const afterMs = Date.now();
    expect(ok2).toBe(true);
    const stamped = store.getDecision(implicit.id)?.valid_until;
    expect(stamped).toBeTruthy();
    const stampedMs = Date.parse(stamped ?? '');
    // 1s slack to absorb wall-clock granularity.
    expect(stampedMs).toBeGreaterThanOrEqual(beforeMs - 1000);
    expect(stampedMs).toBeLessThanOrEqual(afterMs + 1000);
  });

  it('invalidated rows are findable when include_invalidated: true', () => {
    const a = store.addDecision({
      title: 'Decision A',
      content: 'A content',
      type: 'preference',
      project_root: PROJECT,
    });
    const b = store.addDecision({
      title: 'Decision B',
      content: 'B content',
      type: 'preference',
      project_root: PROJECT,
    });

    store.invalidateDecision(a.id);

    // Default query — only B is visible.
    const def = store.queryDecisions({ project_root: PROJECT });
    expect(def.some((r) => r.id === a.id)).toBe(false);
    expect(def.some((r) => r.id === b.id)).toBe(true);

    // With include_invalidated — both are visible.
    const all = store.queryDecisions({
      project_root: PROJECT,
      include_invalidated: true,
    });
    expect(all.some((r) => r.id === a.id)).toBe(true);
    expect(all.some((r) => r.id === b.id)).toBe(true);
  });
});
