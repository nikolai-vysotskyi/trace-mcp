/**
 * TRA-770: the startup-text compressor proposes deletions from the user's own
 * instruction files when another startup source already delivers the same
 * instruction.
 *
 * What must hold, and what breaks if it does not:
 *  - a rule the user restated in their own words is found even though the two
 *    wordings share no exact line; matching on exact text finds nothing, which
 *    is what the first measurement of this feature showed;
 *  - text that is NOT said elsewhere is never proposed for removal — a false
 *    positive here deletes an instruction the agent then stops following, which
 *    costs far more than the tokens it saves;
 *  - the invariant holds over the whole result: every removal names a source
 *    that still says the same thing;
 *  - a heading is never removed on its own evidence, only when its whole body
 *    has gone — otherwise the body it introduced ends up under the heading
 *    above it, which changes what the file says without removing a word of it;
 *  - the corpus is read from real session-log shapes, and third-party text is
 *    reported as untouchable rather than rewritten.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyzeStartupText,
  assertInvariant,
  collectStartupCorpus,
} from '../../src/analytics/startup-text.js';

/** What an MCP server sends at startup — the text the user then restated. */
const SERVER_INSTRUCTIONS = [
  'Agent Behavior (applies to all tasks, not just code exploration):',
  '- Never report "done" based on a plausible-looking diff. Run the test/build/typecheck. Plausibility is not correctness.',
  '- Rewrite vague asks into verifiable goals before coding: "Fix the bug" → write a failing test reproducing the symptom, then fix.',
  '- No flattery, no filler. Skip openers like "Great question", "Excellent idea". Start with the answer or the action.',
].join('\n');

const HOOK_TEXT = `Deployment reminder: run the migration before the release.\n${'x'.repeat(400)}`;
const SKILL_LISTING = '- some-skill: a description written by somebody else entirely, at length.';

/**
 * The user's own file. The first three rules restate the server's, in the
 * user's own words — no line is a copy. The last section is theirs alone and
 * must survive.
 */
const USER_CLAUDE_MD = [
  '# Project guide',
  '',
  '## Agent behaviour',
  '',
  '### No flattery, no filler',
  'Skip openers: "Great question", "Excellent idea", "Absolutely!". Start the response with the answer or the action.',
  '',
  '### Goal-driven execution',
  'Rewrite vague asks into verifiable goals before writing code:',
  '- "Fix the bug" → "Write a failing test reproducing the symptom, make it pass."',
  // Nothing else in the block says this, so it survives — and the heading
  // above it has to survive with it.
  '- "Ship the importer" → "Load the sample CSV in benchmarks/fixtures end to end."',
  '',
  'Never report "done" based on a plausible-looking diff. Run the test/build/typecheck. Plausibility is not correctness.',
  '',
  '## Build and test',
  '',
  'Run `pnpm build` and then `pnpm test --run` against the sqlite fixture in benchmarks/fixtures.',
  'The release branch is cut on Thursdays and the changelog is generated, never hand-edited.',
  '',
].join('\n');

function session(lines: unknown[]): string {
  // Padding the scanner skips, to clear the MIN_SESSION_BYTES floor.
  const padding = Array.from({ length: 40 }, () =>
    JSON.stringify({ type: 'noise', pad: 'y'.repeat(600) }),
  );
  return [...lines.map((l) => JSON.stringify(l)), ...padding].join('\n');
}

const LOG_LINES: unknown[] = [
  {
    type: 'attachment',
    attachment: {
      type: 'mcp_instructions_delta',
      addedNames: ['trace-mcp'],
      addedBlocks: [SERVER_INSTRUCTIONS],
    },
  },
  { type: 'attachment', attachment: { type: 'skill_listing', content: SKILL_LISTING } },
  {
    type: 'attachment',
    attachment: { type: 'hook_success', hookName: 'release-notes', stdout: HOOK_TEXT },
  },
  // The first assistant call closes the startup block. An attachment after it
  // is mid-session text, not startup text, and must not enter the corpus.
  {
    type: 'assistant',
    timestamp: '2026-09-01T10:00:00Z',
    message: { id: 'm1', model: 'claude-x', usage: { cache_creation_input_tokens: 40_000 } },
  },
  {
    type: 'attachment',
    attachment: { type: 'hook_success', hookName: 'mid-session', stdout: 'z'.repeat(500) },
  },
];

let logDir: string;
let projectDir: string;

beforeAll(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-startup-text-log-'));
  fs.writeFileSync(path.join(logDir, 'session.jsonl'), session(LOG_LINES));

  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-startup-text-proj-'));
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), USER_CLAUDE_MD);
});

afterAll(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function listSessions() {
  return [
    {
      filePath: path.join(logDir, 'session.jsonl'),
      projectPath: projectDir,
      client: 'claude-code' as const,
      mtime: Date.now(),
    },
  ];
}

function run() {
  return analyzeStartupText({ projectRoot: projectDir, listSessions });
}

describe('startup corpus', () => {
  it('reads the startup texts a session actually carried, and stops at the first call', async () => {
    const { entries, sessionsRead } = await collectStartupCorpus(listSessions);
    const sources = entries.map((e) => e.source).sort();

    expect(sessionsRead).toBe(1);
    expect(sources).toEqual(['hook:release-notes', 'mcp:trace-mcp', 'skills']);
    // Mid-session output is not startup text; counting it would price text no
    // startup block ever paid for.
    expect(sources).not.toContain('hook:mid-session');
  });
});

describe('startup text compression', () => {
  it("finds a rule restated in the user's own words, though no line is a copy", async () => {
    const result = await run();
    const candidate = result.candidates.find((c) => c.path.endsWith('CLAUDE.md'));

    expect(candidate).toBeDefined();
    expect(candidate?.savedTokens).toBeGreaterThan(0);
    // Nothing here is a verbatim duplicate: exact matching would find zero.
    const claudeMd = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    const serverLines = new Set(SERVER_INSTRUCTIONS.split('\n').map((l) => l.trim()));
    for (const line of claudeMd.split('\n')) {
      expect(serverLines.has(line.trim())).toBe(false);
    }

    const cut = (candidate?.diff ?? '')
      .split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .join('\n');
    expect(cut).toContain('Never report "done"');
    expect(cut).toContain('Rewrite vague asks');
    // Every removal cites the server that still carries the rule.
    expect((candidate?.removals ?? []).every((r) => r.saidBy === 'mcp:trace-mcp')).toBe(true);
  });

  it('leaves alone the text nothing else in the block says', async () => {
    const result = await run();
    const candidate = result.candidates.find((c) => c.path.endsWith('CLAUDE.md'));
    const compressedAway = (candidate?.removals ?? []).map((r) => r.text).join(' ');

    // The project's own build and release rules exist only in this file.
    expect(compressedAway).not.toContain('pnpm build');
    expect(compressedAway).not.toContain('release branch');
    expect(candidate?.diff).not.toContain('-The release branch is cut on Thursdays');
  });

  it('keeps the invariant: every removal names a source that still says it', async () => {
    const result = await run();
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(() => assertInvariant(result)).not.toThrow();
    for (const candidate of result.candidates) {
      for (const removal of candidate.removals) {
        expect(removal.saidBy).toBeTruthy();
        expect(removal.saidAs).toBeTruthy();
      }
    }
  });

  it('drops a heading only when its whole body has gone', async () => {
    const result = await run();
    const candidate = result.candidates.find((c) => c.path.endsWith('CLAUDE.md'));
    const diff = candidate?.diff ?? '';

    // "### No flattery, no filler" has one body line and it is restatement, so
    // the heading goes with it.
    expect(diff).toContain('-### No flattery, no filler');
    // "### Goal-driven execution" keeps a body line the server never sent…
    expect(diff).not.toContain('-### Goal-driven execution');
    // …and "## Build and test" is untouched entirely.
    expect(diff).not.toContain('-## Build and test');
  });

  it('proposes a diff and a delta, and writes nothing', async () => {
    const before = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    const result = await run();
    const candidate = result.candidates[0];

    expect(candidate.diff).toContain('(proposed)');
    expect(candidate.diff.split('\n').some((l) => l.startsWith('-'))).toBe(true);
    // Deletions only: a compressor that adds a line has reworded something.
    expect(candidate.diff.split('\n').some((l) => /^\+[^+]/.test(l))).toBe(false);
    expect(candidate.currentTokens - candidate.compressedTokens).toBe(candidate.savedTokens);
    expect(result.totalSavedTokens).toBe(result.candidates.reduce((n, c) => n + c.savedTokens, 0));

    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(before);
  });

  it('reports third-party startup text as read-only, with what it costs and why', async () => {
    const result = await run();
    const sources = result.notCompressible.map((n) => n.source);

    expect(sources).toContain('skills');
    expect(sources).toContain('mcp:trace-mcp');
    expect(sources).toContain('hook:release-notes');
    for (const row of result.notCompressible) {
      expect(row.tokens).toBeGreaterThan(0);
      expect(row.reason.length).toBeGreaterThan(20);
    }
    // Nothing owned by somebody else is ever a candidate for editing.
    for (const candidate of result.candidates) {
      expect(candidate.path.startsWith(projectDir) || candidate.path.includes('.claude')).toBe(
        true,
      );
    }
  });

  it('proposes nothing when there is no corpus to prove duplication against', async () => {
    const result = await analyzeStartupText({ projectRoot: projectDir, listSessions: () => [] });

    expect(result.candidates).toEqual([]);
    expect(result.totalSavedTokens).toBe(0);
    expect(result.notes.join(' ')).toContain('no proposal');
  });
});
