/**
 * Behavioural coverage for the `mine_sessions` MCP tool. The tool calls
 * `mineSessions()` from src/memory/conversation-miner.ts, which scans
 * Claude Code / Claw Code JSONL session logs via `listAllSessions` and
 * extracts decision candidates via pattern matching.
 *
 * Approach: we hold the heavy filesystem discovery API still by mocking
 * `listAllSessions` to point at a tmpDir-hosted JSONL file. The rest of
 * the pipeline — JSONL parsing, decision extraction patterns, confidence
 * tiering, and persistence to DecisionStore — runs end-to-end against the
 * real implementation. This is the lightest possible fixture: one real
 * session file, one mocked discovery hook.
 *
 * Cases:
 *  - mining a fixture session extracts decision candidates above the
 *    reject floor and persists them to the DecisionStore
 *  - already-mined sessions are skipped on subsequent calls (idempotent)
 *  - `force: true` re-mines previously-mined sessions
 *  - `reject_threshold` parameter drops borderline decisions
 *  - result shape: { sessions_scanned, sessions_skipped, sessions_mined,
 *    decisions_extracted, errors, duration_ms }
 *
 * Note: the tool registers under MCP as `mine_sessions` and the
 * underlying function is `mineSessions`. We test the function directly so
 * the assertions don't require an MCP transport — same approach used by
 * the existing tests/memory/conversation-miner.test.ts file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionStore } from '../../../src/memory/decision-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

// Mock the session discovery hook — every call returns whatever the test
// most recently pushed onto `mockSessions`.
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
import { mineSessions } from '../../../src/memory/conversation-miner.js';

/**
 * Write a synthetic Claude Code-format JSONL session file with the given
 * assistant turns. Decision patterns are picked up from assistant text only,
 * and `parseConversationTurns` requires turn text length > 20 chars.
 */
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

describe('mine_sessions — behavioural contract', () => {
  let store: DecisionStore;
  let tmpDir: string;
  let dbPath: string;
  let sessionPath: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpDir = createTmpDir('mine-sessions-behav-');
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);

    // Use the tmpDir itself as the "project root" so the miner's
    // worktree-adoption logic sees a stable, real path.
    projectRoot = tmpDir;
    sessionPath = path.join(tmpDir, 'sessions', 'fixture-session.jsonl');

    // High-confidence decision text covering multiple extraction patterns
    // so we are robust to small regex changes.
    writeSessionFile(sessionPath, [
      { role: 'user', text: 'What stack are we picking for caching?' },
      {
        role: 'assistant',
        text: 'We decided to use Redis for session caching because it handles high throughput. The root cause was the previous in-memory cache thrashing under load.',
      },
    ]);

    mockSessions.length = 0;
    mockSessions.push({
      filePath: sessionPath,
      projectPath: projectRoot,
      client: 'claude-code',
      mtime: Date.now(),
    });
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
    mockSessions.length = 0;
  });

  it('mining a fixture session extracts decision candidates and persists them', async () => {
    const result = await mineSessions(store, {
      projectRoot,
      // Drop the reject floor so even mid-confidence pattern hits land in
      // the store — keeps the assertion stable against regex tweaks.
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });

    // Result shape contract.
    expect(result).toEqual(
      expect.objectContaining({
        sessions_scanned: expect.any(Number),
        sessions_skipped: expect.any(Number),
        sessions_mined: expect.any(Number),
        decisions_extracted: expect.any(Number),
        errors: expect.any(Number),
        duration_ms: expect.any(Number),
      }),
    );
    expect(result.sessions_scanned).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);
    expect(result.decisions_extracted).toBeGreaterThan(0);

    // Persisted rows appear under the project root, sourced as 'mined'.
    const rows = store.queryDecisions({
      project_root: projectRoot,
      include_pending: true,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === 'mined')).toBe(true);
  });

  it('already-mined sessions are skipped on subsequent calls (idempotent)', async () => {
    const first = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    expect(first.sessions_mined).toBeGreaterThanOrEqual(1);

    // Mining tracker now marks the session.
    expect(store.isSessionMined(sessionPath)).toBe(true);

    const second = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    // Second pass scans but skips — no new mining, no new decisions.
    expect(second.sessions_mined).toBe(0);
    expect(second.decisions_extracted).toBe(0);
    expect(second.sessions_skipped).toBeGreaterThanOrEqual(1);
  });

  it('force: true re-mines previously-mined sessions', async () => {
    await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    const baselineRows = store.queryDecisions({
      project_root: projectRoot,
      include_pending: true,
    }).length;
    expect(baselineRows).toBeGreaterThan(0);

    const forced = await mineSessions(store, {
      projectRoot,
      force: true,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    expect(forced.sessions_mined).toBeGreaterThanOrEqual(1);
    expect(forced.decisions_extracted).toBeGreaterThan(0);

    // force re-mines → rows duplicate. Exact count depends on extraction,
    // so just assert the store grew rather than pin a magic number.
    const afterRows = store.queryDecisions({
      project_root: projectRoot,
      include_pending: true,
    }).length;
    expect(afterRows).toBeGreaterThan(baselineRows);
  });

  it('reject_threshold drops decisions below the floor (no rows persisted)', async () => {
    // No pattern in the fixture clears 0.99 confidence, so nothing should
    // be persisted when the reject floor is set that high.
    const result = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0.99,
      reviewThreshold: 1.0,
    });

    expect(result.errors).toBe(0);
    expect(result.decisions_extracted).toBe(0);

    const rows = store.queryDecisions({
      project_root: projectRoot,
      include_pending: true,
    });
    expect(rows.length).toBe(0);
  });

  it('result shape exposes the documented counter set', async () => {
    const result = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });

    // Spot-check that every advertised key exists and is the right kind of
    // value — guards against accidental rename/removal in the future.
    expect(Object.keys(result).sort()).toEqual(
      [
        'decisions_extracted',
        'duration_ms',
        'errors',
        'sessions_mined',
        'sessions_scanned',
        'sessions_skipped',
      ].sort(),
    );
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
