/**
 * Memoir-style review queue — schema migration, capture tier classification,
 * setReviewStatus, and queryDecisions filter behaviour.
 *
 * Mirrors the structure of decision-store-branch.test.ts so the additive
 * migration story is consistent across waves.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REJECT_THRESHOLD,
  DEFAULT_REVIEW_THRESHOLD,
  classifyConfidence,
} from '../../src/memory/conversation-miner.js';
import type { DecisionInput } from '../../src/memory/decision-store.js';
import { DecisionStore } from '../../src/memory/decision-store.js';

// ─── 1. Schema migration ─────────────────────────────────────────────────

describe('schema migration: review_status column', () => {
  let dbPath: string;
  let store: DecisionStore | null;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-review-db-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = null;
  });

  afterEach(() => {
    if (store) store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('creates the review_status column on a fresh DB', () => {
    store = new DecisionStore(dbPath);
    const cols = (store.db.pragma('table_info(decisions)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('review_status');
  });

  it('creates the idx_decisions_review_status index on a fresh DB', () => {
    store = new DecisionStore(dbPath);
    const idx = (
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decisions'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toContain('idx_decisions_review_status');
  });

  it('backfills existing rows to NULL when upgrading from a legacy schema', () => {
    // Build a DB without the review_status column. We include the git_branch
    // column already so we can be sure both additive migrations stack cleanly.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE decisions (
        id              INTEGER PRIMARY KEY,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        type            TEXT NOT NULL,
        project_root    TEXT NOT NULL,
        symbol_id       TEXT,
        file_path       TEXT,
        tags            TEXT,
        valid_from      TEXT NOT NULL,
        valid_until     TEXT,
        session_id      TEXT,
        source          TEXT NOT NULL DEFAULT 'manual',
        confidence      REAL NOT NULL DEFAULT 1.0,
        git_branch      TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE decisions_fts USING fts5(
        title, content, tags,
        content=decisions, content_rowid=id, tokenize='porter unicode61'
      );
      CREATE TRIGGER decisions_ai AFTER INSERT ON decisions BEGIN
        INSERT INTO decisions_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END;
      INSERT INTO decisions (title, content, type, project_root, valid_from, created_at)
      VALUES ('legacy A', 'legacy content', 'preference', '/p', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
             ('legacy B', 'legacy content', 'tech_choice', '/p', '2025-01-02T00:00:00Z', '2025-01-02T00:00:00Z');
    `);
    raw.close();

    store = new DecisionStore(dbPath);
    const rows = store.db
      .prepare('SELECT id, title, review_status FROM decisions ORDER BY id')
      .all() as Array<{
      id: number;
      title: string;
      review_status: string | null;
    }>;
    expect(rows.length).toBe(2);
    expect(rows[0].review_status).toBeNull();
    expect(rows[1].review_status).toBeNull();
  });

  it('is idempotent — opening twice does not error or duplicate the column', () => {
    store = new DecisionStore(dbPath);
    store.close();
    store = new DecisionStore(dbPath);
    const cols = (store.db.pragma('table_info(decisions)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols.filter((c) => c === 'review_status').length).toBe(1);
  });

  it('persists review_status on insert and round-trips through SELECT', () => {
    store = new DecisionStore(dbPath);
    const row = store.addDecision({
      title: 'Borderline',
      content: 'mid-confidence pattern hit',
      type: 'preference',
      project_root: '/p',
      review_status: 'pending',
    });
    expect(row.review_status).toBe('pending');
    const fetched = store.getDecision(row.id);
    expect(fetched?.review_status).toBe('pending');
  });

  it('stores NULL when review_status is omitted (= auto-approved / legacy)', () => {
    store = new DecisionStore(dbPath);
    const row = store.addDecision({
      title: 'Auto-approved',
      content: 'high-confidence row',
      type: 'preference',
      project_root: '/p',
    });
    expect(row.review_status).toBeNull();
  });
});

// ─── 2. Capture path: classifyConfidence ─────────────────────────────────

describe('classifyConfidence (memoir capture path)', () => {
  it('routes high-confidence decisions to auto', () => {
    expect(classifyConfidence(0.9)).toBe('auto');
    expect(classifyConfidence(DEFAULT_REVIEW_THRESHOLD)).toBe('auto');
  });

  it('routes borderline decisions to pending', () => {
    expect(classifyConfidence(0.5)).toBe('pending');
    expect(classifyConfidence(DEFAULT_REJECT_THRESHOLD)).toBe('pending');
    // A hair below the review cutoff should still be pending, not auto.
    expect(classifyConfidence(DEFAULT_REVIEW_THRESHOLD - 0.01)).toBe('pending');
  });

  it('drops decisions below the reject floor entirely', () => {
    expect(classifyConfidence(0.1)).toBe('drop');
    expect(classifyConfidence(DEFAULT_REJECT_THRESHOLD - 0.01)).toBe('drop');
  });

  it('honours overridden thresholds', () => {
    // Stricter review cutoff: 0.9-bound decisions become pending.
    expect(classifyConfidence(0.85, 0.95, 0.5)).toBe('pending');
    // Looser reject floor: rows that would normally drop become pending.
    expect(classifyConfidence(0.2, 0.75, 0.1)).toBe('pending');
  });
});

// ─── 3. Read filter: queryDecisions { review_status, include_pending } ──

describe('queryDecisions: review filter', () => {
  let store: DecisionStore;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-review-filter-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);

    const base: Omit<DecisionInput, 'title' | 'review_status'> = {
      content: 'seeded',
      type: 'preference',
      project_root: '/p',
    };
    store.addDecision({ ...base, title: 'auto 1' /* review_status omitted = NULL */ });
    store.addDecision({ ...base, title: 'auto 2', review_status: null });
    store.addDecision({ ...base, title: 'approved 1', review_status: 'approved' });
    store.addDecision({ ...base, title: 'pending 1', review_status: 'pending' });
    store.addDecision({ ...base, title: 'pending 2', review_status: 'pending' });
    store.addDecision({ ...base, title: 'rejected 1', review_status: 'rejected' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('default behaviour returns NULL + approved (hides pending and rejected)', () => {
    const rows = store.queryDecisions({ project_root: '/p' });
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['approved 1', 'auto 1', 'auto 2']);
  });

  it('include_pending = true also returns pending rows (not rejected)', () => {
    const rows = store.queryDecisions({ project_root: '/p', include_pending: true });
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['approved 1', 'auto 1', 'auto 2', 'pending 1', 'pending 2']);
  });

  it('review_status="pending" returns only pending rows', () => {
    const rows = store.queryDecisions({ project_root: '/p', review_status: 'pending' });
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['pending 1', 'pending 2']);
  });

  it('review_status="rejected" returns only rejected rows', () => {
    const rows = store.queryDecisions({ project_root: '/p', review_status: 'rejected' });
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['rejected 1']);
  });

  it('review_status="approved" returns only explicitly-approved rows (excludes NULL)', () => {
    const rows = store.queryDecisions({ project_root: '/p', review_status: 'approved' });
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['approved 1']);
  });
});

// ─── 4. Review actions: setReviewStatus / countPendingReviews ───────────

describe('setReviewStatus + countPendingReviews', () => {
  let store: DecisionStore;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-review-actions-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('approves a pending decision and removes it from the queue count', () => {
    const row = store.addDecision({
      title: 'mid',
      content: 'borderline',
      type: 'preference',
      project_root: '/p',
      review_status: 'pending',
    });
    expect(store.countPendingReviews('/p')).toBe(1);
    expect(store.setReviewStatus(row.id, 'approved')).toBe(true);
    const updated = store.getDecision(row.id);
    expect(updated?.review_status).toBe('approved');
    expect(store.countPendingReviews('/p')).toBe(0);
  });

  it('rejects a pending decision and hides it from default queries', () => {
    const row = store.addDecision({
      title: 'noisy',
      content: 'low signal',
      type: 'preference',
      project_root: '/p',
      review_status: 'pending',
    });
    expect(store.setReviewStatus(row.id, 'rejected')).toBe(true);
    expect(store.queryDecisions({ project_root: '/p' })).toHaveLength(0);
    expect(store.queryDecisions({ project_root: '/p', review_status: 'rejected' })).toHaveLength(1);
  });

  it('returns false for an unknown id (no-op)', () => {
    expect(store.setReviewStatus(99999, 'approved')).toBe(false);
  });

  it('countPendingReviews ignores invalidated rows', () => {
    const row = store.addDecision({
      title: 'mid',
      content: 'borderline',
      type: 'preference',
      project_root: '/p',
      review_status: 'pending',
    });
    expect(store.countPendingReviews('/p')).toBe(1);
    store.invalidateDecision(row.id);
    expect(store.countPendingReviews('/p')).toBe(0);
  });
});
