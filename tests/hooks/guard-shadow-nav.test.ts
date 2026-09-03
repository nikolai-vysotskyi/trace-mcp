/**
 * scripts/guard-shadow-nav.mjs replays recorded sessions to decide whether the
 * guard v2 navigation gate fires where TRA-705 measured an advantage. Its
 * numbers are the evidence for the gate's threshold, so the replay itself has
 * to be right: these drive it over synthetic transcripts whose answers are
 * known by construction.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/guard-shadow-nav.mjs');

type Event = { kind: 'prompt' } | { kind: 'call'; name: string; input?: Record<string, unknown> };

interface Report {
  navCalls: number;
  traceCalls: number;
  crawls: number;
  crawlNavCalls: number;
  crawlFired: number;
  turnsWithNav: number;
  lightTurns: number;
  lightTurnFired: number;
  coveragePct: number;
  burstSizes: Record<string, number>;
}

describe('guard v2 shadow replay (TRA-711)', () => {
  let logsDir: string;
  let projectDir: string;
  let clock: number;

  beforeEach(() => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-shadow-'));
    projectDir = path.join(logsDir, '-tmp-project');
    fs.mkdirSync(projectDir, { recursive: true });
    clock = Date.UTC(2026, 0, 1, 12, 0, 0);
  });

  afterEach(() => {
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  /** Write one transcript. Each event is one second after the previous. */
  function writeSession(name: string, events: Event[]): void {
    const lines = events.map((e) => {
      clock += 1000;
      const timestamp = new Date(clock).toISOString();
      if (e.kind === 'prompt') {
        return JSON.stringify({ type: 'user', timestamp, message: { content: 'do a thing' } });
      }
      return JSON.stringify({
        type: 'assistant',
        timestamp,
        message: {
          content: [{ type: 'tool_use', name: e.name, input: e.input ?? {} }],
        },
      });
    });
    fs.writeFileSync(path.join(projectDir, `${name}.jsonl`), `${lines.join('\n')}\n`);
  }

  function run(extra: string[] = []): Report {
    const out = execFileSync('node', [SCRIPT, '--logs', logsDir, '--json', ...extra], {
      encoding: 'utf-8',
    });
    return JSON.parse(out) as Report;
  }

  const grep = (pattern: string): Event => ({ kind: 'call', name: 'Grep', input: { pattern } });

  it('never fires on a light turn — the TRA-705 regression case', () => {
    writeSession('light', [
      { kind: 'prompt' },
      grep('handleRequest'),
      { kind: 'call', name: 'Read', input: { file_path: '/tmp/project/src/server.ts' } },
      { kind: 'call', name: 'Edit', input: { file_path: '/tmp/project/src/server.ts' } },
    ]);

    const r = run();
    expect(r.navCalls).toBe(2);
    expect(r.turnsWithNav).toBe(1);
    expect(r.lightTurns).toBe(1);
    expect(r.lightTurnFired).toBe(0);
  });

  it('fires on every call from the third onward inside a crawl', () => {
    writeSession('crawl', [
      { kind: 'prompt' },
      ...Array.from({ length: 6 }, (_, i) => grep(`q${i}`)),
    ]);

    const r = run();
    expect(r.crawls).toBe(1);
    expect(r.crawlNavCalls).toBe(6);
    expect(r.crawlFired).toBe(4); // calls 3..6
    expect(r.coveragePct).toBeCloseTo((4 / 6) * 100, 5);
  });

  it('resets the streak on a new user prompt', () => {
    writeSession('two-turns', [
      { kind: 'prompt' },
      grep('a'),
      grep('b'),
      { kind: 'prompt' },
      grep('c'),
      grep('d'),
    ]);

    const r = run();
    expect(r.turnsWithNav).toBe(2);
    expect(r.lightTurns).toBe(2);
    expect(r.lightTurnFired).toBe(0);
  });

  it('does not count non-code and already-routed calls as navigation', () => {
    writeSession('mixed', [
      { kind: 'prompt' },
      { kind: 'call', name: 'Read', input: { file_path: '/tmp/project/README.md' } },
      { kind: 'call', name: 'Grep', input: { pattern: 'x', type: 'md' } },
      { kind: 'call', name: 'Bash', input: { command: 'pnpm run build' } },
      { kind: 'call', name: 'mcp__trace-mcp__search', input: { query: 'x' } },
      {
        kind: 'call',
        name: 'Read',
        input: { file_path: '/tmp/project/src/a.ts', offset: 10, limit: 20 },
      },
    ]);

    const r = run();
    expect(r.navCalls).toBe(0);
    expect(r.traceCalls).toBe(1);
  });

  it('breaks a burst on real work but keeps the session streak, and buckets sizes', () => {
    writeSession('burst', [
      { kind: 'prompt' },
      grep('a'),
      grep('b'),
      { kind: 'call', name: 'Edit', input: { file_path: '/tmp/project/src/a.ts' } },
      grep('c'),
    ]);

    const r = run();
    // Two bursts (2 calls, then 1) — the Edit split them...
    expect(r.burstSizes).toEqual({ 1: 1, 2: 1 });
    // ...but the turn saw three navigation calls, so it is not a light turn.
    expect(r.navCalls).toBe(3);
    expect(r.lightTurns).toBe(0);
  });
});
