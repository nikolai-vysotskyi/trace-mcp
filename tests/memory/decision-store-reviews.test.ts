/**
 * Tests for the P2.5 review-event log: approve_decision / reject_decision
 * should drop one row per toggle into `decision_reviews`, schema migration
 * is idempotent across re-opens, and listReviewEvents filters by project.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore, extractSignalsForReview } from '../../src/memory/decision-store.js';

describe('DecisionStore review-event log (P2.5)', () => {
  let store: DecisionStore;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-log-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(opts: { project_root?: string; tags?: string[] } = {}) {
    return store.addDecision({
      title: 'Use PostgreSQL',
      content: 'a'.repeat(50),
      type: 'tech_choice',
      project_root: opts.project_root ?? '/projects/myapp',
      file_path: 'src/db.ts',
      tags: opts.tags ?? ['database'],
      review_status: 'pending',
    });
  }

  it('creates the decision_reviews table on a fresh DB', () => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_reviews'")
      .all();
    expect(tables.length).toBe(1);
  });

  it('inserts a review row when status changes to approved', () => {
    const decision = seed();
    const ok = store.setReviewStatus(decision.id, 'approved');
    expect(ok).toBe(true);
    const rows = store.db
      .prepare('SELECT * FROM decision_reviews WHERE decision_id = ?')
      .all(decision.id) as Array<{
      action: string;
      signals_at_decision: string;
      confidence_at_decision: number;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('approve');
    expect(typeof rows[0].confidence_at_decision).toBe('number');
    const signals = JSON.parse(rows[0].signals_at_decision);
    expect(signals.has_code_ref).toBe(true);
    expect(signals.type).toBe('tech_choice');
  });

  it('inserts a review row when status changes to rejected', () => {
    const decision = seed();
    store.setReviewStatus(decision.id, 'rejected');
    const rows = store.db
      .prepare('SELECT action FROM decision_reviews WHERE decision_id = ?')
      .all(decision.id) as Array<{ action: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('reject');
  });

  it('does NOT insert a review row when status changes to pending', () => {
    const decision = seed();
    store.setReviewStatus(decision.id, 'pending');
    const count = (
      store.db
        .prepare('SELECT COUNT(*) as c FROM decision_reviews WHERE decision_id = ?')
        .get(decision.id) as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it('does NOT insert a review row when the decision id does not exist', () => {
    const ok = store.setReviewStatus(99999, 'approved');
    expect(ok).toBe(false);
    const count = (
      store.db.prepare('SELECT COUNT(*) as c FROM decision_reviews').get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
  });

  it('listReviewEvents filters by project_root', () => {
    const a = seed({ project_root: '/projects/A' });
    const b = seed({ project_root: '/projects/B' });
    store.setReviewStatus(a.id, 'approved');
    store.setReviewStatus(b.id, 'rejected');

    const allEvents = store.listReviewEvents();
    expect(allEvents.length).toBe(2);

    const onlyA = store.listReviewEvents({ project_root: '/projects/A' });
    expect(onlyA.length).toBe(1);
    expect(onlyA[0].decision_id).toBe(a.id);
    expect(onlyA[0].action).toBe('approve');

    const onlyB = store.listReviewEvents({ project_root: '/projects/B' });
    expect(onlyB.length).toBe(1);
    expect(onlyB[0].action).toBe('reject');
  });

  it('schema is idempotent — re-opening the store does not error', () => {
    store.close();
    // Second open hits all CREATE TABLE / INDEX IF NOT EXISTS guards.
    const reopened = new DecisionStore(dbPath);
    const tables = reopened.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_reviews'")
      .all();
    expect(tables.length).toBe(1);
    reopened.close();
    // Re-assign so afterEach's close() succeeds.
    store = new DecisionStore(dbPath);
  });

  it('extractSignalsForReview projects DecisionRow to the expected shape', () => {
    const decision = seed({ tags: ['x', 'y', 'z'] });
    const signals = extractSignalsForReview(decision);
    expect(signals.has_code_ref).toBe(true);
    expect(signals.content_length).toBe(50);
    expect(signals.tag_count).toBe(3);
    expect(signals.type).toBe('tech_choice');
    expect(signals.has_service).toBe(false);
  });
});
