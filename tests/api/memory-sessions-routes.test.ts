/**
 * TRA-1065: Memory → Sessions ignored `?project=` and returned the same
 * global mined_sessions list for every project. Pins the scoped contract of
 * GET /api/projects/sessions:
 *
 *   - only sessions belonging to the requested project are returned;
 *   - a project with no mined sessions gets [], not another project's list;
 *   - each row carries session_id (basename without .jsonl) plus the live
 *     file mtime, so the UI can name the session and date it correctly.
 *
 * Hermeticity: the suite-wide isolate-home setup redirects TRACE_MCP_HOME
 * (so decisions.db is per-worker temp), and the Claude home is faked per
 * test via TRACE_MCP_FAKE_HOME + resetModules + dynamic import — the same
 * pattern as tests/analytics/list-all-sessions.snapshot.test.ts. The
 * live-file scenarios create real ~/.claude/projects entries, which must
 * never touch the developer's own session history. (Mocking only
 * 'node:os' with a default import does NOT intercept in this repo — both
 * specifiers plus namespace import are required.)
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { handleMemoryRequest as HandleMemoryRequest } from '../../src/api/memory-routes.js';
import type { DecisionStore as DecisionStoreType } from '../../src/memory/decision-store.js';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof os>('node:os');
  const fake = () => process.env.TRACE_MCP_FAKE_HOME ?? actual.homedir();
  return { ...actual, default: { ...actual, homedir: fake }, homedir: fake };
});
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  const fake = () => process.env.TRACE_MCP_FAKE_HOME ?? actual.homedir();
  return { ...actual, default: { ...actual, homedir: fake }, homedir: fake };
});

interface SessionsBody {
  sessions: Array<{
    session_path: string;
    mined_at: string;
    decisions_found: number;
    session_id: string;
    session_mtime_ms: number;
  }>;
}

describe('GET /api/projects/sessions scoping (TRA-1065)', () => {
  let srv: { baseUrl: string; close: () => Promise<void> } | null = null;
  let handleRequest: typeof HandleMemoryRequest;
  let Store: typeof DecisionStoreType;
  let CLAUDE_PROJECTS_DIR: string;
  let DECISIONS_DB_PATH: string;
  let fakeHome: string;
  let projectA: string;
  let projectB: string;
  let ownSessionPath: string;
  const origEnvHome = process.env.TRACE_MCP_FAKE_HOME;
  const ownSessionId = 'tra1065-own-session';
  const providerKey = 'hermes:tra1065-provider-session';

  beforeEach(async () => {
    // Fake home FIRST, then re-evaluate the modules that freeze
    // CLAUDE_PROJECTS_DIR at import time.
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tra1065-home-'));
    process.env.TRACE_MCP_FAKE_HOME = fakeHome;
    vi.resetModules();
    ({ handleMemoryRequest: handleRequest } = await import('../../src/api/memory-routes.js'));
    ({ DecisionStore: Store } = await import('../../src/memory/decision-store.js'));
    ({ CLAUDE_PROJECTS_DIR, DECISIONS_DB_PATH } = await import('../../src/shared/paths.js'));

    srv = await startTestServer();
    projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'tra1065-projA-'));
    projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'tra1065-projB-'));

    // A real session file belonging to project A (Claw layout).
    const sessionsDir = path.join(projectA, '.claw', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    ownSessionPath = path.join(sessionsDir, `${ownSessionId}.jsonl`);
    fs.writeFileSync(ownSessionPath, '{"type":"session","id":"tra1065"}\n');

    const foreignSessionPath = path.join(
      fakeHome,
      '.claude',
      'projects',
      '-tra1065-no-such-project',
      'tra1065-foreign-session.jsonl',
    );

    const store = new Store(DECISIONS_DB_PATH);
    try {
      store.markSessionMined(ownSessionPath, 2);
      // A mined session from an unrelated project — must never leak into A.
      store.markSessionMined(foreignSessionPath, 0);
      // A synthetic provider key: not a filesystem path, attributed to A
      // via a mined decision carrying project_root + session_id.
      store.markSessionMined(providerKey, 1);
      store.addDecision({
        title: 'tra1065 provider decision',
        content: 'mined from a provider session for project A',
        type: 'preference',
        project_root: projectA,
        session_id: providerKey,
        source: 'mined',
        git_branch: null,
      });
    } finally {
      store.close();
    }
  });

  afterEach(async () => {
    if (srv) await srv.close();
    srv = null;
    if (origEnvHome === undefined) delete process.env.TRACE_MCP_FAKE_HOME;
    else process.env.TRACE_MCP_FAKE_HOME = origEnvHome;
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  function startTestServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!handleRequest(req, res, url)) {
        res.writeHead(404);
        res.end();
      }
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
        resolve({
          baseUrl: `http://127.0.0.1:${addr.port}`,
          close: () =>
            new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
        });
      });
    });
  }

  async function getSessions(projectRoot?: string, limit?: string): Promise<SessionsBody> {
    const params = new URLSearchParams();
    if (projectRoot !== undefined) params.set('project', projectRoot);
    if (limit !== undefined) params.set('limit', limit);
    const res = await fetch(`${srv!.baseUrl}/api/projects/sessions?${params}`);
    expect(res.status).toBe(200);
    return (await res.json()) as SessionsBody;
  }

  function seedMined(
    sessionPath: string,
    decisionsFound: number,
    decision?: { title: string; content: string; project_root: string; session_id: string },
  ): void {
    const store = new Store(DECISIONS_DB_PATH);
    try {
      store.markSessionMined(sessionPath, decisionsFound);
      if (decision) {
        store.addDecision({
          ...decision,
          type: 'preference',
          source: 'mined',
          git_branch: null,
        });
      }
    } finally {
      store.close();
    }
  }

  it('400s when ?project= is missing', async () => {
    const res = await fetch(`${srv!.baseUrl}/api/projects/sessions`);
    expect(res.status).toBe(400);
  });

  it('returns only the requested project sessions, with session identity', async () => {
    const body = await getSessions(projectA);
    const paths = body.sessions.map((s) => s.session_path);
    expect(paths).toContain(ownSessionPath);
    expect(paths).toContain(providerKey);

    const own = body.sessions.find((s) => s.session_path === ownSessionPath);
    expect(own?.session_id).toBe(ownSessionId);
    expect(own?.decisions_found).toBe(2);
    // The session's own date (live file mtime), not the processing date.
    expect(own?.session_mtime_ms).toBe(fs.statSync(ownSessionPath).mtimeMs);
  });

  it('returns [] for a project with no mined sessions (not the global list)', async () => {
    const body = await getSessions(projectB);
    expect(body.sessions).toEqual([]);
  });

  it('respects limit after scoping', async () => {
    const body = await getSessions(projectA, '1');
    expect(body.sessions).toHaveLength(1);
  });

  it('excludes a separate nested Claw project (review)', async () => {
    // A nested independent repo's sessions live under the parent's root
    // tree — the parent must not claim them (exact .claw/sessions dir only).
    const nestedRoot = path.join(projectA, 'independent-repo');
    const nestedSession = path.join(nestedRoot, '.claw', 'sessions', 'nested-session.jsonl');
    fs.mkdirSync(path.dirname(nestedSession), { recursive: true });
    fs.writeFileSync(nestedSession, '{"type":"session","id":"nested"}\n');
    seedMined(nestedSession, 1, {
      title: 'nested project only',
      content: 'belongs to nested project',
      project_root: nestedRoot,
      session_id: 'nested-session',
    });
    const body = await getSessions(projectA);
    expect(body.sessions.map((s) => s.session_path)).not.toContain(nestedSession);
    // …while the nested project itself still sees its own session.
    const nested = await getSessions(nestedRoot);
    expect(nested.sessions.map((s) => s.session_path)).toContain(nestedSession);
  });

  it('excludes Claude sessions with a colliding encoded project path (review)', async () => {
    // encodeDirName is lossy: "/a-b" and "/a/b" collide. Recorded ownership
    // (decisions) must veto the path fallback, not the other way round.
    const ownerRoot = path.join(projectA, 'a-b');
    const requestedRoot = path.join(projectA, 'a', 'b');
    fs.mkdirSync(ownerRoot, { recursive: true });
    fs.mkdirSync(requestedRoot, { recursive: true });
    const encodedOwner = ownerRoot.replace(/[\\/:]+/g, '-');
    expect(requestedRoot.replace(/[\\/:]+/g, '-')).toBe(encodedOwner);
    // Deleted file (row only) in the isolated Claude home.
    const collidingSession = path.join(
      CLAUDE_PROJECTS_DIR,
      encodedOwner,
      'collision-session.jsonl',
    );
    seedMined(collidingSession, 1, {
      title: 'different owner',
      content: 'belongs to hyphenated project',
      project_root: ownerRoot,
      session_id: 'collision-session',
    });
    const body = await getSessions(requestedRoot);
    expect(body.sessions).toEqual([]);
  });

  it('recorded foreign ownership vetoes a LIVE colliding Claude session (review round 2)', async () => {
    // Same collision as above, but the session file really exists, so it is
    // in the collider's live discovery set too. Recorded ownership (decisions
    // + transcript cwd) must still win over discovery.
    const ownerRoot = path.join(projectA, 'a-b');
    const requestedRoot = path.join(projectA, 'a', 'b');
    fs.mkdirSync(ownerRoot, { recursive: true });
    fs.mkdirSync(requestedRoot, { recursive: true });
    const encodedOwner = ownerRoot.replace(/[\\/:]+/g, '-');
    const sessionPath = path.join(CLAUDE_PROJECTS_DIR, encodedOwner, 'live-collision.jsonl');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({
        type: 'user',
        cwd: ownerRoot,
        timestamp: '2026-08-01T12:00:00Z',
        message: { role: 'user', content: 'Only for owner project' },
      }) + '\n',
    );
    seedMined(sessionPath, 1, {
      title: 'live collision owner',
      content: 'belongs to hyphenated project',
      project_root: ownerRoot,
      session_id: 'live-collision',
    });
    expect((await getSessions(ownerRoot)).sessions.map((s) => s.session_path)).toContain(
      sessionPath,
    );
    expect((await getSessions(requestedRoot)).sessions).toEqual([]);
  });

  it('deleted zero-decision Claude session cannot move to its collider (review round 3)', async () => {
    // While the transcript exists, transcript cwd attributes it. Once the
    // file is gone there is no verifiable owner (0 decisions → no decisions
    // rows), and lossy decode would hand it to the surviving collider — so
    // it must disappear everywhere instead of migrating.
    const ownerRoot = path.join(projectA, 'a-b');
    const requestedRoot = path.join(projectA, 'a', 'b');
    fs.mkdirSync(ownerRoot, { recursive: true });
    fs.mkdirSync(requestedRoot, { recursive: true });
    const encoded = ownerRoot.replace(/[\\/:]+/g, '-');
    expect(requestedRoot.replace(/[\\/:]+/g, '-')).toBe(encoded);
    const sessionPath = path.join(CLAUDE_PROJECTS_DIR, encoded, 'deleted-zero.jsonl');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ type: 'user', cwd: ownerRoot }) + '\n');
    seedMined(sessionPath, 0);
    expect((await getSessions(ownerRoot)).sessions.map((s) => s.session_path)).toContain(
      sessionPath,
    );
    expect((await getSessions(requestedRoot)).sessions).toEqual([]);
    fs.unlinkSync(sessionPath);
    expect((await getSessions(requestedRoot)).sessions).toEqual([]);
  });

  it('live zero-decision Claude session uses cwd and rejects absent cwd (review round 3)', async () => {
    const ownerRoot = path.join(projectA, 'c-d');
    const requestedRoot = path.join(projectA, 'c', 'd');
    fs.mkdirSync(ownerRoot, { recursive: true });
    fs.mkdirSync(requestedRoot, { recursive: true });
    const sessionPath = path.join(
      CLAUDE_PROJECTS_DIR,
      ownerRoot.replace(/[\\/:]+/g, '-'),
      'live-zero.jsonl',
    );
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ type: 'user', cwd: ownerRoot }) + '\n');
    seedMined(sessionPath, 0);
    expect((await getSessions(ownerRoot)).sessions.map((s) => s.session_path)).toContain(
      sessionPath,
    );
    expect((await getSessions(requestedRoot)).sessions).toEqual([]);
    // Transcript without cwd is unverifiable — shown under neither project.
    fs.writeFileSync(sessionPath, '{"type":"user"}\n');
    expect((await getSessions(ownerRoot)).sessions).toEqual([]);
    expect((await getSessions(requestedRoot)).sessions).toEqual([]);
  });

  it('missing Claw file keeps its row with unknown date (review round 3)', async () => {
    // Exact-dir attribution survives deletion; only the date is unknown.
    fs.unlinkSync(ownSessionPath);
    const own = (await getSessions(projectA)).sessions.find(
      (s) => s.session_path === ownSessionPath,
    );
    expect(own).toBeDefined();
    expect(own?.session_mtime_ms).toBe(0);
  });

  it('legacy mining never reports processing time as file mtime (review round 2)', async () => {
    // markSessionMined() stamps Date.now() into last_modified_ms — the API
    // must not surface that as the session date. Unknown (0) is acceptable;
    // a positive number must be the real file date.
    const historicalMtime = new Date('2026-08-01T12:00:00Z');
    fs.utimesSync(ownSessionPath, historicalMtime, historicalMtime);
    seedMined(ownSessionPath, 0);
    const own = (await getSessions(projectA)).sessions.find(
      (s) => s.session_path === ownSessionPath,
    );
    expect(own).toBeDefined();
    expect([0, fs.statSync(ownSessionPath).mtimeMs]).toContain(own?.session_mtime_ms);
  });
});
