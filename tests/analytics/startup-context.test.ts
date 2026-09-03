/**
 * TRA-759: the startup-context audit reads real session logs, so the fixture
 * here IS a session log — a hand-written JSONL with the shapes the harness
 * actually writes (verified against ~/.claude/projects during TRA-726).
 *
 * What must hold, and what breaks if it does not:
 *  - the itemised rows plus the residual equal the measured block; a
 *    decomposition whose parts do not sum is a wrong answer that looks right;
 *  - the user's own first message is NOT startup — counting it would inflate
 *    every long task's block;
 *  - a mid-session cache rebuild is attributed to what caused it, and a gap
 *    longer than the cache TTL outranks anything the session did.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeStartupContext, splitSkillListing } from '../../src/analytics/startup-context.js';

const HOOK_TEXT = 'x'.repeat(4000); // 1000 tokens
/* Two skills, one used and one not. The listing's real shape is
   `- <name>: <description>` lines, which is what makes per-skill pricing —
   and therefore a per-skill suggestion — possible at all. */
const SKILL_TEXT = [`- used-skill: ${'y'.repeat(1000)}`, `- idle-skill: ${'y'.repeat(996)}`].join(
  '\n',
); // ~500 tokens total
const TASK_TEXT = 'z'.repeat(800); // 200 tokens, and NOT part of startup

function usage(over: Record<string, unknown> = {}) {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 50,
    ...over,
  };
}

function assistant(id: string, u: Record<string, unknown>, timestamp: string, model = 'claude-x') {
  return { type: 'assistant', timestamp, message: { id, model, usage: usage(u), content: [] } };
}

/** ctx of the first call = 40_000; startup = 40_000 - 200 (task text) = 39_800. */
const LINES: unknown[] = [
  {
    type: 'attachment',
    attachment: { type: 'hook_success', hookName: 'superpowers', stdout: HOOK_TEXT },
  },
  { type: 'attachment', attachment: { type: 'skill_listing', content: SKILL_TEXT } },
  {
    type: 'attachment',
    attachment: {
      type: 'mcp_instructions_delta',
      addedNames: ['trace-mcp', 'idle-server'],
      addedBlocks: ['t'.repeat(400), 'i'.repeat(800)],
    },
  },
  { type: 'user', message: { content: [{ type: 'text', text: TASK_TEXT }] } },
  assistant('m1', { cache_creation_input_tokens: 40_000 }, '2026-09-01T10:00:00Z'),
  // A tool call to an MCP server that WAS announced at startup.
  {
    type: 'assistant',
    timestamp: '2026-09-01T10:01:00Z',
    message: {
      id: 'm2',
      model: 'claude-x',
      usage: usage({ cache_read_input_tokens: 40_000, input_tokens: 100 }),
      content: [
        { type: 'tool_use', name: 'mcp__trace-mcp__search' },
        { type: 'tool_use', name: 'Skill', input: { skill: 'used-skill' } },
      ],
    },
  },
  // A rebuild two hours later: the cache TTL explains it, nothing else.
  assistant('m3', { cache_creation_input_tokens: 45_000 }, '2026-09-01T12:05:00Z'),
  // A rebuild right after the tool surface changed.
  { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedLines: ['a'] } },
  assistant('m4', { cache_creation_input_tokens: 30_000 }, '2026-09-01T12:06:00Z'),
];

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-startup-'));
  const file = path.join(dir, 'session.jsonl');
  // Pad past the MIN_SESSION_BYTES floor with lines the scanner skips.
  const padding = Array.from({ length: 40 }, () =>
    JSON.stringify({ type: 'noise', pad: HOOK_TEXT }),
  );
  fs.writeFileSync(file, [...LINES.map((l) => JSON.stringify(l)), ...padding].join('\n'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/* `count` copies of the same session. Recommendations need a window wide
   enough that "never used" is evidence rather than a small sample, so the
   suggestion tests run against a corpus, not a single file. */
function run(count = 1) {
  return analyzeStartupContext({
    days: 365,
    listSessions: () =>
      Array.from({ length: count }, () => ({
        filePath: path.join(dir, 'session.jsonl'),
        projectPath: '/fixture/project',
        client: 'claude-code' as const,
        mtime: Date.now(),
      })),
  });
}

describe('analyzeStartupContext', () => {
  it('measures the block and itemises it without losing or inventing tokens', async () => {
    const audit = await run();
    expect(audit.sessions).toEqual({ scanned: 1, fresh: 1 });
    // The user's 200-token first message is excluded from the block.
    expect(audit.startupTokens.median).toBe(39_800);

    const bySource = Object.fromEntries(audit.sources.map((s) => [s.source, s.meanTokens]));
    expect(bySource['hook:superpowers']).toBe(1000);
    expect(bySource.skills).toBe(Math.round(SKILL_TEXT.length / 4));
    // The residual is exactly what the itemised rows do not account for.
    const itemised = audit.sources.filter((s) => s.itemised).reduce((n, s) => n + s.meanTokens, 0);
    expect(bySource.systemPromptToolSchemasAndInstructions).toBe(39_800 - itemised);

    const summed = audit.sources.reduce((n, s) => n + s.meanTokens, 0);
    expect(summed).toBe(39_800);
    // The residual is the one row that is a subtraction, not a measurement.
    expect(audit.sources.filter((s) => !s.itemised)).toHaveLength(1);
  });

  it('names what rebuilt the prefix and prices the rebuild', async () => {
    const audit = await run();
    const byCause = Object.fromEntries(audit.cacheBreakers.map((b) => [b.cause, b]));
    expect(byCause.ttlExpiry?.tokens).toBe(45_000);
    expect(byCause.toolsChanged?.tokens).toBe(30_000);
    // 5m write rate 3.75 minus the 0.3 a cache read would have cost, to the cent.
    expect(byCause.toolsChanged?.extraUsd).toBe(Math.round((30_000 * 3.45) / 1e4) / 100);
  });

  it('reports MCP servers present at startup alongside how often they were called', async () => {
    const audit = await run();
    expect(audit.mcpServers).toEqual([
      { server: 'trace-mcp', sessionsPresent: 1, instructionTokens: 100, toolCalls: 1 },
      { server: 'idle-server', sessionsPresent: 1, instructionTokens: 200, toolCalls: 0 },
    ]);
  });

  it('suggests only what the logs prove went unused', async () => {
    const audit = await run(25);
    const byTarget = Object.fromEntries(audit.recommendations.map((r) => [r.target, r]));

    // Listed at every start, never invoked → a suggestion, with the count that
    // backs it and a per-start token price.
    expect(byTarget['idle-skill']?.kind).toBe('unusedSkill');
    expect(byTarget['idle-skill']?.sessionsObserved).toBe(25);
    expect(byTarget['idle-skill']?.tokensPerSession).toBeGreaterThan(0);
    expect(byTarget['idle-server']?.kind).toBe('unusedMcpServer');

    // Used at least once → never suggested, however big it is.
    expect(byTarget['used-skill']).toBeUndefined();
    expect(byTarget['trace-mcp']).toBeUndefined();

    // A hook is one of the largest itemised sources here and still gets no
    // suggestion: nothing in the log proves the model ignored its output.
    expect(audit.recommendations.some((r) => r.target.includes('superpowers'))).toBe(false);

    expect(audit.observationWindow).toContain('25 fresh sessions');
  });

  it('stays silent when the window is too narrow to be evidence', async () => {
    // Same never-used skill, three sessions. "Never" over three starts is a
    // small sample, and a wrong suggestion costs more than the tokens it saves.
    expect((await run(3)).recommendations).toEqual([]);
  });

  it('attributes part of the input bill to the startup block', async () => {
    const audit = await run();
    expect(audit.cost.inputSideUsd).toBeGreaterThan(0);
    expect(audit.cost.startupUsd).toBeGreaterThan(0);
    expect(audit.cost.pctOfInputBill).toBeGreaterThan(0);
    expect(audit.cost.pctOfInputBill).toBeLessThanOrEqual(100);
  });
});

describe('splitSkillListing', () => {
  it('prices each skill by its own line, wrapped descriptions included', () => {
    const listing = [
      '- alpha: one two three',
      '  continued on the next line',
      '- beta: short',
    ].join('\n');
    const perSkill = splitSkillListing(listing);
    expect([...perSkill.keys()]).toEqual(['alpha', 'beta']);
    // alpha owns its own line plus the wrapped continuation.
    expect(perSkill.get('alpha')).toBeGreaterThan(perSkill.get('beta') as number);
  });
});
