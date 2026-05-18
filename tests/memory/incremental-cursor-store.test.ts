import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

/**
 * Tests for the incremental session-mining cursor (P2.3).
 *
 * Exercises the new DecisionStore surface in isolation: schema migration,
 * cursor read/write, and back-compat with the legacy `markSessionMined`.
 */
describe('DecisionStore — incremental session-mining cursor', () => {
  let store: DecisionStore;
  let dbPath: string;
  let tmpDir: string;
  const SESSION = '/tmp/fake-session.jsonl';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-store-test-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns {cursor:0, reason:"unmined"} on a missing row', () => {
    const cursor = store.getSessionCursor(SESSION, 1000);
    expect(cursor).toEqual({ cursor: 0, reason: 'unmined' });
  });

  it('returns null when size and mtime are unchanged since last pass', () => {
    store.updateSessionCursor({
      sessionPath: SESSION,
      cursor: 500,
      size: 500,
      modifiedMs: 1_700_000_000_000,
      decisionsFound: 3,
    });
    expect(store.getSessionCursor(SESSION, 500, 1_700_000_000_000)).toBeNull();
  });

  it('still skips on size-match when mtime is not supplied (append-only assumption)', () => {
    store.updateSessionCursor({
      sessionPath: SESSION,
      cursor: 500,
      size: 500,
      modifiedMs: 1_700_000_000_000,
      decisionsFound: 0,
    });
    expect(store.getSessionCursor(SESSION, 500)).toBeNull();
  });

  it('returns {cursor:lastOffset, reason:"incremental"} after the file grew', () => {
    store.updateSessionCursor({
      sessionPath: SESSION,
      cursor: 500,
      size: 500,
      modifiedMs: 1_700_000_000_000,
      decisionsFound: 1,
    });
    const cursor = store.getSessionCursor(SESSION, 800, 1_700_000_001_000);
    expect(cursor).toEqual({ cursor: 500, reason: 'incremental' });
  });

  it('returns {cursor:0, reason:"restart_shrunk"} when the file shrank (rotation)', () => {
    store.updateSessionCursor({
      sessionPath: SESSION,
      cursor: 1500,
      size: 1500,
      modifiedMs: 1_700_000_000_000,
      decisionsFound: 5,
    });
    const cursor = store.getSessionCursor(SESSION, 200, 1_700_000_500_000);
    expect(cursor).toEqual({ cursor: 0, reason: 'restart_shrunk' });
  });

  it('returns incremental when size matches but mtime differs (file rewritten to same length)', () => {
    store.updateSessionCursor({
      sessionPath: SESSION,
      cursor: 500,
      size: 500,
      modifiedMs: 1_700_000_000_000,
      decisionsFound: 0,
    });
    // Same size, newer mtime → we re-read from the cursor offset.
    const cursor = store.getSessionCursor(SESSION, 500, 1_700_000_500_000);
    expect(cursor).toEqual({ cursor: 500, reason: 'incremental' });
  });

  it('updateSessionCursor is idempotent on identical inputs', () => {
    const opts = {
      sessionPath: SESSION,
      cursor: 100,
      size: 100,
      modifiedMs: 1_700_000_000_000,
      decisionsFound: 0,
    };
    store.updateSessionCursor(opts);
    store.updateSessionCursor(opts);
    // Two writes, identical contents — getter still returns null (unchanged).
    expect(store.getSessionCursor(SESSION, 100, 1_700_000_000_000)).toBeNull();
    expect(store.getMinedSessionCount()).toBe(1);
  });

  it('updateSessionCursor accumulates decisions_found across passes', () => {
    store.updateSessionCursor({
      sessionPath: SESSION,
      cursor: 100,
      size: 100,
      modifiedMs: 1_700_000_000_000,
      decisionsFound: 2,
    });
    store.updateSessionCursor({
      sessionPath: SESSION,
      cursor: 200,
      size: 200,
      modifiedMs: 1_700_000_001_000,
      decisionsFound: 3,
    });
    // No direct getter, but isSessionMined should be true and only one row.
    expect(store.isSessionMined(SESSION)).toBe(true);
    expect(store.getMinedSessionCount()).toBe(1);
  });

  it('back-compat: markSessionMined still works and isSessionMined sees it', () => {
    store.markSessionMined(SESSION, 4);
    expect(store.isSessionMined(SESSION)).toBe(true);
    // markSessionMined writes cursor=0/last_size=0, so the next cursor read
    // with any positive size looks like the file grew → incremental from 0.
    const cursor = store.getSessionCursor(SESSION, 100, Date.now());
    expect(cursor?.reason).toBe('incremental');
    expect(cursor?.cursor).toBe(0);
  });

  it('schema migration is idempotent — re-opening the same DB does not error', () => {
    store.updateSessionCursor({
      sessionPath: SESSION,
      cursor: 50,
      size: 50,
      modifiedMs: 1_700_000_000_000,
      decisionsFound: 1,
    });
    store.close();
    // Re-open → preMigrate runs again over an already-migrated schema.
    const reopened = new DecisionStore(dbPath);
    try {
      const cursor = reopened.getSessionCursor(SESSION, 100, 1_700_000_001_000);
      expect(cursor).toEqual({ cursor: 50, reason: 'incremental' });
    } finally {
      reopened.close();
    }
    // Reassign so afterEach's close() is a no-op-safe second close.
    store = new DecisionStore(dbPath);
  });
});
