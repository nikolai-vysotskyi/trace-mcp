/**
 * Behavioural coverage for `discoverHermesSessions()` — the engine behind the
 * `discover_hermes_sessions` MCP tool.
 *
 * IMPL: src/tools/advanced/hermes-sessions.ts
 *
 * The tool is inline-registered in src/tools/register/advanced.ts and forwards
 * to `discoverHermesSessions({ homeOverride, profile, limit })`. The function
 * delegates to a HermesSessionProvider that reads SQLite state.db files under
 * the Hermes home. We seed real (in-memory-light) SQLite DBs to verify
 * discovery semantics without depending on a real Hermes install.
 *
 * Cases:
 *  - scans <home_override>/state.db plus profiles/<name>/state.db and returns
 *    one DiscoveredHermesSession per session row
 *  - profile filter narrows to a single profile directory and tags sessions
 *    with profile=<name>
 *  - limit caps results, sorted by lastActivity desc
 *  - missing state.db (empty Hermes home) returns enabled=true, sessions=[]
 *  - DiscoveredHermesSession shape: { sessionId, sourcePath, profile,
 *    lastActivity, sizeBytes }
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverHermesSessions } from '../../../src/tools/advanced/hermes-sessions.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

function seedHermesDb(
  dbPath: string,
  rows: Array<{ id: string; startedAt?: number; endedAt?: number; title?: string }>,
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      parent_session_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      title TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      role TEXT,
      content TEXT,
      tool_name TEXT,
      tool_calls TEXT,
      tool_result TEXT,
      timestamp INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER
    );
  `);
  const stmt = db.prepare(
    'INSERT INTO sessions (id, started_at, ended_at, title) VALUES (?, ?, ?, ?)',
  );
  for (const r of rows) {
    stmt.run(r.id, r.startedAt ?? Date.now(), r.endedAt ?? null, r.title ?? null);
  }
  db.close();
}

describe('discoverHermesSessions() — behavioural contract', () => {
  let tmpDir: string;
  let hermesHome: string;

  beforeEach(() => {
    tmpDir = createTmpDir('discover-hermes-behav-');
    hermesHome = path.join(tmpDir, '.hermes');
    fs.mkdirSync(hermesHome, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
  });

  it('returns a populated envelope from a seeded root state.db', async () => {
    seedHermesDb(path.join(hermesHome, 'state.db'), [
      { id: 'sess-root-1', startedAt: 1_700_000_000_000, endedAt: 1_700_000_300_000 },
      { id: 'sess-root-2', startedAt: 1_700_000_100_000, endedAt: 1_700_000_400_000 },
    ]);

    const result = await discoverHermesSessions({ homeOverride: hermesHome });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const env = result.value;
    expect(env.enabled).toBe(true);
    expect(env.total).toBe(2);
    expect(env.sessions.length).toBe(2);

    const ids = env.sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(['sess-root-1', 'sess-root-2']);

    // Root DB sessions have no profile prefix → profile=null.
    expect(env.sessions.every((s) => s.profile === null)).toBe(true);

    const s = env.sessions[0];
    expect(typeof s.sessionId).toBe('string');
    expect(typeof s.sourcePath).toBe('string');
    expect(s.lastActivity === null || typeof s.lastActivity === 'string').toBe(true);
    expect(s.sizeBytes === null || typeof s.sizeBytes === 'number').toBe(true);
  });

  it('profile filter narrows to a single profile directory', async () => {
    seedHermesDb(path.join(hermesHome, 'state.db'), [{ id: 'sess-root' }]);
    seedHermesDb(path.join(hermesHome, 'profiles', 'work', 'state.db'), [
      { id: 'sess-work-a' },
      { id: 'sess-work-b' },
    ]);
    seedHermesDb(path.join(hermesHome, 'profiles', 'personal', 'state.db'), [
      { id: 'sess-personal-a' },
    ]);

    const result = await discoverHermesSessions({
      homeOverride: hermesHome,
      profile: 'work',
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const env = result.value;

    // Only work-profile rows; root state.db is skipped when profile filter is
    // set, and the personal profile is excluded.
    expect(env.sessions.length).toBe(2);
    expect(env.sessions.every((s) => s.profile === 'work')).toBe(true);
    expect(env.sessions.every((s) => s.sessionId.startsWith('work:'))).toBe(true);
  });

  it('limit caps results, sorted by lastActivity desc', async () => {
    seedHermesDb(path.join(hermesHome, 'state.db'), [
      { id: 'old', startedAt: 1_000_000_000_000, endedAt: 1_000_000_100_000 },
      { id: 'mid', startedAt: 1_500_000_000_000, endedAt: 1_500_000_100_000 },
      { id: 'new', startedAt: 1_900_000_000_000, endedAt: 1_900_000_100_000 },
    ]);

    const result = await discoverHermesSessions({ homeOverride: hermesHome, limit: 2 });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const env = result.value;

    // total reports the underlying count; sessions[] is capped.
    expect(env.total).toBe(3);
    expect(env.sessions.length).toBe(2);
    // Most recently active first.
    expect(env.sessions.map((s) => s.sessionId)).toEqual(['new', 'mid']);
  });

  it('empty Hermes home returns enabled=true with no sessions', async () => {
    // hermesHome exists but contains no state.db files.
    const result = await discoverHermesSessions({ homeOverride: hermesHome });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const env = result.value;
    expect(env.enabled).toBe(true);
    expect(env.total).toBe(0);
    expect(env.sessions).toEqual([]);
  });

  it('each discovered session carries the documented shape', async () => {
    seedHermesDb(path.join(hermesHome, 'profiles', 'main', 'state.db'), [
      { id: 'sess-shape', startedAt: 1_700_000_000_000, endedAt: 1_700_000_500_000 },
    ]);

    const result = await discoverHermesSessions({ homeOverride: hermesHome });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const env = result.value;
    expect(env.sessions.length).toBe(1);
    const s = env.sessions[0];

    // Spot-check every advertised field.
    expect(Object.keys(s).sort()).toEqual(
      ['lastActivity', 'profile', 'sessionId', 'sizeBytes', 'sourcePath'].sort(),
    );
    expect(s.profile).toBe('main');
    expect(s.sessionId).toBe('main:sess-shape');
    expect(typeof s.sourcePath).toBe('string');
    // lastActivity should round-trip back from ISO.
    if (s.lastActivity !== null) {
      const parsed = Date.parse(s.lastActivity);
      expect(Number.isFinite(parsed)).toBe(true);
    }
  });
});
