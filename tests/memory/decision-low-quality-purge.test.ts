/**
 * TRA-1619 Finding B — one-shot sweep over pre-gate mined fragments.
 *
 * `purgeLowQualityDecisions` re-applies today's mined-decision quality gate
 * to active `source='mined'` rows and invalidates (never deletes) the ones
 * that fail it: legacy fragment titles mined before the narration /
 * truncation gates existed (#17, TRA-1056, TRA-1619B).
 *
 * Guarantees under test:
 *   - mined fragments (the TRA-1617 reporter shapes) are flagged + invalidated
 *   - dry_run reports without writing
 *   - manual / auto rows are never touched (gate N/A to authored content)
 *   - human-approved rows are never touched
 *   - already-invalidated rows are not re-scanned
 *   - project_root scoping works
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionInput } from '../../src/memory/decision-store.js';
import { DecisionStore } from '../../src/memory/decision-store.js';

const PROJECT = '/projects/purge-fixture';
const OTHER_PROJECT = '/projects/purge-other';
const GOOD_SUMMARY = 'A real English summary long enough to pass the content-length floor here.';

function mined(title: string, extra?: Partial<DecisionInput>): DecisionInput {
  return {
    title,
    content: GOOD_SUMMARY,
    type: 'tech_choice',
    project_root: PROJECT,
    source: 'mined',
    confidence: 0.85,
    ...extra,
  };
}

const JUNK_TITLES = [
  'investigation',
  'I change this function',
  'my changes',
  'our changes',
  'now passes (4 failures over 5). Let me debug',
  'commits and near-daily releases...',
  'found. Let me verify by also checking tests and callers',
  'exposes ~150 MCP tools',
];

describe('purgeLowQualityDecisions (TRA-1619B)', () => {
  let store: DecisionStore;
  let tmpDir: string;
  let junkIds: number[];
  let legitMinedId: number;
  let groundedFirstPersonId: number;
  let manualJunkId: number;
  let approvedJunkId: number;
  let pendingJunkId: number;
  let deadJunkId: number;
  let otherProjectJunkId: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-purge-'));
    store = new DecisionStore(path.join(tmpDir, 'decisions.db'));
    junkIds = JUNK_TITLES.map((title) => store.addDecision(mined(title)).id);

    legitMinedId = store.addDecision(
      mined('Use PostgreSQL over MySQL for JSONB support', {
        content:
          'We chose PostgreSQL because its JSONB indexing and full-text search fit our query patterns better than MySQL.',
      }),
    ).id;
    groundedFirstPersonId = store.addDecision(
      mined('We are using PostgreSQL instead of MySQL for JSONB support'),
    ).id;
    // Authored rows the gate must never touch, even with junk-shaped titles.
    manualJunkId = store.addDecision({
      title: 'my changes',
      content: GOOD_SUMMARY,
      type: 'tech_choice',
      project_root: PROJECT,
      source: 'manual',
    }).id;
    approvedJunkId = store.addDecision(mined('our changes', { review_status: 'approved' })).id;
    pendingJunkId = store.addDecision(mined('my changes', { review_status: 'pending' })).id;
    // Already-invalidated junk is out of scope for the sweep.
    deadJunkId = store.addDecision(mined('my changes')).id;
    store.invalidateDecision(deadJunkId);
    // Other-project junk — only swept unscoped or with a matching scope.
    otherProjectJunkId = store.addDecision(mined('my changes', { project_root: OTHER_PROJECT })).id;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dry_run flags fragments without writing', () => {
    const res = store.purgeLowQualityDecisions({ dry_run: true });
    // Scanned: 8 seeded junk + legit + grounded-first-person + pending + other-project.
    // (Manual, approved, and already-invalidated rows are out of scope.)
    expect(res.scanned).toBe(JUNK_TITLES.length + 4);
    expect(res.invalidated).toBe(0);
    // Flagged: 8 seeded junk + pending junk + other-project junk.
    expect(res.rows).toHaveLength(JUNK_TITLES.length + 2);
    const flaggedIds = new Set(res.rows.map((r) => r.id));
    for (const id of junkIds) expect(flaggedIds.has(id)).toBe(true);
    expect(flaggedIds.has(pendingJunkId)).toBe(true);
    expect(flaggedIds.has(otherProjectJunkId)).toBe(true);
    for (const row of res.rows) expect(row.reason.length).toBeGreaterThan(0);
    // Nothing written: every flagged row is still active.
    for (const id of [...junkIds, pendingJunkId, otherProjectJunkId]) {
      expect(store.getDecision(id)?.valid_until).toBeNull();
    }
  });

  it('apply invalidates fragments and spares everything else', () => {
    const res = store.purgeLowQualityDecisions({});
    expect(res.invalidated).toBe(JUNK_TITLES.length + 2);
    for (const id of [...junkIds, pendingJunkId, otherProjectJunkId]) {
      expect(store.getDecision(id)?.valid_until).not.toBeNull();
    }
    // Legit mined, grounded first-person, manual, approved, dead: untouched.
    for (const id of [legitMinedId, groundedFirstPersonId, manualJunkId, approvedJunkId]) {
      expect(store.getDecision(id)?.valid_until).toBeNull();
    }
    expect(store.getDecision(deadJunkId)?.valid_until).not.toBeNull();
  });

  it('project_root scopes the sweep', () => {
    const res = store.purgeLowQualityDecisions({ project_root: OTHER_PROJECT });
    expect(res.scanned).toBe(1);
    expect(res.invalidated).toBe(1);
    expect(res.rows[0].id).toBe(otherProjectJunkId);
    // Home-project junk is still active.
    for (const id of junkIds) {
      expect(store.getDecision(id)?.valid_until).toBeNull();
    }
  });

  it('invalidated fragments disappear from default retrieval', () => {
    store.purgeLowQualityDecisions({});
    const rows = store.queryDecisions({ project_root: PROJECT, limit: 100 });
    // Any surviving junk-titled row must be an authored/approved survivor,
    // never an auto-approved mined row.
    for (const row of rows) {
      if (JUNK_TITLES.includes(row.title)) {
        expect(row.source !== 'mined' || row.review_status === 'approved').toBe(true);
      }
    }
    // No active auto-approved mined row carries a junk title anymore.
    const minedActive = rows.filter((r) => r.source === 'mined' && r.review_status !== 'approved');
    for (const junk of JUNK_TITLES) {
      expect(minedActive.map((r) => r.title)).not.toContain(junk);
    }
    expect(rows.map((r) => r.title)).toContain('Use PostgreSQL over MySQL for JSONB support');
  });
});
