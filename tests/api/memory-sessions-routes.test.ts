/**
 * TRA-1065: Memory → Sessions ignored `?project=` and returned the same
 * global mined_sessions list for every project. Pins the scoped contract of
 * GET /api/projects/sessions:
 *
 *   - only sessions belonging to the requested project are returned;
 *   - a project with no mined sessions gets [], not another project's list;
 *   - each row carries session_id (basename without .jsonl) so the UI can
 *     name the session instead of showing a truncated interior path.
 *
 * The suite-wide isolate-home setup file redirects TRACE_MCP_HOME to a
 * per-worker temp dir, so seeding decisions.db below never touches the
 * developer's real database. listAllSessions scans the real
 * ~/.claude/projects, but the temp projects have no encoded dir there —
 * the "own" session is a real <project>/.claw/sessions/*.jsonl file, which
 * is exactly the discovery path the handler attributes.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleMemoryRequest } from '../../src/api/memory-routes.js';
import { DecisionStore } from '../../src/memory/decision-store.js';
import { DECISIONS_DB_PATH } from '../../src/shared/paths.js';

interface SessionsBody {
  sessions: Array<{
    session_path: string;
    mined_at: string;
    decisions_found: number;
    session_id: string;
  }>;
}

function startTestServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!handleMemoryRequest(req, res, url)) {
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

describe('GET /api/projects/sessions scoping (TRA-1065)', () => {
  let srv: { baseUrl: string; close: () => Promise<void> } | null = null;
  let projectA: string;
  let projectB: string;
  let ownSessionPath: string;
  const ownSessionId = 'tra1065-own-session';
  const foreignSessionPath = path.join(
    os.homedir(),
    '.claude',
    'projects',
    '-tra1065-no-such-project',
    'tra1065-foreign-session.jsonl',
  );
  const providerKey = 'hermes:tra1065-provider-session';

  beforeEach(async () => {
    srv = await startTestServer();
    projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'tra1065-projA-'));
    projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'tra1065-projB-'));

    // A real session file belonging to project A (Claw layout).
    const sessionsDir = path.join(projectA, '.claw', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    ownSessionPath = path.join(sessionsDir, `${ownSessionId}.jsonl`);
    fs.writeFileSync(ownSessionPath, '{"type":"session","id":"tra1065"}\n');

    const store = new DecisionStore(DECISIONS_DB_PATH);
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
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  });

  async function getSessions(projectRoot?: string, limit?: string): Promise<SessionsBody> {
    const params = new URLSearchParams();
    if (projectRoot !== undefined) params.set('project', projectRoot);
    if (limit !== undefined) params.set('limit', limit);
    const res = await fetch(`${srv!.baseUrl}/api/projects/sessions?${params}`);
    expect(res.status).toBe(200);
    return (await res.json()) as SessionsBody;
  }

  it('400s when ?project= is missing', async () => {
    const res = await fetch(`${srv!.baseUrl}/api/projects/sessions`);
    expect(res.status).toBe(400);
  });

  it('returns only the requested project sessions, with session_id', async () => {
    const body = await getSessions(projectA);
    const paths = body.sessions.map((s) => s.session_path);
    expect(paths).toContain(ownSessionPath);
    expect(paths).toContain(providerKey);
    expect(paths).not.toContain(foreignSessionPath);

    const own = body.sessions.find((s) => s.session_path === ownSessionPath);
    expect(own?.session_id).toBe(ownSessionId);
    expect(own?.decisions_found).toBe(2);
  });

  it('returns [] for a project with no mined sessions (not the global list)', async () => {
    const body = await getSessions(projectB);
    expect(body.sessions).toEqual([]);
  });

  it('respects limit after scoping', async () => {
    const body = await getSessions(projectA, '1');
    expect(body.sessions).toHaveLength(1);
  });
});
