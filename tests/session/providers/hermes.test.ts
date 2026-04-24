import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';

import { HermesSessionProvider } from '../../../src/session/providers/hermes.js';
import {
  __resetSessionProviderRegistryForTests,
  getSessionProviderRegistry,
} from '../../../src/session/providers/registry.js';

const require = createRequire(import.meta.url);
type BetterSqlite = new (
  filename: string,
  opts?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
  close: () => void;
};
const Database = require('better-sqlite3') as BetterSqlite;

/** Materialize a minimal Hermes-shaped state.db under `<home>/.hermes/` so the
 *  provider has something real to open. Schema mirrors the subset we use in
 *  hermes.ts (sessions + messages with the feature-detected columns). */
function seedHermesHome(home: string): string {
  const hermesDir = path.join(home, '.hermes');
  fs.mkdirSync(hermesDir, { recursive: true });
  const dbPath = path.join(hermesDir, 'state.db');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      parent_session_id TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      title TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT,
      content TEXT,
      tool_name TEXT,
      tool_input TEXT,
      tool_result TEXT,
      created_at INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER
    );
  `);

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, source, parent_session_id, created_at, updated_at, title)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertSession.run('sess-alpha', 'cli', null, 1_714_000_000_000, 1_714_000_120_000, 'alpha session');
  insertSession.run('sess-beta', 'telegram', null, 1_714_100_000_000, 1_714_100_090_000, 'beta session');

  const insertMsg = db.prepare(
    `INSERT INTO messages
      (session_id, role, content, tool_name, tool_input, tool_result, created_at, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertMsg.run('sess-alpha', 'user', 'pls read src/main.ts', null, null, null, 1_714_000_000_000, null, null);
  insertMsg.run(
    'sess-alpha',
    'assistant',
    'We should extract the config loader into its own module because the current approach duplicates parsing.',
    'Read',
    JSON.stringify({ file_path: 'src/main.ts' }),
    null,
    1_714_000_060_000,
    100,
    40,
  );
  insertMsg.run('sess-alpha', 'tool', '// file content', null, null, 'const x = 1;', 1_714_000_061_000, null, null);
  insertMsg.run('sess-beta', 'user', 'unrelated', null, null, null, 1_714_100_000_000, null, null);

  db.close();
  return dbPath;
}

describe('HermesSessionProvider', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-hermes-'));
    __resetSessionProviderRegistryForTests();
  });

  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    __resetSessionProviderRegistryForTests();
  });

  it('returns an empty discovery when no state.db exists', async () => {
    const provider = new HermesSessionProvider();
    const handles = await provider.discover({ homeDir: fakeHome });
    expect(handles).toEqual([]);
  });

  it('discovers every session row from state.db', async () => {
    seedHermesHome(fakeHome);
    const provider = new HermesSessionProvider();
    const handles = await provider.discover({ homeDir: fakeHome });

    expect(handles).toHaveLength(2);
    const ids = handles.map((h) => h.sessionId).sort();
    expect(ids).toEqual(['sess-alpha', 'sess-beta']);

    for (const h of handles) {
      expect(h.providerId).toBe('hermes');
      expect(h.projectPath).toBeUndefined(); // Hermes is global
      expect(h.sourcePath).toMatch(/^sqlite:\/\/.*state\.db\?row=/);
      expect(h.lastModifiedMs).toBeGreaterThan(0);
    }
  });

  it('streams messages in chronological order with tool metadata', async () => {
    seedHermesHome(fakeHome);
    const provider = new HermesSessionProvider();
    const [alpha] = (await provider.discover({ homeDir: fakeHome })).filter(
      (h) => h.sessionId === 'sess-alpha',
    );
    expect(alpha).toBeDefined();

    const msgs: Awaited<ReturnType<typeof collect>> = [];
    async function collect(h: typeof alpha) {
      const out = [];
      for await (const m of provider.streamMessages(h)) out.push(m);
      return out;
    }
    for (const m of await collect(alpha)) msgs.push(m);

    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].text).toBe('pls read src/main.ts');

    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].toolName).toBe('Read');
    expect(msgs[1].toolInput).toEqual({ file_path: 'src/main.ts' });
    expect(msgs[1].tokenUsage).toEqual({ inputTokens: 100, outputTokens: 40 });

    // The tool role survives normalization (not remapped to assistant).
    expect(msgs[2].role).toBe('tool');
    expect(msgs[2].toolResult).toBe('const x = 1;');
  });

  it('parse() returns a ParsedSession with tool call count reflecting the stream', async () => {
    seedHermesHome(fakeHome);
    const provider = new HermesSessionProvider();
    const [alpha] = (await provider.discover({ homeDir: fakeHome })).filter(
      (h) => h.sessionId === 'sess-alpha',
    );

    const parsed = await provider.parse(alpha);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary.sessionId).toBe('sess-alpha');
    expect(parsed!.summary.toolCallCount).toBe(1);
    expect(parsed!.summary.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
    expect(parsed!.summary.startedAt).not.toBe('');
    expect(parsed!.summary.endedAt).not.toBe('');
  });

  it('profile scoping picks up <home>/profiles/<name>/state.db', async () => {
    const profileDir = path.join(fakeHome, '.hermes', 'profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });

    const profileDbHome = path.join(fakeHome, '.hermes', 'profiles');
    // Seed the profile DB using the same helper but pointing at its parent.
    const db = new Database(path.join(profileDir, 'state.db'));
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at INTEGER);
    `);
    db.prepare(`INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)`).run(
      'p-1',
      1_714_000_000_000,
      1_714_000_000_000,
    );
    db.close();
    void profileDbHome;

    const provider = new HermesSessionProvider();
    const handles = await provider.discover({
      homeDir: fakeHome,
      configOverrides: { profile: 'work' },
    });
    expect(handles).toHaveLength(1);
    expect(handles[0].sessionId).toBe('work:p-1');
  });

  it('registry singleton rejects duplicate provider registration', () => {
    const registry = getSessionProviderRegistry();
    registry.register(new HermesSessionProvider());
    expect(() => registry.register(new HermesSessionProvider())).toThrowError(
      /already registered/,
    );
  });
});
