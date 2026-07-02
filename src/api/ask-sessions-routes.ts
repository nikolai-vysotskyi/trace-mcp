/**
 * Ask Sessions API — persistent chat sessions with context-envelope transparency.
 *
 * Endpoints handled (all return true when matched, false otherwise):
 *
 *   GET  /api/ask/sessions?project=<root>
 *   POST /api/ask/sessions                     body: { project_root, title? }
 *   GET  /api/ask/sessions/:id
 *   DELETE /api/ask/sessions/:id
 *   POST /api/ask/sessions/:id/messages        body: { content, model?, provider? }
 *                                              → SSE stream
 *   POST /api/ask/sessions/:id/slash           body: { command, args? }
 *
 * Storage: ~/.trace-mcp/chat.db (better-sqlite3, WAL mode).
 *
 * Integration (add to cli.ts BEFORE the existing /api/ask/provider block):
 *
 *   const { handleAskSessionsRequest } = await import('./api/ask-sessions-routes.js');
 *   if (await handleAskSessionsRequest(req, res, { projectManager, loadConfig })) return;
 *
 * Each route's implementation lives in `ask-sessions-routes-handlers.ts`; this
 * file is a thin method + path dispatcher that delegates to those handlers
 * (mirrors the memory-routes.ts / memory-routes-handlers.ts convention).
 */

import type http from 'node:http';
import {
  handleListSessions,
  handleCreateSession,
  handleGetSession,
  handleDeleteSession,
  handlePostMessage,
  handlePostSlash,
  type AskSessionsContext,
} from './ask-sessions-routes-handlers.js';

export type { AskSessionsContext, SessionRow, MessageRow } from './ask-sessions-routes-handlers.js';

// ── Route dispatcher ────────────────────────────────────────────────────────

/**
 * Call this BEFORE the existing /api/ask/provider block in cli.ts.
 * Returns true if the request was handled (caller should `return`).
 *
 * Example integration in cli.ts:
 *
 *   const { handleAskSessionsRequest } = await import('./api/ask-sessions-routes.js');
 *   if (await handleAskSessionsRequest(req, res, { projectManager, loadConfig })) return;
 */
export async function handleAskSessionsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AskSessionsContext,
): Promise<boolean> {
  const rawUrl = req.url ?? '/';
  const url = new URL(rawUrl, 'http://localhost');
  const { method } = req;
  const { pathname } = url;

  // ── GET /api/ask/sessions?project=<root> ─────────────────────────────────
  if (method === 'GET' && pathname === '/api/ask/sessions') {
    handleListSessions(res, url);
    return true;
  }

  // ── POST /api/ask/sessions ────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/ask/sessions') {
    await handleCreateSession(req, res);
    return true;
  }

  // ── GET /api/ask/sessions/:id ─────────────────────────────────────────────
  const sessionGetMatch = /^\/api\/ask\/sessions\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && sessionGetMatch) {
    handleGetSession(res, decodeURIComponent(sessionGetMatch[1]));
    return true;
  }

  // ── DELETE /api/ask/sessions/:id ─────────────────────────────────────────
  const sessionDeleteMatch = /^\/api\/ask\/sessions\/([^/]+)$/.exec(pathname);
  if (method === 'DELETE' && sessionDeleteMatch) {
    handleDeleteSession(res, decodeURIComponent(sessionDeleteMatch[1]));
    return true;
  }

  // ── POST /api/ask/sessions/:id/messages ──────────────────────────────────
  const msgMatch = /^\/api\/ask\/sessions\/([^/]+)\/messages$/.exec(pathname);
  if (method === 'POST' && msgMatch) {
    await handlePostMessage(req, res, ctx, decodeURIComponent(msgMatch[1]));
    return true;
  }

  // ── POST /api/ask/sessions/:id/slash ─────────────────────────────────
  const slashMatch = /^\/api\/ask\/sessions\/([^/]+)\/slash$/.exec(pathname);
  if (method === 'POST' && slashMatch) {
    await handlePostSlash(req, res, ctx, decodeURIComponent(slashMatch[1]));
    return true;
  }

  return false;
}
