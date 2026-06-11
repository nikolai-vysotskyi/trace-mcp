/**
 * Tests for session DB seeding + orphan sweep (src/daemon/router/session-db.ts).
 *
 * Background: LocalBackend gives each stdio session its own
 * `<project>-session-<rand>.db`. Before these helpers, every session indexed
 * the project from scratch into an empty DB, and SIGKILLed sessions leaked
 * their DBs forever (observed: 60 orphans, 1.9 GB).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  seedSessionDbFromShared,
  sweepOrphanedSessionDbs,
} from '../../src/daemon/router/session-db.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-sessiondb-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Create a minimal session-shaped DB with a server_state pid row. */
function makeSessionDb(name: string, pid: number | null): string {
  const p = path.join(dir, name);
  const db = new Database(p);
  db.exec(`CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT)`);
  if (pid !== null) {
    db.prepare(`INSERT INTO server_state (key, value) VALUES ('pid', ?)`).run(String(pid));
  }
  db.close();
  return p;
}

/** A PID that cannot belong to a live process (beyond macOS/Linux pid_max). */
const DEAD_PID = 0x7fffffff;

describe('seedSessionDbFromShared', () => {
  it('copies the shared DB content into the session path', async () => {
    const shared = path.join(dir, 'project-abc.db');
    const db = new Database(shared);
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
    db.prepare(`INSERT INTO t (v) VALUES (?)`).run('hello');
    db.close();

    const session = path.join(dir, 'project-abc-session-00112233.db');
    const seeded = await seedSessionDbFromShared(shared, session);

    expect(seeded).toBe(true);
    const out = new Database(session, { readonly: true });
    const row = out.prepare(`SELECT v FROM t`).get() as { v: string };
    out.close();
    expect(row.v).toBe('hello');
  });

  it('returns false when the shared DB does not exist', async () => {
    const session = path.join(dir, 'missing-session-00112233.db');
    const seeded = await seedSessionDbFromShared(path.join(dir, 'nope.db'), session);
    expect(seeded).toBe(false);
    expect(fs.existsSync(session)).toBe(false);
  });

  it('returns false and removes partial files when the source is not a database', async () => {
    const shared = path.join(dir, 'garbage.db');
    fs.writeFileSync(shared, 'this is not sqlite');
    const session = path.join(dir, 'garbage-session-00112233.db');

    const seeded = await seedSessionDbFromShared(shared, session);
    expect(seeded).toBe(false);
    expect(fs.existsSync(session)).toBe(false);
  });
});

describe('sweepOrphanedSessionDbs', () => {
  it('removes session DBs whose owner PID is dead, including sidecars', () => {
    const dead = makeSessionDb('proj-aaaa-session-deadbeef.db', DEAD_PID);
    fs.writeFileSync(`${dead}-wal`, '');
    fs.writeFileSync(`${dead}-shm`, '');

    const { scanned, removed } = sweepOrphanedSessionDbs(dir);
    expect(scanned).toBe(1);
    expect(removed).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(`${dead}-wal`)).toBe(false);
    expect(fs.existsSync(`${dead}-shm`)).toBe(false);
  });

  it('keeps session DBs whose owner is alive', () => {
    const live = makeSessionDb('proj-bbbb-session-cafebabe.db', process.pid);

    const { removed } = sweepOrphanedSessionDbs(dir);
    expect(removed).toBe(0);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('never touches non-session DBs even with a dead pid inside', () => {
    const shared = makeSessionDb('proj-cccc.db', DEAD_PID);

    const { scanned, removed } = sweepOrphanedSessionDbs(dir);
    expect(scanned).toBe(0);
    expect(removed).toBe(0);
    expect(fs.existsSync(shared)).toBe(true);
  });

  it('age-gates files whose owner cannot be determined', () => {
    // Corrupt file (unreadable pid) — fresh: kept.
    const fresh = path.join(dir, 'proj-dddd-session-00aa11bb.db');
    fs.writeFileSync(fresh, 'not sqlite');

    // Corrupt file — older than 7 days: reclaimed.
    const old = path.join(dir, 'proj-eeee-session-22cc33dd.db');
    fs.writeFileSync(old, 'not sqlite');
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(old, eightDaysAgo, eightDaysAgo);

    const { scanned, removed } = sweepOrphanedSessionDbs(dir);
    expect(scanned).toBe(2);
    expect(removed).toBe(1);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('a session DB with no pid row is treated as unknown owner (age-gated)', () => {
    const noPid = makeSessionDb('proj-ffff-session-44ee55ff.db', null);

    const { removed } = sweepOrphanedSessionDbs(dir);
    expect(removed).toBe(0);
    expect(fs.existsSync(noPid)).toBe(true);
  });

  it('returns zeros for a missing directory', () => {
    expect(sweepOrphanedSessionDbs(path.join(dir, 'nope'))).toEqual({ scanned: 0, removed: 0 });
  });
});
