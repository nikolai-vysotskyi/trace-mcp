/**
 * Behavioural coverage for `getSessionResume()` — the engine behind the
 * `get_session_resume` MCP tool.
 *
 * IMPL NOTE: the tool is inline-registered in `src/tools/register/session.ts`
 * with virtually no logic of its own — it forwards to
 * `getSessionResume(projectRoot, maxSessions)`. We assert the underlying
 * function (same approach as `get-env-vars.behavioural.test.ts`).
 *
 * Storage layer writes to `~/.trace-mcp/sessions/<projectHash>.json`. We
 * override the root via `TRACE_MCP_DATA_DIR` BEFORE the first import so all
 * subsequent reads/writes are confined to a temp directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const PROJECT_ROOT = '/projects/session-resume-fixture';

let tmpHome: string;
let previousDataDir: string | undefined;

// Set the override BEFORE the impl is imported — TRACE_MCP_HOME is resolved
// at module-load time. We capture the previous value and restore it on exit.
beforeAll(() => {
  previousDataDir = process.env.TRACE_MCP_DATA_DIR;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-resume-'));
  process.env.TRACE_MCP_DATA_DIR = tmpHome;
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.TRACE_MCP_DATA_DIR;
  else process.env.TRACE_MCP_DATA_DIR = previousDataDir;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Lazy import — the env override must be in place first.
async function loadImpl() {
  const mod = await import('../../../src/session/resume.js');
  const globalMod = await import('../../../src/global.js');
  return { ...mod, projectHash: globalMod.projectHash };
}

function sessionsFile(projectRoot: string, hash: string): string {
  return path.join(tmpHome, 'sessions', `${hash}.json`);
}

function writeSeedSessions(filePath: string, sessions: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(sessions), 'utf-8');
}

describe('getSessionResume() — behavioural contract', () => {
  let sessionsPath: string;

  beforeEach(async () => {
    const { projectHash } = await loadImpl();
    sessionsPath = sessionsFile(PROJECT_ROOT, projectHash(PROJECT_ROOT));
    // Reset any state from a prior test
    if (fs.existsSync(sessionsPath)) fs.unlinkSync(sessionsPath);
  });

  afterEach(() => {
    if (fs.existsSync(sessionsPath)) fs.unlinkSync(sessionsPath);
  });

  it('returns a populated envelope when sessions are seeded', async () => {
    const { getSessionResume } = await loadImpl();
    writeSeedSessions(sessionsPath, [
      {
        session_id: 'sess-a',
        project_root: PROJECT_ROOT,
        started_at: '2025-01-01T10:00:00.000Z',
        ended_at: '2025-01-01T10:15:00.000Z',
        total_calls: 12,
        files_touched: ['src/a.ts', 'src/b.ts'],
        top_tools: { search: 5, get_outline: 4 },
        dead_ends: ['no-such-symbol'],
        dedup_saved_tokens: 240,
      },
      {
        session_id: 'sess-b',
        project_root: PROJECT_ROOT,
        started_at: '2025-01-02T10:00:00.000Z',
        ended_at: '2025-01-02T10:30:00.000Z',
        total_calls: 7,
        files_touched: ['src/a.ts'],
        top_tools: { search: 3 },
        dead_ends: [],
        dedup_saved_tokens: 100,
      },
    ]);

    const result = getSessionResume(PROJECT_ROOT, 5);

    expect(result.project).toBe(path.basename(PROJECT_ROOT));
    expect(result.sessions_available).toBe(2);
    expect(result.recent_sessions.length).toBe(2);
    expect(Array.isArray(result.hot_files)).toBe(true);
    expect(Array.isArray(result.persistent_dead_ends)).toBe(true);
    expect(Array.isArray(result.prefetch_candidates)).toBe(true);
  });

  it('max_sessions caps recent_sessions length', async () => {
    const { getSessionResume } = await loadImpl();
    const seeded = Array.from({ length: 6 }, (_v, i) => ({
      session_id: `sess-${i}`,
      project_root: PROJECT_ROOT,
      started_at: `2025-01-0${i + 1}T10:00:00.000Z`,
      ended_at: `2025-01-0${i + 1}T10:10:00.000Z`,
      total_calls: 3,
      files_touched: ['src/x.ts'],
      top_tools: {},
      dead_ends: [],
      dedup_saved_tokens: 0,
    }));
    writeSeedSessions(sessionsPath, seeded);

    const two = getSessionResume(PROJECT_ROOT, 2);
    expect(two.recent_sessions.length).toBe(2);
    // Most recent first/last semantics — tail of array is most recent.
    expect(two.recent_sessions.map((s) => s.session_id)).toEqual(['sess-4', 'sess-5']);

    const four = getSessionResume(PROJECT_ROOT, 4);
    expect(four.recent_sessions.length).toBe(4);
    // sessions_available reports the underlying file count, not the cap.
    expect(four.sessions_available).toBe(6);
  });

  it('empty journal returns an empty envelope (no sessions on disk)', async () => {
    const { getSessionResume } = await loadImpl();
    // sessionsPath is intentionally absent.
    expect(fs.existsSync(sessionsPath)).toBe(false);
    const result = getSessionResume('/projects/never-seen', 5);
    expect(result.sessions_available).toBe(0);
    expect(result.recent_sessions).toEqual([]);
    expect(result.hot_files).toEqual([]);
    expect(result.persistent_dead_ends).toEqual([]);
    expect(result.prefetch_candidates).toEqual([]);
  });

  it('each recent_session carries files_touched + top_tools fields', async () => {
    const { getSessionResume } = await loadImpl();
    writeSeedSessions(sessionsPath, [
      {
        session_id: 'sess-shape',
        project_root: PROJECT_ROOT,
        started_at: '2025-02-01T10:00:00.000Z',
        ended_at: '2025-02-01T10:20:00.000Z',
        total_calls: 4,
        files_touched: ['src/m.ts', 'src/n.ts'],
        top_tools: { get_symbol: 2, search: 2 },
        dead_ends: ['missing-helper'],
        dedup_saved_tokens: 30,
      },
    ]);

    const result = getSessionResume(PROJECT_ROOT, 5);
    expect(result.recent_sessions.length).toBe(1);
    const s = result.recent_sessions[0];
    expect(s.session_id).toBe('sess-shape');
    expect(s.calls).toBe(4);
    expect(Array.isArray(s.files_touched)).toBe(true);
    expect(s.files_touched).toContain('src/m.ts');
    expect(typeof s.top_tools).toBe('object');
    expect(s.top_tools.get_symbol).toBe(2);
    expect(s.dead_ends).toEqual(['missing-helper']);
  });
});
