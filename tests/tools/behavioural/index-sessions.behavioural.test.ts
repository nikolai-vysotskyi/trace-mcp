/**
 * Behavioural coverage for `indexSessions()` — the engine behind the
 * `index_sessions` MCP tool.
 *
 * IMPL: src/memory/session-indexer.ts
 *
 * The tool calls `indexSessions(decisionStore, { projectRoot, force })`. The
 * function walks `listAllSessions()` (claude-code + claw-code JSONL files),
 * parses message content, and inserts ~500-char chunks into the
 * DecisionStore's session_chunks table. We mock `listAllSessions` to point at
 * tmpDir-hosted JSONL fixtures so the test is hermetic.
 *
 * Cases:
 *  - indexing fixture sessions yields { sessions_scanned, sessions_indexed,
 *    chunks_added, ... } with chunks_added>0
 *  - already-indexed sessions are skipped on subsequent calls (idempotent)
 *  - force: true re-indexes previously-indexed sessions
 *  - project_root filter narrows to one project
 *  - empty source returns zero counters
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionStore } from '../../../src/memory/decision-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

type MockSession = {
  filePath: string;
  projectPath: string;
  client: 'claude-code' | 'claw-code';
  mtime: number;
};
const mockSessions: MockSession[] = [];

vi.mock('../../../src/analytics/log-parser.js', () => ({
  listAllSessions: () => mockSessions.slice(),
}));

// Import after the mock is registered.
import { indexSessions } from '../../../src/memory/session-indexer.js';

function writeSessionFile(
  filePath: string,
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = turns.map((turn, i) => {
    const timestamp = new Date(Date.now() - (turns.length - i) * 60_000).toISOString();
    return JSON.stringify({
      type: turn.role,
      timestamp,
      message: {
        role: turn.role,
        content: [{ type: 'text', text: turn.text }],
      },
    });
  });
  fs.writeFileSync(filePath, lines.join('\n'));
}

// Indexer's MIN_MESSAGE_CHARS = 50; pad short fixtures so they aren't dropped.
const LONG_USER = 'I want to discuss the architectural plan for caching across the platform.';
const LONG_ASSISTANT =
  'Indexing should chunk every assistant turn into roughly 500 token blocks for FTS. Persist each chunk with role, session_id, and project_root so the searcher can filter later.';

describe('indexSessions() — behavioural contract', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: DecisionStore;
  let projectA: string;
  let projectB: string;
  let sessionA: string;
  let sessionB: string;

  beforeEach(() => {
    tmpDir = createTmpDir('index-sessions-behav-');
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);

    projectA = path.join(tmpDir, 'project-a');
    projectB = path.join(tmpDir, 'project-b');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    sessionA = path.join(tmpDir, 'sessions', 'sess-a.jsonl');
    sessionB = path.join(tmpDir, 'sessions', 'sess-b.jsonl');
    writeSessionFile(sessionA, [
      { role: 'user', text: LONG_USER },
      { role: 'assistant', text: LONG_ASSISTANT },
    ]);
    writeSessionFile(sessionB, [
      { role: 'user', text: LONG_USER },
      { role: 'assistant', text: LONG_ASSISTANT },
    ]);

    mockSessions.length = 0;
    mockSessions.push(
      { filePath: sessionA, projectPath: projectA, client: 'claude-code', mtime: Date.now() },
      { filePath: sessionB, projectPath: projectB, client: 'claude-code', mtime: Date.now() },
    );
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
    mockSessions.length = 0;
  });

  it('indexes fixture sessions and reports the documented counters', () => {
    const result = indexSessions(store);
    expect(result).toEqual(
      expect.objectContaining({
        sessions_scanned: expect.any(Number),
        sessions_indexed: expect.any(Number),
        sessions_skipped: expect.any(Number),
        chunks_added: expect.any(Number),
        errors: expect.any(Number),
        duration_ms: expect.any(Number),
      }),
    );
    expect(result.sessions_scanned).toBe(2);
    expect(result.sessions_indexed).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.chunks_added).toBeGreaterThan(0);

    // Chunks survived round-trip into the store.
    expect(store.getSessionChunkCount()).toBe(result.chunks_added);
  });

  it('already-indexed sessions are skipped on a second call (idempotent)', () => {
    const first = indexSessions(store);
    expect(first.sessions_indexed).toBe(2);

    const second = indexSessions(store);
    expect(second.sessions_scanned).toBe(2);
    expect(second.sessions_indexed).toBe(0);
    expect(second.chunks_added).toBe(0);
    expect(second.sessions_skipped).toBe(2);
  });

  it('force: true bypasses the already-indexed short-circuit', () => {
    const first = indexSessions(store);
    expect(first.sessions_indexed).toBe(2);
    const baselineChunks = store.getSessionChunkCount();
    expect(baselineChunks).toBeGreaterThan(0);

    const forced = indexSessions(store, { force: true });
    // force=true re-runs the indexer for already-indexed sessions; underlying
    // INSERT OR IGNORE dedupes by (session_id, chunk_index) so chunks_added
    // may be 0 — but sessions_indexed proves the short-circuit was bypassed.
    expect(forced.sessions_indexed).toBe(2);
    expect(forced.sessions_skipped).toBe(0);

    // Store does not lose chunks across a forced re-run.
    expect(store.getSessionChunkCount()).toBeGreaterThanOrEqual(baselineChunks);
  });

  it('project_root filter narrows indexing to one project', () => {
    const result = indexSessions(store, { projectRoot: projectA });

    expect(result.sessions_scanned).toBe(2);
    expect(result.sessions_indexed).toBe(1);
    expect(result.sessions_skipped).toBe(1);
    expect(result.chunks_added).toBeGreaterThan(0);

    // The only persisted chunks belong to projectA.
    expect(store.getSessionChunkCount(projectA)).toBe(result.chunks_added);
    expect(store.getSessionChunkCount(projectB)).toBe(0);
  });

  it('empty source returns zero counters', () => {
    mockSessions.length = 0;
    const result = indexSessions(store);
    expect(result.sessions_scanned).toBe(0);
    expect(result.sessions_indexed).toBe(0);
    expect(result.sessions_skipped).toBe(0);
    expect(result.chunks_added).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
