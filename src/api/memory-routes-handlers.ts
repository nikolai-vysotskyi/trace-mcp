/**
 * Per-route handlers for the Memory Explorer HTTP API.
 *
 * Each exported `handle*` function implements exactly one route and owns its
 * own parameter validation, store/DB access, and response shaping. The thin
 * dispatcher in `memory-routes.ts` matches the method + path and delegates
 * here, which keeps the dispatcher's cyclomatic complexity low.
 *
 * The shared helpers (`sendJson`, `parseBody`, `openDecisionsDb`) live here so
 * both files can use them without a circular import.
 */

import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import Database from 'better-sqlite3';
import { escapeFtsQuery } from '../db/fts.js';
import { DECISIONS_DB_PATH, CORPORA_DIR, CLAUDE_PROJECTS_DIR } from '../shared/paths.js';
import { ensureGlobalDirs } from '../global.js';
import { decodeDirName, listAllSessions, listGitWorktrees } from '../analytics/log-parser.js';
import { loadConfig } from '../config.js';
import type { DecisionRow, DecisionTimelineEntry } from '../memory/decision-store.js';
import { DecisionStore } from '../memory/decision-store.js';
import { runMineStage } from '../memory/scheduler/stages.js';
import { CorpusStore, validateCorpusName, CorpusValidationError } from '../memory/corpus-store.js';
import { getCurrentBranch } from '../utils/git-branch.js';

// ── Types matching the DecisionStore schema ──────────────────────────────────

interface MinedSessionRow {
  session_path: string;
  mined_at: string;
  decisions_found: number;
}

/**
 * Owner recorded inside a Claude Code session transcript: the `cwd` of its
 * first entries. Read from a 64 KB head so multi-MB transcripts never load
 * fully. Null when the file is missing, truncated, or carries no cwd —
 * callers treat that as "unverifiable", never as "belongs here".
 */
function readSessionCwd(sessionPath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(sessionPath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
      } catch {
        /* not JSON — keep scanning */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

interface CorpusManifest {
  name: string;
  projectRoot: string;
  scope: string;
  modulePath?: string;
  featureQuery?: string;
  tokenBudget: number;
  symbolCount: number;
  fileCount: number;
  estimatedTokens: number;
  packStrategy: string;
  createdAt: string;
  updatedAt: string;
  description?: string;
}

interface CorpusListItem {
  name: string;
  scope: string;
  modulePath?: string;
  featureQuery?: string;
  tokenBudget: number;
  createdAt: string;
  updatedAt: string;
  description?: string;
  symbolCount: number;
  fileCount: number;
  estimatedTokens: number;
  sizeKB: number | null;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Open decisions.db in read-only mode (WAL; 5 s busy timeout).
 * Returns null when the file does not exist yet.
 */
export function openDecisionsDb(): Database.Database | null {
  if (!fs.existsSync(DECISIONS_DB_PATH)) return null;
  try {
    const db = new Database(DECISIONS_DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 5000');
    return db;
  } catch {
    return null;
  }
}

export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Read the full request body as a UTF-8 string. */
export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Parse JSON body; return null on any error. */
export async function parseBody<T>(req: http.IncomingMessage): Promise<T | null> {
  try {
    const raw = await readBody(req);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── v2 write routes ────────────────────────────────────────────────────────

/** POST /api/projects/decisions — create a decision. */
export function handleCreateDecision(req: http.IncomingMessage, res: http.ServerResponse): void {
  void (async () => {
    interface CreateBody {
      project_root: string;
      title: string;
      content: string;
      type?: string;
      symbol_id?: string;
      file_path?: string;
      tags?: string | string[];
      source?: string;
      /**
       * Git branch this decision belongs to. Omit to auto-detect from
       * `project_root`; pass `null` to make the decision branch-agnostic.
       */
      git_branch?: string | null;
    }
    const body = await parseBody<CreateBody>(req);
    if (!body || !body.project_root || !body.title || !body.content) {
      sendJson(res, 400, { error: 'project_root, title, and content are required' });
      return;
    }

    const VALID_TYPES = new Set([
      'architecture_decision',
      'tech_choice',
      'bug_root_cause',
      'preference',
      'tradeoff',
      'discovery',
      'convention',
    ]);
    const type = body.type ?? 'preference';
    if (!VALID_TYPES.has(type)) {
      sendJson(res, 400, { error: `Invalid type: ${type}` });
      return;
    }

    const tagsArray: string[] | undefined =
      typeof body.tags === 'string'
        ? body.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : Array.isArray(body.tags)
          ? body.tags
          : undefined;

    try {
      if (!fs.existsSync(DECISIONS_DB_PATH)) {
        sendJson(res, 503, { error: 'decisions.db not initialised — run trace-mcp serve first' });
        return;
      }
      const store = new DecisionStore(DECISIONS_DB_PATH);
      try {
        // Branch-aware decision memory: caller can pass an explicit branch
        // (including `null` for branch-agnostic), or omit and let us probe
        // the project root.
        const resolvedBranch =
          body.git_branch === undefined ? getCurrentBranch(body.project_root) : body.git_branch;
        const row = store.addDecision({
          project_root: body.project_root,
          title: body.title,
          content: body.content,
          type: type as import('../memory/decision-store.js').DecisionType,
          symbol_id: body.symbol_id,
          file_path: body.file_path,
          tags: tagsArray,
          source: (body.source as 'manual' | 'mined' | 'auto') ?? 'manual',
          git_branch: resolvedBranch,
        });
        sendJson(res, 201, { id: row.id });
      } finally {
        store.close();
      }
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message ?? 'Failed to create decision' });
    }
  })();
}

/** PATCH /api/projects/decisions/:id — update mutable fields. */
export function handleUpdateDecision(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: number,
): void {
  void (async () => {
    interface PatchBody {
      title?: string;
      content?: string;
      type?: string;
      symbol_id?: string;
      file_path?: string;
      tags?: string | string[];
      source?: string;
      confidence?: number;
    }
    const body = await parseBody<PatchBody>(req);
    if (!body) {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const VALID_TYPES = new Set([
      'architecture_decision',
      'tech_choice',
      'bug_root_cause',
      'preference',
      'tradeoff',
      'discovery',
      'convention',
    ]);
    if (body.type && !VALID_TYPES.has(body.type)) {
      sendJson(res, 400, { error: `Invalid type: ${body.type}` });
      return;
    }

    try {
      if (!fs.existsSync(DECISIONS_DB_PATH)) {
        sendJson(res, 404, { error: 'decisions.db not found' });
        return;
      }
      const store = new DecisionStore(DECISIONS_DB_PATH);
      try {
        const tagsArray: string[] | undefined =
          typeof body.tags === 'string'
            ? body.tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : Array.isArray(body.tags)
              ? body.tags
              : undefined;

        const fields: Parameters<typeof store.updateDecision>[1] = {};
        if (body.title !== undefined) fields.title = body.title;
        if (body.content !== undefined) fields.content = body.content;
        if (body.type !== undefined)
          fields.type = body.type as import('../memory/decision-store.js').DecisionType;
        if (body.symbol_id !== undefined) fields.symbol_id = body.symbol_id;
        if (body.file_path !== undefined) fields.file_path = body.file_path;
        if (tagsArray !== undefined) fields.tags = JSON.stringify(tagsArray) as unknown as string;
        if (body.source !== undefined) fields.source = body.source as 'manual' | 'mined' | 'auto';
        if (body.confidence !== undefined) fields.confidence = body.confidence;

        const updated = store.updateDecision(id, fields);
        if (!updated) {
          sendJson(res, 404, { error: `Decision ${id} not found` });
          return;
        }
        sendJson(res, 200, { ok: true });
      } finally {
        store.close();
      }
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message ?? 'Failed to update decision' });
    }
  })();
}

/** POST /api/projects/decisions/:id/invalidate — invalidate a decision. */
export function handleInvalidateDecision(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: number,
): void {
  void (async () => {
    interface InvalidateBody {
      valid_until?: number;
    }
    const body = (await parseBody<InvalidateBody>(req)) ?? {};

    let validUntilIso: string | undefined;
    if (body.valid_until !== undefined) {
      validUntilIso = new Date(body.valid_until).toISOString();
    }

    try {
      if (!fs.existsSync(DECISIONS_DB_PATH)) {
        sendJson(res, 404, { error: 'decisions.db not found' });
        return;
      }
      const store = new DecisionStore(DECISIONS_DB_PATH);
      try {
        const changed = store.invalidateDecision(id, validUntilIso);
        if (!changed) {
          sendJson(res, 404, { error: `Decision ${id} not found or already invalidated` });
          return;
        }
        sendJson(res, 200, { ok: true });
      } finally {
        store.close();
      }
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message ?? 'Failed to invalidate decision' });
    }
  })();
}

/**
 * POST /api/projects/decisions/:id/review — set memoir-style review_status.
 * Mirrors the MCP `approve_decision` / `reject_decision` tools so the
 * Memory Explorer review queue can drive both flows from the renderer.
 */
export function handleReviewDecision(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: number,
): void {
  void (async () => {
    interface ReviewBody {
      status?: 'pending' | 'approved' | 'rejected';
    }
    const body = (await parseBody<ReviewBody>(req)) ?? {};
    const status = body.status;
    if (status !== 'pending' && status !== 'approved' && status !== 'rejected') {
      sendJson(res, 400, {
        error: 'status must be one of: "pending", "approved", "rejected"',
      });
      return;
    }

    try {
      if (!fs.existsSync(DECISIONS_DB_PATH)) {
        sendJson(res, 404, { error: 'decisions.db not found' });
        return;
      }
      const store = new DecisionStore(DECISIONS_DB_PATH);
      try {
        const changed = store.setReviewStatus(id, status);
        if (!changed) {
          sendJson(res, 404, { error: `Decision ${id} not found` });
          return;
        }
        sendJson(res, 200, { ok: true, id, review_status: status });
      } finally {
        store.close();
      }
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message ?? 'Failed to set review status' });
    }
  })();
}

/** POST /api/projects/corpora/:name/query — query a corpus pack body. */
export function handleCorpusQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  name: string,
): void {
  void (async () => {
    interface QueryBody {
      project_root: string;
      query: string;
      max_tokens?: number;
    }
    const body = await parseBody<QueryBody>(req);
    if (!body || !body.project_root || !body.query) {
      sendJson(res, 400, { error: 'project_root and query are required' });
      return;
    }

    try {
      validateCorpusName(name);
    } catch (e) {
      if (e instanceof CorpusValidationError) {
        sendJson(res, 400, { error: e.message });
        return;
      }
      throw e;
    }

    try {
      const store = new CorpusStore();
      const manifest = store.load(name);
      if (!manifest) {
        sendJson(res, 404, { error: `Corpus "${name}" not found` });
        return;
      }
      if (manifest.projectRoot !== body.project_root) {
        sendJson(res, 403, { error: 'Corpus does not belong to the specified project' });
        return;
      }

      const packBody = store.loadPackedBody(name);
      if (!packBody) {
        sendJson(res, 404, { error: `Corpus pack file for "${name}" not found` });
        return;
      }

      // Simple relevance filter: return paragraphs/sections that contain
      // any query term. Falls back to the full pack when nothing matches.
      const maxTokens = Math.min(body.max_tokens ?? 4000, 16000);
      const queryTerms = body.query.toLowerCase().split(/\s+/).filter(Boolean);
      const sections = packBody.split(/\n#{1,3} /);
      const matched = sections.filter((s) =>
        queryTerms.some((term) => s.toLowerCase().includes(term)),
      );
      const excerpt = (matched.length > 0 ? matched : sections)
        .join('\n\n')
        .slice(0, maxTokens * 4); // rough 4-chars/token estimate

      // Approximate token count (4 chars/token heuristic).
      const tokens_used = Math.ceil(excerpt.length / 4);

      sendJson(res, 200, { excerpt, tokens_used, corpus_name: name });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message ?? 'Query failed' });
    }
  })();
}

/**
 * DELETE /api/projects/corpora/:name — delete corpus files.
 * Fully synchronous — the caller returns `true` immediately.
 */
export function handleCorpusDelete(res: http.ServerResponse, url: URL, name: string): void {
  const projectRoot = url.searchParams.get('project_root');
  if (!projectRoot) {
    sendJson(res, 400, { error: 'Missing ?project_root= query param' });
    return;
  }

  try {
    validateCorpusName(name);
  } catch (e) {
    if (e instanceof CorpusValidationError) {
      sendJson(res, 400, { error: (e as Error).message });
      return;
    }
    throw e;
  }

  try {
    const store = new CorpusStore();
    const manifest = store.load(name);
    if (!manifest) {
      sendJson(res, 404, { error: `Corpus "${name}" not found` });
      return;
    }
    if (manifest.projectRoot !== projectRoot) {
      sendJson(res, 403, { error: 'Corpus does not belong to the specified project' });
      return;
    }
    store.delete(name);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message ?? 'Delete failed' });
  }
}

// ── v1 read-only routes ──────────────────────────────────────────────────────

/** GET /api/projects/decisions — paginated decision list with FTS. */
export function handleListDecisions(res: http.ServerResponse, url: URL): void {
  const projectRoot = url.searchParams.get('project');
  if (!projectRoot) {
    sendJson(res, 400, { error: 'Missing ?project= query param' });
    return;
  }

  const q = url.searchParams.get('q') ?? '';
  const type = url.searchParams.get('type') ?? '';
  const symbolId = url.searchParams.get('symbol_id') ?? '';
  const filePath = url.searchParams.get('file_path') ?? '';
  // Branch-aware filter: ?branch=current|all|<name>. Defaults to "current".
  const branchParam = url.searchParams.get('branch') ?? 'current';
  // Memoir-style review filter:
  //   ?review_status=pending|approved|rejected → restrict to that tier
  //   ?include_pending=1                       → also return 'pending' rows
  //   neither                                  → default: NULL + 'approved'
  const reviewStatusParam = url.searchParams.get('review_status') ?? '';
  const includePending =
    url.searchParams.get('include_pending') === '1' ||
    url.searchParams.get('include_pending') === 'true';
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10), 1), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10), 0);

  const db = openDecisionsDb();
  if (!db) {
    sendJson(res, 200, { decisions: [], total: 0, limit, offset });
    return;
  }

  try {
    const conditions: string[] = ['project_root = ?'];
    const params: unknown[] = [projectRoot];

    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }
    if (symbolId) {
      conditions.push('symbol_id = ?');
      params.push(symbolId);
    }
    if (filePath) {
      conditions.push('file_path = ?');
      params.push(filePath);
    }
    if (q) {
      // TRA-1619A: `q` is plain user text, not FTS5 syntax — escape it so
      // hyphenated input (`trace-mcp`) can't throw `no such column`.
      const safeQ = escapeFtsQuery(q);
      if (!safeQ) {
        sendJson(res, 200, { decisions: [], total: 0, limit, offset });
        return;
      }
      conditions.push('id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ?)');
      params.push(safeQ);
    }
    // Three-mode branch filter, mirroring the MCP/CLI semantics.
    if (branchParam !== 'all') {
      const resolved = branchParam === 'current' ? getCurrentBranch(projectRoot) : branchParam;
      if (resolved !== null) {
        conditions.push('(git_branch = ? OR git_branch IS NULL)');
        params.push(resolved);
      }
      // resolved === null + 'current' → no usable branch context, skip filter
    }

    // Memoir review filter — same precedence as queryDecisions().
    if (
      reviewStatusParam === 'pending' ||
      reviewStatusParam === 'approved' ||
      reviewStatusParam === 'rejected'
    ) {
      conditions.push('review_status = ?');
      params.push(reviewStatusParam);
    } else if (includePending) {
      conditions.push("(review_status IS NULL OR review_status IN ('approved','pending'))");
    } else {
      conditions.push("(review_status IS NULL OR review_status = 'approved')");
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const total = (
      db.prepare(`SELECT COUNT(*) as c FROM decisions ${where}`).get(...params) as { c: number }
    ).c;

    const decisions = db
      .prepare(`SELECT * FROM decisions ${where} ORDER BY valid_from DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as DecisionRow[];

    sendJson(res, 200, { decisions, total, limit, offset });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message ?? 'Query failed' });
  } finally {
    db.close();
  }
}

/** GET /api/projects/decisions/timeline — chronological decisions for one symbol. */
export function handleDecisionsTimeline(res: http.ServerResponse, url: URL): void {
  const projectRoot = url.searchParams.get('project');
  const symbolId = url.searchParams.get('symbol_id') ?? '';
  const filePath = url.searchParams.get('file_path') ?? '';

  if (!projectRoot) {
    sendJson(res, 400, { error: 'Missing ?project= query param' });
    return;
  }

  const db = openDecisionsDb();
  if (!db) {
    sendJson(res, 200, { entries: [] });
    return;
  }

  try {
    const conditions: string[] = ['project_root = ?'];
    const params: unknown[] = [projectRoot];

    if (symbolId) {
      conditions.push('symbol_id = ?');
      params.push(symbolId);
    }
    if (filePath) {
      conditions.push('file_path = ?');
      params.push(filePath);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const entries = db
      .prepare(
        `SELECT id, title, type, valid_from, valid_until,
                CASE WHEN valid_until IS NULL THEN 1 ELSE 0 END as is_active
         FROM decisions ${where}
         ORDER BY valid_from ASC
         LIMIT 200`,
      )
      .all(...params) as DecisionTimelineEntry[];

    sendJson(res, 200, { entries });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message ?? 'Query failed' });
  } finally {
    db.close();
  }
}

/** GET /api/projects/decisions/stats — aggregate stats (total, by_type, by_source). */
export function handleDecisionsStats(res: http.ServerResponse, url: URL): void {
  const projectRoot = url.searchParams.get('project');
  if (!projectRoot) {
    sendJson(res, 400, { error: 'Missing ?project= query param' });
    return;
  }

  const db = openDecisionsDb();
  if (!db) {
    sendJson(res, 200, { total: 0, active: 0, by_type: {}, by_source: {}, pending_reviews: 0 });
    return;
  }

  try {
    const total = (
      db.prepare('SELECT COUNT(*) as c FROM decisions WHERE project_root = ?').get(projectRoot) as {
        c: number;
      }
    ).c;

    const active = (
      db
        .prepare(
          'SELECT COUNT(*) as c FROM decisions WHERE project_root = ? AND valid_until IS NULL',
        )
        .get(projectRoot) as { c: number }
    ).c;

    const typeRows = db
      .prepare('SELECT type, COUNT(*) as c FROM decisions WHERE project_root = ? GROUP BY type')
      .all(projectRoot) as Array<{ type: string; c: number }>;
    const by_type: Record<string, number> = {};
    for (const r of typeRows) by_type[r.type] = r.c;

    const sourceRows = db
      .prepare('SELECT source, COUNT(*) as c FROM decisions WHERE project_root = ? GROUP BY source')
      .all(projectRoot) as Array<{ source: string; c: number }>;
    const by_source: Record<string, number> = {};
    for (const r of sourceRows) by_source[r.source] = r.c;

    // Memoir review queue count — drives the "Review (N)" tab badge.
    const pending_reviews = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM decisions WHERE project_root = ? AND review_status = 'pending' AND valid_until IS NULL",
        )
        .get(projectRoot) as { c: number }
    ).c;

    sendJson(res, 200, { total, active, by_type, by_source, pending_reviews });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message ?? 'Query failed' });
  } finally {
    db.close();
  }
}

/** GET /api/projects/corpora — list corpus manifests filtered by project. */
export function handleListCorpora(res: http.ServerResponse, url: URL): void {
  const projectRoot = url.searchParams.get('project');
  if (!projectRoot) {
    sendJson(res, 400, { error: 'Missing ?project= query param' });
    return;
  }

  try {
    if (!fs.existsSync(CORPORA_DIR)) {
      sendJson(res, 200, { corpora: [] });
      return;
    }

    const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
    const entries = fs.readdirSync(CORPORA_DIR, { withFileTypes: true });
    const corpora: CorpusListItem[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const name = entry.name.slice(0, -'.json'.length);
      if (!NAME_PATTERN.test(name)) continue;

      const manifestPath = path.join(CORPORA_DIR, entry.name);
      let manifest: CorpusManifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CorpusManifest;
      } catch {
        continue;
      }

      if (manifest.projectRoot !== projectRoot) continue;

      // Size of the companion .pack.md file in KB
      const packPath = path.join(CORPORA_DIR, `${name}.pack.md`);
      let sizeKB: number | null = null;
      try {
        const stat = fs.statSync(packPath);
        sizeKB = Math.round((stat.size / 1024) * 10) / 10;
      } catch {
        /* pack file may not exist */
      }

      corpora.push({
        name: manifest.name,
        scope: manifest.scope,
        modulePath: manifest.modulePath,
        featureQuery: manifest.featureQuery,
        tokenBudget: manifest.tokenBudget,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        description: manifest.description,
        symbolCount: manifest.symbolCount,
        fileCount: manifest.fileCount,
        estimatedTokens: manifest.estimatedTokens,
        sizeKB,
      });
    }

    corpora.sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, { corpora });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message ?? 'Failed to list corpora' });
  }
}

/** GET /api/projects/sessions — list mined sessions from decisions.db, scoped to one project. */
export function handleListSessions(res: http.ServerResponse, url: URL): void {
  const projectRoot = url.searchParams.get('project');
  if (!projectRoot) {
    sendJson(res, 400, { error: 'Missing ?project= query param' });
    return;
  }

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10), 1), 500);

  const db = openDecisionsDb();
  if (!db) {
    sendJson(res, 200, { sessions: [] });
    return;
  }

  try {
    // mined_sessions has no project_root column, so attribute each row by
    // its session key instead (TRA-1065). Recorded ownership outranks every
    // path heuristic — it is checked FIRST, even for live files, because
    // discovery over-approximates when two projects share one encoded
    // Claude dir (encodeDirName is lossy: "/a-b" and "/a/b" collide).
    //
    //   1. decisions attribute the key to (one of) the related roots — the
    //      requested root plus its git worktrees (the miner adopts worktree
    //      sessions to the parent, so either may be recorded). File
    //      decisions store session_id = basename, provider decisions store
    //      the full synthetic key like "hermes:<id>" — check both. A key
    //      attributed to a different project is vetoed, never shown.
    //   2. live file, no recorded owner: Claw locations are exact per root,
    //      so discovery alone attributes them. Claude files carry their
    //      owner in the transcript `cwd` — verify it; an unreadable or
    //      foreign cwd excludes the row. Ambiguity never auto-shows a
    //      session under two projects.
    //   3. deleted file, no recorded owner: Claw requires exactly
    //      <root>/.claw/sessions/ (never the whole root tree, so a nested
    //      independent repo is not claimed by its parent); Claude requires
    //      the session dir to decode to exactly this root.
    // Rows matching none of these belong to other projects and are dropped:
    // a project with no mined sessions gets [], not another project's list.
    let projectPaths = new Set<string>();
    try {
      projectPaths = new Set(listAllSessions(projectRoot).map((s) => s.filePath));
    } catch {
      /* discovery failed — decisions + strict path fallbacks still apply */
    }
    const resolvedRoot = path.resolve(projectRoot);
    const related = new Set<string>([projectRoot, resolvedRoot]);
    for (const w of listGitWorktrees(resolvedRoot)) {
      related.add(w);
      related.add(path.resolve(w));
    }
    const clawSessionsPrefix = path.join(resolvedRoot, '.claw', 'sessions') + path.sep;

    let ownerStmt: Database.Statement | null = null;
    try {
      ownerStmt = db.prepare(
        'SELECT DISTINCT project_root FROM decisions WHERE session_id IN (?, ?)',
      );
    } catch {
      /* decisions table may predate session_id — path rules still apply */
    }
    const ownersOf = (sessionPath: string): string[] => {
      if (!ownerStmt) return [];
      try {
        const rows = ownerStmt.all(path.basename(sessionPath, '.jsonl'), sessionPath) as Array<{
          project_root: string;
        }>;
        return rows.map((r) => r.project_root);
      } catch {
        return [];
      }
    };
    const isOwnedHere = (owners: string[]): boolean => owners.some((o) => related.has(o));

    const isClaudeSessionPath = (sessionPath: string): boolean =>
      path.dirname(path.dirname(sessionPath)) === CLAUDE_PROJECTS_DIR;

    const belongsToProject = (row: MinedSessionRow): boolean => {
      const owners = ownersOf(row.session_path);
      if (owners.length > 0) return isOwnedHere(owners);
      if (!projectPaths.has(row.session_path)) {
        // Deleted file, no recorded owner — strict path fallbacks only.
        if (row.session_path.startsWith(clawSessionsPrefix)) return true;
        if (isClaudeSessionPath(row.session_path)) {
          try {
            const dir = path.dirname(row.session_path);
            if (decodeDirName(path.basename(dir)) === resolvedRoot) return true;
          } catch {
            /* undecodable — exclude */
          }
        }
        return false;
      }
      // Live file, no recorded owner.
      if (!isClaudeSessionPath(row.session_path)) return true;
      const cwd = readSessionCwd(row.session_path);
      if (cwd == null) return false;
      try {
        return related.has(path.resolve(cwd));
      } catch {
        return false;
      }
    };

    // The table is a mining log (hundreds of rows, not millions), so read
    // all rows newest-first, filter in JS, then apply the limit. Filtering
    // in SQL would need a dynamic IN-list over the project's session files.
    const rows = db
      .prepare(
        'SELECT session_path, mined_at, decisions_found FROM mined_sessions ORDER BY mined_at DESC',
      )
      .all() as MinedSessionRow[];

    const sessions = rows
      .filter(belongsToProject)
      .slice(0, limit)
      .map((r) => {
        // The session's own date is the live file's mtime — never the
        // mined_sessions bookkeeping column: markSessionMined() stamps
        // Date.now() there, so a legacy/provider row would otherwise report
        // the processing date as the session date. Missing file → unknown
        // (0); the UI then shows no date rather than a wrong one.
        let sessionMtimeMs = 0;
        try {
          sessionMtimeMs = fs.statSync(r.session_path).mtimeMs;
        } catch {
          /* deleted file or synthetic key — unknown */
        }
        return {
          session_path: r.session_path,
          mined_at: r.mined_at,
          decisions_found: r.decisions_found,
          session_id: path.basename(r.session_path, '.jsonl'),
          session_mtime_ms: sessionMtimeMs,
        };
      });

    sendJson(res, 200, { sessions });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message ?? 'Query failed' });
  } finally {
    db.close();
  }
}

// ── memory status + one-shot mine (TRA-1689) ───────────────────────────────
// The Memory tab is dead on a default install (background mining defaults to
// off) and its empty states never said so. These two endpoints let the UI
// state the automining flag honestly and offer a one-shot mine that does not
// touch the config.

/** GET /api/projects/memory/status — report the effective automining flag. */
export function handleMemoryStatus(res: http.ServerResponse, url: URL): void {
  const projectRoot = url.searchParams.get('project');
  if (!projectRoot) {
    sendJson(res, 400, { error: 'Missing ?project= query param' });
    return;
  }

  void (async () => {
    try {
      // Effective config: global defaults → per-project section → local
      // overrides. Unresolvable config reads as disabled, never as an error —
      // the UI treats "unknown" the same as "off" (no hint either way would
      // be the old silent empty state again).
      const result = await loadConfig(projectRoot);
      if (!result.isOk()) {
        sendJson(res, 200, { backgroundEnabled: false });
        return;
      }
      sendJson(res, 200, {
        backgroundEnabled: result.value.memory?.background?.enabled ?? false,
      });
    } catch {
      sendJson(res, 200, { backgroundEnabled: false });
    }
  })();
}

/** Projects with a mine already running — the daemon is one thread, so a
 *  second POST for the same root gets a 409 instead of queueing behind a
 *  multi-minute transcript scan. */
const mineInFlight = new Set<string>();

/**
 * POST /api/projects/memory/mine — one-shot regex mining for a project.
 *
 * Body: `{ project_root: string }`. Uses the offline regex strategy (no AI
 * provider, no cost, no config change) — the same pass the background
 * scheduler would run. Mined decisions flow through the review queue like
 * any other mined batch.
 */
export function handleMineMemory(req: http.IncomingMessage, res: http.ServerResponse): void {
  void (async () => {
    const body = await parseBody<{ project_root?: unknown }>(req);
    const projectRoot = typeof body?.project_root === 'string' ? body.project_root.trim() : '';
    if (!projectRoot) {
      sendJson(res, 400, { error: 'Missing project_root in request body' });
      return;
    }
    if (mineInFlight.has(projectRoot)) {
      sendJson(res, 409, { error: 'A mining run for this project is already in progress' });
      return;
    }

    mineInFlight.add(projectRoot);
    try {
      ensureGlobalDirs();
      const store = new DecisionStore(DECISIONS_DB_PATH);
      try {
        const result = await runMineStage({
          decisionStore: store,
          projectRoot,
          strategy: 'regex',
        });
        if (!result.ok && !result.skipped) {
          sendJson(res, 500, { error: result.error ?? 'Mining failed' });
          return;
        }
        sendJson(res, 200, {
          scanned: result.scanned ?? 0,
          mined: result.mined ?? 0,
          added: result.added ?? 0,
          durationMs: result.durationMs,
        });
      } finally {
        store.close();
      }
    } catch (e) {
      sendJson(res, 500, { error: (e as Error)?.message ?? 'Mining failed' });
    } finally {
      mineInFlight.delete(projectRoot);
    }
  })();
}
