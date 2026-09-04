/**
 * TRA-770: the startup-text compressor proposes deletions from the user's own
 * instruction files when another source in the same startup block already
 * delivers the same instruction.
 *
 * The second half of this file is the review of PR #845. Both reviewers
 * independently reproduced deletions of text nothing else said, all of them
 * through the same hole: a rule that held for *most* of a line, checked with
 * `.some()`. Each of those reproductions is a test here, because the invariant
 * is the product — a compressor that deletes an instruction the agent then
 * stops following costs its user far more than the tokens it saved.
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
  'Run test suites in parallel on macOS systems whenever the suite supports it.',
  'Always validate production database migrations against a recent verified backup before every deployment.',
  'Run database migrations using pnpm migrate before deploying anything to production.',
  'Require Node 22 for all scripts in this repository.',
].join('\n');

const HOOK_TEXT = `Deployment reminder: run the migration before the release.\n${'x'.repeat(400)}`;
const SKILL_LISTING = '- some-skill: a description written by somebody else entirely, at length.';

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
  // Nothing else in the block says this, so it survives — and its heading with it.
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
  /* An assistant record with NO `usage` block. It still closes the startup
     block — the first version pre-filtered on `"usage"`, never reached the
     boundary check, and swallowed every later attachment as startup evidence. */
  { type: 'assistant', timestamp: '2026-09-01T10:00:00Z', message: { id: 'm1', content: [] } },
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

/** A one-file project with its own log, for the reproduction cases. */
async function analyseFixture(claudeMd: string, corpusText = SERVER_INSTRUCTIONS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-startup-case-'));
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-startup-caselog-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
  fs.writeFileSync(
    path.join(logs, 's.jsonl'),
    session([
      {
        type: 'attachment',
        attachment: {
          type: 'mcp_instructions_delta',
          addedNames: ['trace-mcp'],
          addedBlocks: [corpusText],
        },
      },
    ]),
  );
  const result = await analyzeStartupText({
    projectRoot: dir,
    listSessions: () => [
      {
        filePath: path.join(logs, 's.jsonl'),
        projectPath: dir,
        client: 'claude-code' as const,
        mtime: Date.now(),
      },
    ],
  });
  const cut = (result.candidates[0]?.diff ?? '')
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .join('\n');
  return {
    result,
    cut,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(logs, { recursive: true, force: true });
    },
  };
}

describe('startup corpus', () => {
  it("reads one session's startup texts and stops at the first assistant record", async () => {
    const corpus = await collectStartupCorpus(listSessions, projectDir);
    const sources = (corpus?.entries ?? []).map((e) => e.source).sort();

    expect(sources).toEqual(['hook:release-notes', 'mcp:trace-mcp', 'skills']);
    // The boundary holds even though that assistant record carries no `usage`.
    expect(sources).not.toContain('hook:mid-session');
    expect(corpus?.sessionPath).toContain('session.jsonl');
  });
});

describe('startup text compression', () => {
  it("finds a rule restated in the user's own words, though no line is a copy", async () => {
    const result = await run();
    const candidate = result.candidates.find((c) => c.path.endsWith('CLAUDE.md'));

    expect(candidate).toBeDefined();
    expect(candidate?.savedTokens).toBeGreaterThan(0);
    const serverLines = new Set(SERVER_INSTRUCTIONS.split('\n').map((l) => l.trim()));
    for (const line of USER_CLAUDE_MD.split('\n')) {
      expect(serverLines.has(line.trim())).toBe(false);
    }

    const cut = (candidate?.diff ?? '')
      .split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .join('\n');
    expect(cut).toContain('Never report "done"');
    expect(cut).toContain('Skip openers');
    /* The "Rewrite vague asks" line is NOT removed, and that is the safe
       direction: the server states the same rule in a longer sentence that
       also carries an example, so symmetric overlap falls below the bar. A
       match rule loose enough to catch it is loose enough to catch a sentence
       that merely shares a topic. Proposing less is the correct failure. */
    expect(cut).not.toContain('Rewrite vague asks');
  });

  it('leaves alone the text nothing else in the block says', async () => {
    const result = await run();
    const candidate = result.candidates.find((c) => c.path.endsWith('CLAUDE.md'));

    expect(candidate?.diff).not.toContain('-The release branch is cut on Thursdays');
    expect(candidate?.diff).not.toContain('-Run `pnpm build`');
    expect(candidate?.diff).not.toContain('-## Build and test');
  });

  it('keeps the invariant, citing a source per sentence', async () => {
    const result = await run();
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(() => assertInvariant(result)).not.toThrow();
    for (const candidate of result.candidates) {
      for (const removal of candidate.removals) {
        if (removal.rule === 'emptiedHeading') continue;
        expect(removal.evidence.length).toBeGreaterThan(0);
        for (const e of removal.evidence) {
          expect(e.saidBy).toBeTruthy();
          expect(e.saidAs).toBeTruthy();
        }
      }
    }
  });

  it('drops a heading only when its whole body has gone', async () => {
    const result = await run();
    const diff = result.candidates.find((c) => c.path.endsWith('CLAUDE.md'))?.diff ?? '';

    expect(diff).toContain('-### No flattery, no filler');
    // This section keeps a line the server never sent, so its heading stays.
    expect(diff).not.toContain('-### Goal-driven execution');
  });

  it('proposes a diff and a delta, and writes nothing', async () => {
    const before = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    const result = await run();
    const candidate = result.candidates[0];

    expect(candidate.diff).toContain('(proposed)');
    // Deletions only: a compressor that adds a line has reworded something.
    expect(candidate.diff.split('\n').some((l) => /^\+[^+]/.test(l))).toBe(false);
    expect(candidate.currentTokens - candidate.compressedTokens).toBe(candidate.savedTokens);
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
  });

  it('names the session its evidence came from', async () => {
    const result = await run();
    expect(result.evidenceFrom).toContain('session.jsonl');
  });

  it('proposes nothing when there is no startup block to prove duplication against', async () => {
    const result = await analyzeStartupText({ projectRoot: projectDir, listSessions: () => [] });

    expect(result.candidates).toEqual([]);
    expect(result.totalSavedTokens).toBe(0);
    expect(result.notes.join(' ')).toContain('no proposal');
  });
});

/**
 * Every case below deleted text nothing else said, in the first implementation.
 * They are the review of PR #845, turned into the regression suite.
 */
describe('invariant: nothing goes unless the block still says it', () => {
  it('keeps a line whose second sentence is said nowhere (no fractional deletion)', async () => {
    const { result, cut, cleanup } = await analyseFixture(
      [
        '# Guide',
        '',
        'Always validate production database migrations against a recent verified backup before every deployment. Never deploy on Fridays.',
        '',
      ].join('\n'),
    );
    try {
      // The first sentence IS in the corpus and covers most of the line; the
      // Friday rule is not, so the line must stay whole.
      expect(cut).not.toContain('Never deploy on Fridays');
      expect(cut).not.toContain('Always validate production database migrations');
      expect(result.totalSavedTokens).toBe(0);
      expect(() => assertInvariant(result)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('keeps short instructions inside a section whose long lines are restated', async () => {
    const { result, cut, cleanup } = await analyseFixture(
      [
        '### Database Setup',
        'Run database migrations using pnpm migrate before deploying anything to production.',
        'Never push to main.',
        'Always backup prod.',
        '',
      ].join('\n'),
    );
    try {
      expect(cut).not.toContain('Never push to main');
      expect(cut).not.toContain('Always backup prod');
      // The heading stays too: its body is not empty.
      expect(cut).not.toContain('### Database Setup');
      expect(() => assertInvariant(result)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('never deletes a prohibition on the evidence of its opposite', async () => {
    const { result, cut, cleanup } = await analyseFixture(
      ['# Guide', '', 'Do not run test suites in parallel on macOS systems.', ''].join('\n'),
    );
    try {
      // The corpus says to DO this. Sharing every content word is not consent.
      expect(cut).not.toContain('Do not run test suites in parallel');
      expect(result.totalSavedTokens).toBe(0);
      expect(() => assertInvariant(result)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('does not treat a different version number as the same instruction', async () => {
    const { result, cut, cleanup } = await analyseFixture(
      ['# Guide', '', 'Require Node 18 for all scripts in this repository.', ''].join('\n'),
    );
    try {
      // The corpus requires Node 22. Dropping short tokens made these identical.
      expect(cut).not.toContain('Require Node 18');
      expect(result.totalSavedTokens).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("does not use another project's startup block as evidence", async () => {
    const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-startup-b-'));
    fs.writeFileSync(
      path.join(projectB, 'CLAUDE.md'),
      [
        '# B',
        '',
        'Never report "done" based on a plausible-looking diff. Run the test/build/typecheck.',
        '',
      ].join('\n'),
    );
    try {
      // Discovery is called WITH the project root; a listSessions that honours
      // it — as the real one does — returns nothing for a project with no logs.
      const result = await analyzeStartupText({
        projectRoot: projectB,
        listSessions: (root?: string) => (root === projectB ? [] : listSessions()),
      });
      expect(result.candidates).toEqual([]);
      expect(result.totalSavedTokens).toBe(0);
    } finally {
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  });

  it('cites the right source for each line when neighbours came from different ones', async () => {
    const { result, cleanup } = await analyseFixture(
      [
        '# Guide',
        '',
        'Never report "done" based on a plausible-looking diff. Run the test/build/typecheck. Plausibility is not correctness.',
        'Deployment reminder: run the migration before the release.',
        '',
      ].join('\n'),
      `${SERVER_INSTRUCTIONS}`,
    );
    try {
      const removals = result.candidates[0]?.removals ?? [];
      // One removal per line: a group labelled by its strongest member quoted
      // evidence that did not support the other lines in it.
      for (const removal of removals) {
        expect(typeof removal.line).toBe('number');
      }
      expect(() => assertInvariant(result)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('keeps the diff and savedTokens describing the same file', async () => {
    const result = await run();
    for (const candidate of result.candidates) {
      const original = fs.readFileSync(candidate.path, 'utf8').split('\n');
      const removedLines = new Set(
        candidate.diff
          .split('\n')
          .filter((l) => l.startsWith('-') && !l.startsWith('---'))
          .map((l) => l.slice(1)),
      );
      const applied = original.filter((l) => !removedLines.has(l)).join('\n');
      // Applying the diff must land within rounding of the quoted number.
      expect(
        Math.abs(Math.round(applied.length / 4) - candidate.compressedTokens),
      ).toBeLessThanOrEqual(2);
    }
  });
});
