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
 */

import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import Database from 'better-sqlite3';
import { DECISIONS_DB_PATH, CORPORA_DIR } from '../shared/paths.js';
import type { DecisionRow, DecisionTimelineEntry } from '../memory/decision-store.js';
import { DecisionStore } from '../memory/decision-store.js';
import { CorpusStore, validateCorpusName, CorpusValidationError } from '../memory/corpus-store.js';

// ── Types matching the DecisionStore schema ──────────────────────────────────

interface MinedSessionRow {
  session_path: string;
  mined_at: string;
  decisions_found: number;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Open decisions.db in read-only mode (WAL; 5 s busy timeout).
 * Returns null when the file does not exist yet.
 */
function openDecisionsDb(): Database.Database | null {
  if (!fs.existsSync(DECISIONS_DB_PATH)) return null;
  try {
    const db = new Database(DECISIONS_DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 5000');
    return db;
  } catch {
    return null;
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Read the full request body as a UTF-8 string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Parse JSON body; return null on any error. */
async function parseBody<T>(req: http.IncomingMessage): Promise<T | null> {
  try {
    const raw = await readBody(req);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

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
          const row = store.addDecision({
            project_root: body.project_root,
            title: body.title,
            content: body.content,
            type: type as import('../memory/decision-store.js').DecisionType,
            symbol_id: body.symbol_id,
            file_path: body.file_path,
            tags: tagsArray,
            source: (body.source as 'manual' | 'mined' | 'auto') ?? 'manual',
          });
          sendJson(res, 201, { id: row.id });
        } finally {
          store.close();
        }
      } catch (e) {
        sendJson(res, 500, { error: (e as Error).message ?? 'Failed to create decision' });
      }
    })();
    return true;
  }

  // PATCH /api/projects/decisions/:id — update mutable fields
  const patchDecisionMatch = /^\/api\/projects\/decisions\/(\d+)$/.exec(url.pathname);
  if (method === 'PATCH' && patchDecisionMatch) {
    const id = parseInt(patchDecisionMatch[1], 10);
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
    return true;
  }

  // POST /api/projects/decisions/:id/invalidate — invalidate a decision
  const invalidateMatch = /^\/api\/projects\/decisions\/(\d+)\/invalidate$/.exec(url.pathname);
  if (method === 'POST' && invalidateMatch) {
    const id = parseInt(invalidateMatch[1], 10);
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
    return true;
  }

  // POST /api/projects/corpora/:name/query — query a corpus pack body
  const corpusQueryMatch = /^\/api\/projects\/corpora\/([^/]+)\/query$/.exec(url.pathname);
  if (method === 'POST' && corpusQueryMatch) {
    const name = corpusQueryMatch[1];
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
    return true;
  }

  // DELETE /api/projects/corpora/:name — delete corpus files
  const corpusDeleteMatch = /^\/api\/projects\/corpora\/([^/]+)$/.exec(url.pathname);
  if (method === 'DELETE' && corpusDeleteMatch) {
    const name = corpusDeleteMatch[1];
    const projectRoot = url.searchParams.get('project_root');
    if (!projectRoot) {
      sendJson(res, 400, { error: 'Missing ?project_root= query param' });
      return true;
    }

    try {
      validateCorpusName(name);
    } catch (e) {
      if (e instanceof CorpusValidationError) {
        sendJson(res, 400, { error: (e as Error).message });
        return true;
      }
      throw e;
    }

    try {
      const store = new CorpusStore();
      const manifest = store.load(name);
      if (!manifest) {
        sendJson(res, 404, { error: `Corpus "${name}" not found` });
        return true;
      }
      if (manifest.projectRoot !== projectRoot) {
        sendJson(res, 403, { error: 'Corpus does not belong to the specified project' });
        return true;
      }
      store.delete(name);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message ?? 'Delete failed' });
    }
    return true;
  }

  // ── v1 read-only routes ─────────────────────────────────────────────────────
  if (method !== 'GET') return false;

  // ── GET /api/projects/decisions ───────────────────────────────────────────
  if (url.pathname === '/api/projects/decisions') {
    const projectRoot = url.searchParams.get('project');
    if (!projectRoot) {
      sendJson(res, 400, { error: 'Missing ?project= query param' });
      return true;
    }

    const q = url.searchParams.get('q') ?? '';
    const type = url.searchParams.get('type') ?? '';
    const symbolId = url.searchParams.get('symbol_id') ?? '';
    const filePath = url.searchParams.get('file_path') ?? '';
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10), 1), 200);
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10), 0);

    const db = openDecisionsDb();
    if (!db) {
      sendJson(res, 200, { decisions: [], total: 0, limit, offset });
      return true;
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
        conditions.push('id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ?)');
        params.push(q);
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
    return true;
  }

  // ── GET /api/projects/decisions/timeline ──────────────────────────────────
  if (url.pathname === '/api/projects/decisions/timeline') {
    const projectRoot = url.searchParams.get('project');
    const symbolId = url.searchParams.get('symbol_id') ?? '';
    const filePath = url.searchParams.get('file_path') ?? '';

    if (!projectRoot) {
      sendJson(res, 400, { error: 'Missing ?project= query param' });
      return true;
    }

    const db = openDecisionsDb();
    if (!db) {
      sendJson(res, 200, { entries: [] });
      return true;
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
    return true;
  }

  // ── GET /api/projects/decisions/stats ─────────────────────────────────────
  if (url.pathname === '/api/projects/decisions/stats') {
    const projectRoot = url.searchParams.get('project');
    if (!projectRoot) {
      sendJson(res, 400, { error: 'Missing ?project= query param' });
      return true;
    }

    const db = openDecisionsDb();
    if (!db) {
      sendJson(res, 200, { total: 0, active: 0, by_type: {}, by_source: {} });
      return true;
    }

    try {
      const total = (
        db
          .prepare('SELECT COUNT(*) as c FROM decisions WHERE project_root = ?')
          .get(projectRoot) as { c: number }
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
        .prepare(
          'SELECT source, COUNT(*) as c FROM decisions WHERE project_root = ? GROUP BY source',
        )
        .all(projectRoot) as Array<{ source: string; c: number }>;
      const by_source: Record<string, number> = {};
      for (const r of sourceRows) by_source[r.source] = r.c;

      sendJson(res, 200, { total, active, by_type, by_source });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message ?? 'Query failed' });
    } finally {
      db.close();
    }
    return true;
  }

  // ── GET /api/projects/corpora ─────────────────────────────────────────────
  if (url.pathname === '/api/projects/corpora') {
    const projectRoot = url.searchParams.get('project');
    if (!projectRoot) {
      sendJson(res, 400, { error: 'Missing ?project= query param' });
      return true;
    }

    try {
      if (!fs.existsSync(CORPORA_DIR)) {
        sendJson(res, 200, { corpora: [] });
        return true;
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
    return true;
  }

  // ── GET /api/projects/sessions ────────────────────────────────────────────
  if (url.pathname === '/api/projects/sessions') {
    const projectRoot = url.searchParams.get('project');
    if (!projectRoot) {
      sendJson(res, 400, { error: 'Missing ?project= query param' });
      return true;
    }

    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10), 1), 500);

    const db = openDecisionsDb();
    if (!db) {
      sendJson(res, 200, { sessions: [] });
      return true;
    }

    try {
      // mined_sessions has no project_root column — return all sessions,
      // ordered newest-first, up to limit. The UI can display all or filter
      // by path prefix if needed.
      const sessions = db
        .prepare(
          'SELECT session_path, mined_at, decisions_found FROM mined_sessions ORDER BY mined_at DESC LIMIT ?',
        )
        .all(limit) as MinedSessionRow[];

      sendJson(res, 200, { sessions });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message ?? 'Query failed' });
    } finally {
      db.close();
    }
    return true;
  }

  return false;
}
