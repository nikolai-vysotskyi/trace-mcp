/**
 * Per-route handlers for the Ask Sessions HTTP API.
 *
 * Each exported `handle*` function implements exactly one route and owns its
 * own body parsing, validation, DB access, and response shaping. The thin
 * dispatcher in `ask-sessions-routes.ts` matches the method + path and
 * delegates here, which keeps the dispatcher's cyclomatic complexity low.
 *
 * The shared helpers (`getDb`, `uuid`, `collectBody`, `sendJson`) live here so
 * both files can use them without a circular import (mirrors the
 * memory-routes.ts / memory-routes-handlers.ts split).
 */

import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TRACE_MCP_HOME } from '../global.js';
import type { Store } from '../db/store.js';
import { search } from '../tools/navigation/navigation.js';
import { getChangeImpact } from '../tools/analysis/impact.js';
import { scanSecurity, type RuleName } from '../tools/quality/security-scan.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  project_root: string;
  title: string;
  created_at: number;
  last_msg_at: number;
  msg_count: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  context_envelope: string | null;
  created_at: number;
}

/** Minimal context the handler needs from cli.ts. */
export interface AskSessionsContext {
  /** projectManager.getProject(root) */
  projectManager: {
    getProject(
      root: string,
    ): { status: string; store: unknown; registry: unknown; config: unknown } | undefined;
  };
  /** loadConfig(root) — returns a neverthrow Result; value is only present on Ok. */
  loadConfig(root: string): Promise<{ isOk(): boolean; value?: unknown }>;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DDL = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id           TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_msg_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content          TEXT NOT NULL,
  context_envelope TEXT,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_project ON chat_sessions(project_root, last_msg_at DESC);
`;

// ---------------------------------------------------------------------------
// DB singleton
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbDir = TRACE_MCP_HOME;
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, 'chat.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Restrict file permissions so only the owner can read the chat history
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // Non-fatal on platforms where chmod is unsupported
  }

  db.exec(DDL);

  _db = db;
  return db;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function uuid(): string {
  // Node 19+ has crypto.randomUUID natively; fall back for Node 18
  try {
    return (crypto as { randomUUID?(): string }).randomUUID?.() ?? randomUUIDFallback();
  } catch {
    return randomUUIDFallback();
  }
}

function randomUUIDFallback(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error('BODY_TOO_LARGE'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/** Look up a session by id, or send a 404 and return null. */
function getSessionOr404(
  db: Database.Database,
  res: http.ServerResponse,
  sessionId: string,
): SessionRow | null {
  const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId) as
    | SessionRow
    | undefined;
  if (!session) {
    sendJson(res, 404, { error: 'Session not found' });
    return null;
  }
  return session;
}

// ---------------------------------------------------------------------------
// GET /api/ask/sessions?project=<root>
// ---------------------------------------------------------------------------

export function handleListSessions(res: http.ServerResponse, url: URL): void {
  const projectRoot = url.searchParams.get('project');
  if (!projectRoot) {
    sendJson(res, 400, { error: 'Missing ?project= parameter' });
    return;
  }
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.id, s.project_root, s.title, s.created_at, s.last_msg_at,
              COUNT(m.id) AS msg_count
       FROM chat_sessions s
       LEFT JOIN chat_messages m ON m.session_id = s.id
       WHERE s.project_root = ?
       GROUP BY s.id
       ORDER BY s.last_msg_at DESC`,
    )
    .all(projectRoot) as SessionRow[];
  sendJson(res, 200, { sessions: rows });
}

// ---------------------------------------------------------------------------
// POST /api/ask/sessions
// ---------------------------------------------------------------------------

export async function handleCreateSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: { project_root?: string; title?: string };
  try {
    const raw = await collectBody(req);
    body = JSON.parse(raw.toString());
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  if (!body.project_root) {
    sendJson(res, 400, { error: 'project_root is required' });
    return;
  }
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  db.prepare(
    'INSERT INTO chat_sessions (id, project_root, title, created_at, last_msg_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, body.project_root, body.title ?? 'New chat', now, now);
  sendJson(res, 200, { id });
}

// ---------------------------------------------------------------------------
// GET /api/ask/sessions/:id
// ---------------------------------------------------------------------------

export function handleGetSession(res: http.ServerResponse, sessionId: string): void {
  const db = getDb();
  const session = getSessionOr404(db, res, sessionId);
  if (!session) return;

  const messages = db
    .prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as MessageRow[];
  sendJson(res, 200, {
    id: session.id,
    title: session.title,
    project_root: session.project_root,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
      context_envelope: m.context_envelope ? JSON.parse(m.context_envelope) : null,
    })),
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/ask/sessions/:id
// ---------------------------------------------------------------------------

export function handleDeleteSession(res: http.ServerResponse, sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// POST /api/ask/sessions/:id/messages — SSE stream
// ---------------------------------------------------------------------------

export async function handlePostMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AskSessionsContext,
  sessionId: string,
): Promise<void> {
  const db = getDb();
  const session = getSessionOr404(db, res, sessionId);
  if (!session) return;

  let body: { content?: string; model?: string; provider?: string; budget?: number };
  try {
    const raw = await collectBody(req);
    body = JSON.parse(raw.toString());
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  if (!body.content?.trim()) {
    sendJson(res, 400, { error: 'content is required' });
    return;
  }

  const managed = ctx.projectManager.getProject(session.project_root);
  if (!managed || managed.status !== 'ready') {
    sendJson(res, 404, { error: 'Project not found or not ready' });
    return;
  }

  // Persist the user message immediately
  const userMsgId = uuid();
  const userTs = Date.now();
  db.prepare(
    'INSERT INTO chat_messages (id, session_id, role, content, context_envelope, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
  ).run(userMsgId, sessionId, 'user', body.content.trim(), userTs);
  db.prepare('UPDATE chat_sessions SET last_msg_at = ? WHERE id = ?').run(userTs, sessionId);

  // Auto-set title from first user message
  if (session.title === 'New chat') {
    const title = body.content.trim().slice(0, 60);
    db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, sessionId);
  }

  // Load prior messages for context (up to last 10 pairs = 20 messages)
  const priorMessages = (
    db
      .prepare(
        'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 40',
      )
      .all(sessionId) as { role: string; content: string }[]
  ).slice(0, -1); // exclude the user message we just inserted (it's the last one)

  // Start SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const sendEvent = (data: Record<string, unknown>): void => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const {
      resolveProvider,
      gatherContextWithEnvelope,
      buildSystemPrompt,
      stripContextFromMessage,
    } = await import('../ai/ask-shared.js');
    const freshConfig = await ctx.loadConfig(session.project_root);
    const config = freshConfig.isOk() ? freshConfig.value : managed.config;
    const provider = resolveProvider(
      { model: body.model, provider: body.provider },
      config as Parameters<typeof resolveProvider>[1],
    );

    // Phase 1: Retrieve context + build envelope
    sendEvent({ type: 'phase', phase: 'retrieving' });
    const budget = body.budget ?? 12000;
    const { context, envelope } = await gatherContextWithEnvelope(
      session.project_root,
      managed.store as Parameters<typeof gatherContextWithEnvelope>[1],
      managed.registry as Parameters<typeof gatherContextWithEnvelope>[2],
      body.content.trim(),
      budget,
    );

    // Emit envelope BEFORE streaming starts
    sendEvent({ type: 'context_envelope', envelope });

    // Phase 2: Build message array
    sendEvent({ type: 'phase', phase: 'streaming' });

    type ChatMsg = { role: string; content: string };
    const systemMsg = {
      role: 'system' as const,
      content: buildSystemPrompt(session.project_root),
    };
    const chatMessages: ChatMsg[] = [
      systemMsg,
      // Strip context from older user messages
      ...priorMessages.map((m) =>
        stripContextFromMessage(m as Parameters<typeof stripContextFromMessage>[0]),
      ),
      // Latest user message with fresh context
      {
        role: 'user' as const,
        content: `## Code Context\n\n${context}\n\n## Question\n\n${body.content.trim()}`,
      },
    ];

    // Keep history manageable
    while (chatMessages.length > 21) {
      chatMessages.splice(1, 2);
    }

    // Phase 3: Stream LLM response
    let assistantContent = '';
    for await (const chunk of provider.streamChat(
      chatMessages as Parameters<typeof provider.streamChat>[0],
      {
        maxTokens: 4096,
      },
    )) {
      assistantContent += chunk;
      sendEvent({ type: 'chunk', content: chunk });
    }

    // Persist assistant message + envelope
    const assistantMsgId = uuid();
    const assistantTs = Date.now();
    db.prepare(
      'INSERT INTO chat_messages (id, session_id, role, content, context_envelope, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      assistantMsgId,
      sessionId,
      'assistant',
      assistantContent,
      JSON.stringify(envelope),
      assistantTs,
    );
    db.prepare('UPDATE chat_sessions SET last_msg_at = ? WHERE id = ?').run(assistantTs, sessionId);

    sendEvent({ type: 'done' });
  } catch (e) {
    sendEvent({
      type: 'error',
      message: (e as Error & { message?: string })?.message ?? 'Unknown error',
    });
  }

  res.end();
}

// ---------------------------------------------------------------------------
// POST /api/ask/sessions/:id/slash
// ---------------------------------------------------------------------------

/** Run the `/find` slash command and return its markdown body. */
async function runFindCommand(store: Store, args: string): Promise<string> {
  const result = await search(store, args, undefined, 10);
  if (result.items.length === 0) {
    return `<!-- slash:find -->\n**No results for \`${args}\`.**`;
  }
  const rows = result.items
    .map(
      ({ symbol, file, score }) =>
        `| \`${symbol.name}\` | ${symbol.kind} | \`${file.path}:${symbol.line_start ?? ''}\` | ${score.toFixed(3)} |`,
    )
    .join('\n');
  return (
    `<!-- slash:find -->\n` +
    `**Search results for \`${args}\`** (${result.items.length} of ${result.total})\n\n` +
    `| Name | Kind | Location | Score |\n` +
    `|------|------|----------|-------|\n` +
    rows
  );
}

/** Run the `/impact` slash command and return its markdown body. */
function runImpactCommand(store: Store, args: string): string {
  const result = getChangeImpact(store, { symbolId: args });
  if (result.isErr()) {
    return `<!-- slash:impact -->\n**Error:** ${'message' in result.error ? result.error.message : result.error.code}`;
  }
  const { dependents, totalAffected, summary } = result.value;
  if (dependents.length === 0) {
    return `<!-- slash:impact -->\n**No dependents found for \`${args}\`.**`;
  }
  const rows = dependents
    .slice(0, 20)
    .map((d) => `| \`${d.path}\` | depth ${d.depth} | ${d.edgeTypes.join(', ')} |`)
    .join('\n');
  return (
    `<!-- slash:impact -->\n` +
    `**Change impact for \`${args}\`** — ${totalAffected} affected file${totalAffected !== 1 ? 's' : ''} · ${summary.sentence}\n\n` +
    `| File | Depth | Edge Types |\n` +
    `|------|-------|------------|\n` +
    rows +
    (dependents.length > 20 ? `\n\n_...and ${dependents.length - 20} more_` : '')
  );
}

/** Run the `/scan` slash command and return its markdown body. */
function runScanCommand(store: Store, projectRoot: string): string {
  const result = scanSecurity(store, projectRoot, {
    rules: ['all'] as RuleName[],
    severityThreshold: 'medium',
  });
  if (result.isErr()) {
    return `<!-- slash:scan -->\n**Error:** ${'message' in result.error ? result.error.message : result.error.code}`;
  }
  const { findings, files_scanned } = result.value;
  const total = findings.length;
  if (total === 0) {
    return `<!-- slash:scan -->\n**No security findings** (medium+ severity) across ${files_scanned} files.`;
  }
  const top = findings.slice(0, 15);
  const rows = top
    .map(
      (f) =>
        `| ${f.severity.toUpperCase()} | ${f.rule_name} | \`${f.file}:${f.line}\` | ${f.fix} |`,
    )
    .join('\n');
  return (
    `<!-- slash:scan -->\n` +
    `**Security scan** — ${total} finding${total !== 1 ? 's' : ''} across ${files_scanned} files (showing top ${top.length}, medium+ severity)\n\n` +
    `| Severity | Rule | Location | Suggestion |\n` +
    `|----------|------|----------|------------|\n` +
    rows +
    (findings.length > 15 ? `\n\n_...and ${findings.length - 15} more_` : '')
  );
}

export async function handlePostSlash(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AskSessionsContext,
  sessionId: string,
): Promise<void> {
  const db = getDb();
  const session = getSessionOr404(db, res, sessionId);
  if (!session) return;

  let body: { command?: string; args?: string };
  try {
    const raw = await collectBody(req);
    body = JSON.parse(raw.toString());
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const command = body.command?.trim();
  const args = body.args?.trim() ?? '';

  if (!command || !['find', 'impact', 'scan'].includes(command)) {
    sendJson(res, 400, { error: 'command must be one of: find, impact, scan' });
    return;
  }

  const managed = ctx.projectManager.getProject(session.project_root);
  if (!managed || managed.status !== 'ready') {
    sendJson(res, 404, { error: 'Project not found or not ready' });
    return;
  }

  const store = managed.store as Store;
  let markdown = '';

  try {
    if (command === 'find') {
      if (!args) {
        sendJson(res, 400, { error: '/find requires a query argument' });
        return;
      }
      markdown = await runFindCommand(store, args);
    } else if (command === 'impact') {
      if (!args) {
        sendJson(res, 400, { error: '/impact requires a symbol_id argument' });
        return;
      }
      markdown = runImpactCommand(store, args);
    } else if (command === 'scan') {
      markdown = runScanCommand(store, session.project_root);
    }

    // Persist as assistant message (no context_envelope — this is a tool call, not LLM stream)
    const msgId = uuid();
    const now = Date.now();
    db.prepare(
      'INSERT INTO chat_messages (id, session_id, role, content, context_envelope, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
    ).run(msgId, sessionId, 'assistant', markdown, now);
    db.prepare('UPDATE chat_sessions SET last_msg_at = ? WHERE id = ?').run(now, sessionId);

    sendJson(res, 200, { id: msgId, content: markdown });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error)?.message ?? 'Internal error' });
  }
}
