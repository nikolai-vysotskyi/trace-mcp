/**
 * TRA-865: the third leg of TRA-759 ("measure, suggest, apply, watch") — a
 * snapshot of the startup block's size, compared against history, that
 * stays silent unless growth crosses a threshold big enough to not be noise.
 *
 * What must hold, and what breaks if it does not:
 *  - the very first sample on a machine never fires — there is nothing to
 *    compare it to, and "grew from zero" is a lie, not a measurement;
 *  - a session-to-session wobble under the threshold stays silent — the
 *    issue this module implements names +200 tokens explicitly as the
 *    failure mode ("gets muted within a week");
 *  - real growth, whether one big jump or creep spread across many small
 *    sessions inside the lookback window, produces exactly one number (the
 *    delta) and exactly one action (run the audit) — never a shrinkage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkStartupWatch,
  evaluateStartupGrowth,
  sampleLatestStartup,
  type StartupWatchEntry,
} from '../../src/analytics/startup-watch.js';

const DAY_MS = 86_400_000;

describe('evaluateStartupGrowth (pure)', () => {
  it('stays silent with no baseline in the lookback window (first-ever sample)', () => {
    const notice = evaluateStartupGrowth([], {
      takenAt: new Date().toISOString(),
      startupTokens: 20_000,
      projectPath: '/p',
    });
    expect(notice).toBeNull();
  });

  it('stays silent when a baseline exists but is older than the lookback window', () => {
    const now = Date.now();
    const history: StartupWatchEntry[] = [
      { takenAt: new Date(now - 30 * DAY_MS).toISOString(), startupTokens: 10_000 },
    ];
    const notice = evaluateStartupGrowth(history, {
      takenAt: new Date(now).toISOString(),
      startupTokens: 50_000,
      projectPath: '/p',
    });
    expect(notice).toBeNull();
  });

  it('stays silent on growth under both the absolute and relative floor', () => {
    const now = Date.now();
    const history: StartupWatchEntry[] = [
      { takenAt: new Date(now - 2 * DAY_MS).toISOString(), startupTokens: 20_000 },
    ];
    // +200 tokens is the exact number the issue calls out as noise.
    const notice = evaluateStartupGrowth(history, {
      takenAt: new Date(now).toISOString(),
      startupTokens: 20_200,
      projectPath: '/p',
    });
    expect(notice).toBeNull();
  });

  it('never fires on shrinkage', () => {
    const now = Date.now();
    const history: StartupWatchEntry[] = [
      { takenAt: new Date(now - 2 * DAY_MS).toISOString(), startupTokens: 30_000 },
    ];
    const notice = evaluateStartupGrowth(history, {
      takenAt: new Date(now).toISOString(),
      startupTokens: 10_000,
      projectPath: '/p',
    });
    expect(notice).toBeNull();
  });

  it('fires with exactly one number and one action once growth clears the floor', () => {
    const now = Date.now();
    const history: StartupWatchEntry[] = [
      { takenAt: new Date(now - 12 * DAY_MS).toISOString(), startupTokens: 18_000 },
    ];
    const notice = evaluateStartupGrowth(history, {
      takenAt: new Date(now).toISOString(),
      startupTokens: 22_300,
      projectPath: '/p',
    });
    expect(notice).not.toBeNull();
    expect(notice?.deltaTokens).toBe(4300);
    expect(notice?.previousTokens).toBe(18_000);
    expect(notice?.currentTokens).toBe(22_300);
    expect(notice?.sinceDays).toBe(12);
    // Exactly one number in the message, and exactly one action.
    const numbers = notice?.message.match(/[\d,]+/g) ?? [];
    expect(numbers).toEqual(['4,300']);
    expect(notice?.message).toContain('get_startup_context_audit');
  });

  it('catches slow creep against the oldest in-window baseline, not the last sample', () => {
    // Three small steps, each under threshold on its own, but the total
    // since the oldest in-window snapshot clears it.
    const now = Date.now();
    const history: StartupWatchEntry[] = [
      { takenAt: new Date(now - 10 * DAY_MS).toISOString(), startupTokens: 20_000 },
      { takenAt: new Date(now - 6 * DAY_MS).toISOString(), startupTokens: 20_500 },
      { takenAt: new Date(now - 2 * DAY_MS).toISOString(), startupTokens: 21_000 },
    ];
    const notice = evaluateStartupGrowth(history, {
      takenAt: new Date(now).toISOString(),
      startupTokens: 22_500,
      projectPath: '/p',
    });
    expect(notice?.deltaTokens).toBe(2500);
    expect(notice?.previousTokens).toBe(20_000);
  });
});

// --- Integration: sampleLatestStartup + checkStartupWatch against real
// (fixture) session logs, the way the wake-up CLI actually calls this. ---

function usage(over: Record<string, unknown> = {}) {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 50,
    ...over,
  };
}

/** One minimal fresh session: a single first API call sized `startupTokens`. */
function writeSessionFile(filePath: string, startupTokens: number, timestamp: string): void {
  const lines: unknown[] = [
    {
      type: 'assistant',
      timestamp,
      message: {
        id: 'm1',
        model: 'claude-x',
        usage: usage({ cache_creation_input_tokens: startupTokens }),
        content: [],
      },
    },
    // Padding past MIN_SESSION_BYTES (20_000) — lines the scanner skips.
    ...Array.from({ length: 40 }, () => ({ type: 'noise', pad: 'x'.repeat(4000) })),
  ];
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'));
}

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-watch-'));
  statePath = path.join(dir, 'startup-watch.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sampleLatestStartup', () => {
  it('returns the most recent fresh session, not the largest or oldest', () => {
    const older = path.join(dir, 'older.jsonl');
    const newer = path.join(dir, 'newer.jsonl');
    writeSessionFile(older, 15_000, '2026-01-01T00:00:00Z');
    writeSessionFile(newer, 25_000, '2026-01-02T00:00:00Z');

    const listSessions = () => [
      { filePath: older, projectPath: '/p', client: 'claude-code' as const, mtime: 1000 },
      { filePath: newer, projectPath: '/p', client: 'claude-code' as const, mtime: 2000 },
    ];

    return sampleLatestStartup({ listSessions }).then((sample) => {
      expect(sample?.startupTokens).toBe(25_000);
    });
  });

  it('returns null when no session has a measurable first call', () => {
    return sampleLatestStartup({ listSessions: () => [] }).then((sample) => {
      expect(sample).toBeNull();
    });
  });
});

describe('checkStartupWatch (end-to-end)', () => {
  it('is silent on the first check and records a baseline', async () => {
    const file = path.join(dir, 's1.jsonl');
    writeSessionFile(file, 18_000, '2026-01-01T00:00:00Z');
    const listSessions = () => [
      { filePath: file, projectPath: '/p', client: 'claude-code' as const, mtime: 1 },
    ];

    const notice = await checkStartupWatch({ listSessions, statePath, projectRoot: '/p' });
    expect(notice).toBeNull();
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it('stays silent on a second check with no real growth', async () => {
    const file1 = path.join(dir, 's1.jsonl');
    writeSessionFile(file1, 18_000, '2026-01-01T00:00:00Z');
    await checkStartupWatch({
      listSessions: () => [
        { filePath: file1, projectPath: '/p', client: 'claude-code' as const, mtime: 1 },
      ],
      statePath,
      projectRoot: '/p',
    });

    const file2 = path.join(dir, 's2.jsonl');
    writeSessionFile(file2, 18_150, '2026-01-02T00:00:00Z');
    const notice = await checkStartupWatch({
      listSessions: () => [
        { filePath: file1, projectPath: '/p', client: 'claude-code' as const, mtime: 1 },
        { filePath: file2, projectPath: '/p', client: 'claude-code' as const, mtime: 2 },
      ],
      statePath,
      projectRoot: '/p',
    });
    expect(notice).toBeNull();
  });

  it('reports the correct delta after a CLAUDE.md-sized growth', async () => {
    const file1 = path.join(dir, 's1.jsonl');
    writeSessionFile(file1, 18_000, '2026-01-01T00:00:00Z');
    await checkStartupWatch({
      listSessions: () => [
        { filePath: file1, projectPath: '/p', client: 'claude-code' as const, mtime: 1 },
      ],
      statePath,
      projectRoot: '/p',
    });

    // A file grown well past both the absolute and relative floor.
    const file2 = path.join(dir, 's2.jsonl');
    writeSessionFile(file2, 24_000, '2026-01-05T00:00:00Z');
    const notice = await checkStartupWatch({
      listSessions: () => [
        { filePath: file1, projectPath: '/p', client: 'claude-code' as const, mtime: 1 },
        { filePath: file2, projectPath: '/p', client: 'claude-code' as const, mtime: 2 },
      ],
      statePath,
      projectRoot: '/p',
    });
    expect(notice?.deltaTokens).toBe(6000);
    expect(notice?.message).toBe(
      'trace-mcp: startup block grew by +6,000 tokens. Run get_startup_context_audit for details.',
    );
  });

  it('keeps separate history per project so switching projects is not "growth"', async () => {
    const fileA = path.join(dir, 'a.jsonl');
    writeSessionFile(fileA, 15_000, '2026-01-01T00:00:00Z');
    await checkStartupWatch({
      listSessions: () => [
        { filePath: fileA, projectPath: '/project-a', client: 'claude-code' as const, mtime: 1 },
      ],
      statePath,
      projectRoot: '/project-a',
    });

    // A much bigger, unrelated project's first-ever sample — must not be
    // compared against project A's baseline.
    const fileB = path.join(dir, 'b.jsonl');
    writeSessionFile(fileB, 60_000, '2026-01-01T00:00:00Z');
    const notice = await checkStartupWatch({
      listSessions: () => [
        { filePath: fileB, projectPath: '/project-b', client: 'claude-code' as const, mtime: 1 },
      ],
      statePath,
      projectRoot: '/project-b',
    });
    expect(notice).toBeNull();
  });
});
