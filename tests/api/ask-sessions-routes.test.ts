/**
 * Characterization tests for src/api/ask-sessions-routes.ts.
 *
 * Pins the exact HTTP contract (status codes + response shapes) of
 * handleAskSessionsRequest BEFORE it is split into per-route handlers
 * (mirroring the memory-routes.ts / memory-routes-handlers.ts split).
 * These tests intentionally avoid the LLM-streaming branch of
 * POST /:id/messages (that path calls out to a real provider) and instead
 * cover every guard clause plus the non-LLM POST /:id/slash paths, which
 * together exercise the full if-chain the dispatcher walks.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import {
  handleAskSessionsRequest,
  type AskSessionsContext,
} from '../../src/api/ask-sessions-routes.js';

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

interface SeededStore {
  root: string;
  dbPath: string;
  store: Store;
  cleanup: () => void;
}

function seedStore(): SeededStore {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-ask-sessions-'));
  const dbPath = path.join(tmpRoot, 'index.db');
  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  return {
    root: tmpRoot,
    dbPath,
    store,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function readyCtx(seeded: SeededStore): AskSessionsContext {
  return {
    projectManager: {
      getProject: (root: string) =>
        root === seeded.root
          ? { status: 'ready', store: seeded.store, registry: {}, config: {} }
          : undefined,
    },
    loadConfig: async () => ({ isOk: () => false }),
  };
}

function notReadyCtx(): AskSessionsContext {
  return {
    projectManager: {
      getProject: () => undefined,
    },
    loadConfig: async () => ({ isOk: () => false }),
  };
}

async function startTestServer(
  ctx: AskSessionsContext,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handleAskSessionsRequest(req, res, ctx).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function postJson(
  baseUrl: string,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('ask-sessions-routes — HTTP contract', () => {
  let srv: { baseUrl: string; close: () => Promise<void> } | null = null;
  let seeded: SeededStore | null = null;

  beforeEach(() => {
    srv = null;
    seeded = null;
  });

  afterEach(async () => {
    if (srv) await srv.close();
    if (seeded) seeded.cleanup();
    srv = null;
    seeded = null;
  });

  it('does not match unrelated paths (returns false -> 404 from outer server)', async () => {
    srv = await startTestServer(notReadyCtx());
    const res = await fetch(`${srv.baseUrl}/some/other/path`);
    expect(res.status).toBe(404);
  });

  describe('GET /api/ask/sessions', () => {
    it('400s when ?project= is missing', async () => {
      srv = await startTestServer(notReadyCtx());
      const res = await fetch(`${srv.baseUrl}/api/ask/sessions`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/project/);
    });

    it('200s with an empty sessions list for an unknown project', async () => {
      srv = await startTestServer(notReadyCtx());
      const res = await fetch(
        `${srv.baseUrl}/api/ask/sessions?project=${encodeURIComponent('/tmp/nonexistent')}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: unknown[] };
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.sessions).toHaveLength(0);
    });
  });

  describe('POST /api/ask/sessions', () => {
    it('400s on invalid JSON body', async () => {
      srv = await startTestServer(notReadyCtx());
      const res = await fetch(`${srv.baseUrl}/api/ask/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/JSON/);
    });

    it('400s when project_root is missing', async () => {
      srv = await startTestServer(notReadyCtx());
      const { status, json } = await postJson(srv.baseUrl, '/api/ask/sessions', { title: 'x' });
      expect(status).toBe(400);
      expect(json.error).toMatch(/project_root/);
    });

    it('200s and returns a new session id, then lists it', async () => {
      srv = await startTestServer(notReadyCtx());
      const projectRoot = `/tmp/proj-${Math.random().toString(36).slice(2)}`;
      const { status, json } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: projectRoot,
        title: 'My chat',
      });
      expect(status).toBe(200);
      expect(typeof json.id).toBe('string');

      const listRes = await fetch(
        `${srv!.baseUrl}/api/ask/sessions?project=${encodeURIComponent(projectRoot)}`,
      );
      const listBody = (await listRes.json()) as {
        sessions: Array<{ id: string; title: string; msg_count: number }>;
      };
      expect(listBody.sessions).toHaveLength(1);
      expect(listBody.sessions[0].id).toBe(json.id);
      expect(listBody.sessions[0].title).toBe('My chat');
      expect(listBody.sessions[0].msg_count).toBe(0);
    });

    it('defaults title to "New chat" when omitted', async () => {
      srv = await startTestServer(notReadyCtx());
      const projectRoot = `/tmp/proj-${Math.random().toString(36).slice(2)}`;
      const { json } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: projectRoot,
      });
      const listRes = await fetch(
        `${srv!.baseUrl}/api/ask/sessions?project=${encodeURIComponent(projectRoot)}`,
      );
      const listBody = (await listRes.json()) as { sessions: Array<{ title: string }> };
      expect(listBody.sessions[0].title).toBe('New chat');
      expect(json.id).toBeDefined();
    });
  });

  describe('GET /api/ask/sessions/:id', () => {
    it('404s for an unknown session id', async () => {
      srv = await startTestServer(notReadyCtx());
      const res = await fetch(`${srv.baseUrl}/api/ask/sessions/does-not-exist`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/not found/i);
    });

    it('200s with session detail + empty messages for a fresh session', async () => {
      srv = await startTestServer(notReadyCtx());
      const projectRoot = `/tmp/proj-${Math.random().toString(36).slice(2)}`;
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: projectRoot,
      });
      const res = await fetch(`${srv!.baseUrl}/api/ask/sessions/${created.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        title: string;
        project_root: string;
        messages: unknown[];
      };
      expect(body.id).toBe(created.id);
      expect(body.project_root).toBe(projectRoot);
      expect(body.messages).toEqual([]);
    });
  });

  describe('DELETE /api/ask/sessions/:id', () => {
    it('200s with { ok: true } and removes the session', async () => {
      srv = await startTestServer(notReadyCtx());
      const projectRoot = `/tmp/proj-${Math.random().toString(36).slice(2)}`;
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: projectRoot,
      });
      const delRes = await fetch(`${srv!.baseUrl}/api/ask/sessions/${created.id}`, {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(200);
      const delBody = (await delRes.json()) as { ok: boolean };
      expect(delBody.ok).toBe(true);

      const getRes = await fetch(`${srv!.baseUrl}/api/ask/sessions/${created.id}`);
      expect(getRes.status).toBe(404);
    });

    it('200s with { ok: true } even for an unknown id (idempotent DELETE)', async () => {
      srv = await startTestServer(notReadyCtx());
      const res = await fetch(`${srv.baseUrl}/api/ask/sessions/does-not-exist`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  describe('POST /api/ask/sessions/:id/messages — guard clauses only (no LLM call)', () => {
    it('404s for an unknown session id', async () => {
      srv = await startTestServer(notReadyCtx());
      const { status, json } = await postJson(
        srv.baseUrl,
        '/api/ask/sessions/does-not-exist/messages',
        { content: 'hi' },
      );
      expect(status).toBe(404);
      expect(json.error).toMatch(/not found/i);
    });

    it('400s on invalid JSON body', async () => {
      srv = await startTestServer(notReadyCtx());
      const projectRoot = `/tmp/proj-${Math.random().toString(36).slice(2)}`;
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: projectRoot,
      });
      const res = await fetch(`${srv!.baseUrl}/api/ask/sessions/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
    });

    it('400s when content is blank', async () => {
      srv = await startTestServer(notReadyCtx());
      const projectRoot = `/tmp/proj-${Math.random().toString(36).slice(2)}`;
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: projectRoot,
      });
      const { status, json } = await postJson(
        srv.baseUrl,
        `/api/ask/sessions/${created.id}/messages`,
        { content: '   ' },
      );
      expect(status).toBe(400);
      expect(json.error).toMatch(/content is required/);
    });

    it('404s when the project is not loaded/ready', async () => {
      srv = await startTestServer(notReadyCtx());
      const projectRoot = `/tmp/proj-${Math.random().toString(36).slice(2)}`;
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: projectRoot,
      });
      const { status, json } = await postJson(
        srv.baseUrl,
        `/api/ask/sessions/${created.id}/messages`,
        { content: 'hello' },
      );
      expect(status).toBe(404);
      expect(json.error).toMatch(/not found or not ready/);
    });
  });

  describe('POST /api/ask/sessions/:id/slash', () => {
    it('404s for an unknown session id', async () => {
      srv = await startTestServer(notReadyCtx());
      const { status, json } = await postJson(
        srv.baseUrl,
        '/api/ask/sessions/does-not-exist/slash',
        { command: 'find', args: 'x' },
      );
      expect(status).toBe(404);
      expect(json.error).toMatch(/not found/i);
    });

    it('400s on invalid JSON body', async () => {
      srv = await startTestServer(notReadyCtx());
      const projectRoot = `/tmp/proj-${Math.random().toString(36).slice(2)}`;
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: projectRoot,
      });
      const res = await fetch(`${srv!.baseUrl}/api/ask/sessions/${created.id}/slash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
    });

    it('400s when command is not one of find/impact/scan', async () => {
      srv = await startTestServer(notReadyCtx());
      const projectRoot = `/tmp/proj-${Math.random().toString(36).slice(2)}`;
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: projectRoot,
      });
      const { status, json } = await postJson(
        srv.baseUrl,
        `/api/ask/sessions/${created.id}/slash`,
        { command: 'bogus' },
      );
      expect(status).toBe(400);
      expect(json.error).toMatch(/command must be one of/);
    });

    it('404s when the project is not loaded/ready', async () => {
      srv = await startTestServer(notReadyCtx());
      const projectRoot = `/tmp/proj-${Math.random().toString(36).slice(2)}`;
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: projectRoot,
      });
      const { status, json } = await postJson(
        srv.baseUrl,
        `/api/ask/sessions/${created.id}/slash`,
        { command: 'find', args: 'foo' },
      );
      expect(status).toBe(404);
      expect(json.error).toMatch(/not found or not ready/);
    });

    it('400s when /find is missing the args argument', async () => {
      seeded = seedStore();
      srv = await startTestServer(readyCtx(seeded));
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: seeded.root,
      });
      const { status, json } = await postJson(
        srv.baseUrl,
        `/api/ask/sessions/${created.id}/slash`,
        { command: 'find' },
      );
      expect(status).toBe(400);
      expect(json.error).toMatch(/find requires a query argument/);
    });

    it('/find with no results returns a 200 markdown "no results" payload', async () => {
      seeded = seedStore();
      srv = await startTestServer(readyCtx(seeded));
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: seeded.root,
      });
      const { status, json } = await postJson(
        srv.baseUrl,
        `/api/ask/sessions/${created.id}/slash`,
        { command: 'find', args: 'nonexistentSymbolXYZ' },
      );
      expect(status).toBe(200);
      expect(typeof json.id).toBe('string');
      expect(json.content as string).toContain('<!-- slash:find -->');
      expect(json.content as string).toMatch(/No results for/);
    });

    it('400s when /impact is missing the args argument', async () => {
      seeded = seedStore();
      srv = await startTestServer(readyCtx(seeded));
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: seeded.root,
      });
      const { status, json } = await postJson(
        srv.baseUrl,
        `/api/ask/sessions/${created.id}/slash`,
        { command: 'impact' },
      );
      expect(status).toBe(400);
      expect(json.error).toMatch(/impact requires a symbol_id argument/);
    });

    it('/impact with an unknown symbol id returns a 200 error markdown payload', async () => {
      seeded = seedStore();
      srv = await startTestServer(readyCtx(seeded));
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: seeded.root,
      });
      const { status, json } = await postJson(
        srv.baseUrl,
        `/api/ask/sessions/${created.id}/slash`,
        { command: 'impact', args: 'no-such-symbol-id' },
      );
      expect(status).toBe(200);
      expect(json.content as string).toContain('<!-- slash:impact -->');
    });

    it('/scan with a clean empty project returns a 200 "no findings" markdown payload', async () => {
      seeded = seedStore();
      srv = await startTestServer(readyCtx(seeded));
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: seeded.root,
      });
      const { status, json } = await postJson(
        srv.baseUrl,
        `/api/ask/sessions/${created.id}/slash`,
        { command: 'scan' },
      );
      expect(status).toBe(200);
      expect(json.content as string).toContain('<!-- slash:scan -->');
      expect(json.content as string).toMatch(/No security findings/);
    });

    it('persists the slash response as an assistant message retrievable via GET', async () => {
      seeded = seedStore();
      srv = await startTestServer(readyCtx(seeded));
      const { json: created } = await postJson(srv.baseUrl, '/api/ask/sessions', {
        project_root: seeded.root,
      });
      await postJson(srv.baseUrl, `/api/ask/sessions/${created.id}/slash`, {
        command: 'scan',
      });
      const res = await fetch(`${srv!.baseUrl}/api/ask/sessions/${created.id}`);
      const body = (await res.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('assistant');
      expect(body.messages[0].content).toContain('<!-- slash:scan -->');
    });
  });
});
