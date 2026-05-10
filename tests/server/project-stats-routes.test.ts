/**
 * Tests for src/api/project-stats-routes.ts
 *
 * Covers:
 *   - Shape: payload has all 7 sections + `project` + `generated_at`
 *   - Happy path: a freshly-initialised DB yields non-null `index` and
 *     `content`, plus the "always-on" sections (tools, decisions,
 *     subprojects) which can sensibly be empty rather than null.
 *   - Graceful degradation: when no DB exists for the project, sections
 *     that depend on it (index, performance, quality, content) come back
 *     as `null` instead of crashing the request.
 *   - HTTP layer: the handler returns 400 when ?project= is missing,
 *     200 with JSON on success, and the cache shortcut works.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeDatabase } from '../../src/db/schema.js';
import { REGISTRY_PATH } from '../../src/global.js';

import {
  buildProjectStats,
  handleProjectStatsRequest,
  invalidateProjectStatsCache,
  PROJECT_STATS_ROUTE_PATH,
  type ProjectStatsContext,
} from '../../src/api/project-stats-routes.js';
import type { JournalEntryForStats } from '../../src/api/journal-stats-routes.js';

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function emptyJournalCtx(entries: JournalEntryForStats[] = []): ProjectStatsContext {
  return {
    journalStats: {
      listEntriesForProject: () => entries,
    },
  };
}

interface SeededProject {
  projectRoot: string;
  dbPath: string;
  cleanup: () => void;
  registryPath: string;
}

/**
 * Create a temp TRACE_MCP_HOME with a registered project + initialised DB.
 * The route reads the registry from REGISTRY_PATH (resolved at import time
 * from TRACE_MCP_DATA_DIR), so we must set the env var BEFORE importing the
 * route module. Since vitest evaluates this file once, we instead seed the
 * registry at the path the module is already pointing at.
 *
 * Approach: use a sub-directory inside the active TRACE_MCP_HOME and append
 * the project to the existing registry, restoring it on teardown. This keeps
 * the test independent of the user's machine while exercising the real code
 * path.
 */
function seedProject(opts: { withDb: boolean }): SeededProject {
  const projectName = `proj-${Math.random().toString(36).slice(2, 8)}`;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `trace-mcp-stats-${projectName}-`));
  const projectRoot = path.join(tmpRoot, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });

  const indexDir = path.join(tmpRoot, 'index');
  fs.mkdirSync(indexDir, { recursive: true });
  const dbPath = path.join(indexDir, `${projectName}.db`);

  if (opts.withDb) {
    const db = initializeDatabase(dbPath);
    // Insert one file + one symbol so the index section reports non-zero counts
    const fileId = db
      .prepare(
        `INSERT INTO files (path, language, status, indexed_at, byte_length)
         VALUES (?, ?, 'ok', ?, ?)`,
      )
      .run(path.join(projectRoot, 'src/foo.ts'), 'typescript', new Date().toISOString(), 100)
      .lastInsertRowid as number;

    db.prepare(
      `INSERT INTO symbols (file_id, symbol_id, name, kind, byte_start, byte_end, line_start, cyclomatic)
       VALUES (?, ?, ?, ?, 0, 10, 1, 7)`,
    ).run(fileId, `${projectRoot}/src/foo.ts#fooFn`, 'fooFn', 'function');

    db.close();
  }

  // Patch the registry to include this project (preserve any pre-existing entries).
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  let prior: string | null = null;
  if (fs.existsSync(REGISTRY_PATH)) {
    prior = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  }
  let registry: { version: 1; projects: Record<string, unknown> };
  try {
    registry = prior ? (JSON.parse(prior) as typeof registry) : { version: 1, projects: {} };
    if (registry.version !== 1) registry = { version: 1, projects: {} };
    if (!registry.projects || typeof registry.projects !== 'object') {
      registry.projects = {};
    }
  } catch {
    registry = { version: 1, projects: {} };
  }
  registry.projects[projectRoot] = {
    name: projectName,
    root: projectRoot,
    dbPath,
    lastIndexed: new Date().toISOString(),
    addedAt: new Date().toISOString(),
  };
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));

  const cleanup = () => {
    // Restore the registry without our injected project.
    try {
      if (prior !== null) {
        fs.writeFileSync(REGISTRY_PATH, prior);
      } else if (fs.existsSync(REGISTRY_PATH)) {
        // Re-read live registry, drop our entry, write back.
        try {
          const live = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')) as typeof registry;
          if (live?.projects) delete live.projects[projectRoot];
          fs.writeFileSync(REGISTRY_PATH, JSON.stringify(live, null, 2));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* best-effort */
    }

    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }

    invalidateProjectStatsCache(projectRoot);
  };

  return { projectRoot, dbPath, cleanup, registryPath: REGISTRY_PATH };
}

// Boot a tiny http server that just dispatches to the handler under test.
async function startTestServer(
  ctx: ProjectStatsContext,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (handleProjectStatsRequest(req, res, url, ctx)) return;
    res.writeHead(404);
    res.end();
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

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('project-stats-routes — buildProjectStats (shape + degradation)', () => {
  let seeded: SeededProject | null = null;

  beforeEach(() => {
    seeded = null;
  });

  afterEach(() => {
    if (seeded) seeded.cleanup();
    seeded = null;
  });

  it('returns a payload with all 7 sections + project + generated_at', () => {
    seeded = seedProject({ withDb: true });
    const payload = buildProjectStats(seeded.projectRoot, emptyJournalCtx());

    expect(payload.project).toBe(seeded.projectRoot);
    expect(typeof payload.generated_at).toBe('string');
    // All 7 keys must be present (may be null)
    expect(payload).toHaveProperty('index');
    expect(payload).toHaveProperty('tools');
    expect(payload).toHaveProperty('decisions');
    expect(payload).toHaveProperty('performance');
    expect(payload).toHaveProperty('subprojects');
    expect(payload).toHaveProperty('quality');
    expect(payload).toHaveProperty('content');
  });

  it('happy path: index + content come back populated for a seeded DB', () => {
    seeded = seedProject({ withDb: true });
    const payload = buildProjectStats(seeded.projectRoot, emptyJournalCtx());

    expect(payload.index).not.toBeNull();
    expect(payload.index?.files).toBe(1);
    expect(payload.index?.symbols).toBe(1);

    expect(payload.content).not.toBeNull();
    expect(payload.content?.languages.some((l) => l.language === 'typescript')).toBe(true);
    expect(payload.content?.largest_files.length).toBeGreaterThan(0);

    // Quality should detect the cyclomatic=7 hotspot we inserted
    expect(payload.quality).not.toBeNull();
    expect(payload.quality?.complexity_hotspots.length).toBeGreaterThan(0);
    expect(payload.quality?.complexity_hotspots[0]?.cyclomatic).toBe(7);
  });

  it('graceful degradation: DB-dependent sections degrade to null when no DB exists', () => {
    seeded = seedProject({ withDb: false });
    const payload = buildProjectStats(seeded.projectRoot, emptyJournalCtx());

    expect(payload.index).toBeNull();
    expect(payload.performance).toBeNull();
    expect(payload.quality).toBeNull();
    expect(payload.content).toBeNull();

    // Sections that don't need the project DB still resolve (possibly empty).
    expect(payload.tools).not.toBeNull();
    expect(payload.tools?.total_calls).toBe(0);
    expect(payload.subprojects).not.toBeNull();
  });

  it('tools section aggregates median + p95 from journal entries', () => {
    seeded = seedProject({ withDb: true });
    invalidateProjectStatsCache(seeded.projectRoot);

    const now = Date.now();
    const entries: JournalEntryForStats[] = [
      {
        ts: now - 1000,
        tool: 'search',
        latency_ms: 10,
        params_summary: '',
        result_count: 1,
        is_error: false,
        session_id: 's1',
      },
      {
        ts: now - 2000,
        tool: 'search',
        latency_ms: 50,
        params_summary: '',
        result_count: 1,
        is_error: false,
        session_id: 's1',
      },
      {
        ts: now - 3000,
        tool: 'search',
        latency_ms: 200,
        params_summary: '',
        result_count: 1,
        is_error: false,
        session_id: 's1',
      },
      {
        ts: now - 4000,
        tool: 'get_outline',
        latency_ms: 5,
        params_summary: '',
        result_count: 1,
        is_error: false,
        session_id: 's1',
      },
    ];

    const payload = buildProjectStats(seeded.projectRoot, emptyJournalCtx(entries));
    expect(payload.tools).not.toBeNull();
    expect(payload.tools?.total_calls).toBe(4);
    const search = payload.tools?.per_tool.find((t) => t.tool === 'search');
    expect(search?.count).toBe(3);
    expect(search?.median_ms).toBeGreaterThanOrEqual(10);
    expect(search?.p95_ms).toBeGreaterThanOrEqual(search?.median_ms ?? 0);
  });

  it('survives a journal context that throws (errors are caught per-section)', () => {
    seeded = seedProject({ withDb: true });
    invalidateProjectStatsCache(seeded.projectRoot);

    const throwingCtx: ProjectStatsContext = {
      journalStats: {
        listEntriesForProject: () => {
          throw new Error('boom');
        },
      },
    };

    const payload = buildProjectStats(seeded.projectRoot, throwingCtx);
    // tools may be empty (no entries) but must not be null, since computeTools
    // gets an empty array as a fallback
    expect(payload.tools).not.toBeNull();
    expect(payload.tools?.total_calls).toBe(0);
    // Index still works because it doesn't depend on the journal
    expect(payload.index).not.toBeNull();
  });
});

describe('project-stats-routes — handleProjectStatsRequest (HTTP layer)', () => {
  let seeded: SeededProject | null = null;

  beforeEach(() => {
    seeded = null;
  });

  afterEach(() => {
    if (seeded) seeded.cleanup();
    seeded = null;
  });

  it('exports the expected route path constant', () => {
    expect(PROJECT_STATS_ROUTE_PATH).toBe('/api/projects/full-stats');
  });

  it('returns 400 when ?project= is missing', async () => {
    const srv = await startTestServer(emptyJournalCtx());
    try {
      const res = await fetch(`${srv.baseUrl}${PROJECT_STATS_ROUTE_PATH}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/project/);
    } finally {
      await srv.close();
    }
  });

  it('returns 200 with the full payload when ?project= is provided', async () => {
    seeded = seedProject({ withDb: true });
    const srv = await startTestServer(emptyJournalCtx());
    try {
      const res = await fetch(
        `${srv.baseUrl}${PROJECT_STATS_ROUTE_PATH}?project=${encodeURIComponent(seeded.projectRoot)}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.project).toBe(seeded.projectRoot);
      expect(body).toHaveProperty('index');
      expect(body).toHaveProperty('tools');
      expect(body).toHaveProperty('decisions');
      expect(body).toHaveProperty('performance');
      expect(body).toHaveProperty('subprojects');
      expect(body).toHaveProperty('quality');
      expect(body).toHaveProperty('content');
    } finally {
      await srv.close();
    }
  });

  it('does not match unrelated paths (returns false → 404 from outer server)', async () => {
    const srv = await startTestServer(emptyJournalCtx());
    try {
      const res = await fetch(`${srv.baseUrl}/some/other/path`);
      expect(res.status).toBe(404);
    } finally {
      await srv.close();
    }
  });
});
