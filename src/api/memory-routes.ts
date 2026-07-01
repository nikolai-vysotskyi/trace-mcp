/**
 * Memory Explorer HTTP routes.
 *
 * Read endpoints (v1):
 *   GET /api/projects/decisions          — paginated decision list with FTS
 *   GET /api/projects/decisions/timeline — chronological decisions for one symbol
 *   GET /api/projects/decisions/stats    — aggregate stats (total, by_type, by_source)
 *   GET /api/projects/corpora            — list corpus manifests filtered by project
 *   GET /api/projects/sessions           — list mined sessions from decisions.db
 *
 * Write endpoints (v2):
 *   POST   /api/projects/decisions                  — create a decision
 *   PATCH  /api/projects/decisions/:id              — update mutable fields
 *   POST   /api/projects/decisions/:id/invalidate   — mark decision invalid
 *   POST   /api/projects/decisions/:id/review       — set review_status (approve/reject)
 *   POST   /api/projects/corpora/:name/query        — query a corpus pack
 *   DELETE /api/projects/corpora/:name              — delete corpus files
 *
 * Integration: in src/cli.ts, just before the `res.writeHead(404)` fallthrough:
 *
 *   import { handleMemoryRequest } from './api/memory-routes.js';
 *   ...
 *   if (handleMemoryRequest(req, res, url)) return;
 *
 * The module is self-contained and does NOT import from src/cli.ts.
 * Each route's implementation lives in `memory-routes-handlers.ts`; this file
 * is a thin method + path dispatcher that delegates to those handlers.
 */

import type http from 'node:http';
import {
  handleCreateDecision,
  handleUpdateDecision,
  handleInvalidateDecision,
  handleReviewDecision,
  handleCorpusQuery,
  handleCorpusDelete,
  handleListDecisions,
  handleDecisionsTimeline,
  handleDecisionsStats,
  handleListCorpora,
  handleListSessions,
} from './memory-routes-handlers.js';

// ── Route dispatcher ────────────────────────────────────────────────────────

/**
 * Handle a memory-related request.
 * Returns `true` when the request was handled (caller should `return`),
 * `false` when the path did not match (caller continues to next route).
 */
export function handleMemoryRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): boolean {
  const method = req.method ?? 'GET';

  // ── v2 write routes — must be matched before the GET-only block ──────────

  // POST /api/projects/decisions — create a decision
  if (method === 'POST' && url.pathname === '/api/projects/decisions') {
    handleCreateDecision(req, res);
    return true;
  }

  // PATCH /api/projects/decisions/:id — update mutable fields
  const patchDecisionMatch = /^\/api\/projects\/decisions\/(\d+)$/.exec(url.pathname);
  if (method === 'PATCH' && patchDecisionMatch) {
    handleUpdateDecision(req, res, parseInt(patchDecisionMatch[1], 10));
    return true;
  }

  // POST /api/projects/decisions/:id/invalidate — invalidate a decision
  const invalidateMatch = /^\/api\/projects\/decisions\/(\d+)\/invalidate$/.exec(url.pathname);
  if (method === 'POST' && invalidateMatch) {
    handleInvalidateDecision(req, res, parseInt(invalidateMatch[1], 10));
    return true;
  }

  // POST /api/projects/decisions/:id/review — set memoir-style review_status
  const reviewMatch = /^\/api\/projects\/decisions\/(\d+)\/review$/.exec(url.pathname);
  if (method === 'POST' && reviewMatch) {
    handleReviewDecision(req, res, parseInt(reviewMatch[1], 10));
    return true;
  }

  // POST /api/projects/corpora/:name/query — query a corpus pack body
  const corpusQueryMatch = /^\/api\/projects\/corpora\/([^/]+)\/query$/.exec(url.pathname);
  if (method === 'POST' && corpusQueryMatch) {
    handleCorpusQuery(req, res, corpusQueryMatch[1]);
    return true;
  }

  // DELETE /api/projects/corpora/:name — delete corpus files
  const corpusDeleteMatch = /^\/api\/projects\/corpora\/([^/]+)$/.exec(url.pathname);
  if (method === 'DELETE' && corpusDeleteMatch) {
    handleCorpusDelete(res, url, corpusDeleteMatch[1]);
    return true;
  }

  // ── v1 read-only routes ─────────────────────────────────────────────────────
  if (method !== 'GET') return false;

  // GET /api/projects/decisions — paginated decision list with FTS
  if (url.pathname === '/api/projects/decisions') {
    handleListDecisions(res, url);
    return true;
  }

  // GET /api/projects/decisions/timeline — chronological decisions for one symbol
  if (url.pathname === '/api/projects/decisions/timeline') {
    handleDecisionsTimeline(res, url);
    return true;
  }

  // GET /api/projects/decisions/stats — aggregate stats
  if (url.pathname === '/api/projects/decisions/stats') {
    handleDecisionsStats(res, url);
    return true;
  }

  // GET /api/projects/corpora — list corpus manifests filtered by project
  if (url.pathname === '/api/projects/corpora') {
    handleListCorpora(res, url);
    return true;
  }

  // GET /api/projects/sessions — list mined sessions from decisions.db
  if (url.pathname === '/api/projects/sessions') {
    handleListSessions(res, url);
    return true;
  }

  return false;
}
