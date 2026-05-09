import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

/**
 * Tests for the conversation miner's decision extraction logic.
 *
 * Rather than mocking the full session discovery pipeline, we test the
 * extraction engine by creating synthetic JSONL session files in a temp
 * directory and calling the extraction functions directly.
 */

// We import the internal functions we want to test by reimporting the module
// and testing via the public `mineSessions` interface with controlled input.

describe('Conversation Miner — extraction patterns', () => {
  let store: DecisionStore;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miner-test-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: write a synthetic JSONL session file with conversation turns.
   */
  function _writeSession(
    sessionDir: string,
    sessionId: string,
    turns: Array<{ role: 'user' | 'assistant'; text: string }>,
  ): string {
    fs.mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);

    const lines = turns.map((turn, i) => {
      const timestamp = new Date(Date.now() - (turns.length - i) * 60000).toISOString();
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
    return filePath;
  }

  describe('DecisionStore integration', () => {
    it('adds mined decisions and tracks session', () => {
      // Simulate what the miner does: add decisions and mark session mined
      const decisions = [
        {
          title: 'Use PostgreSQL over MySQL',
          content: 'Chose PostgreSQL because we need JSONB support.',
          type: 'tech_choice' as const,
          project_root: '/test/project',
          tags: ['database'],
          source: 'mined' as const,
          confidence: 0.85,
          session_id: 'test-session-1',
        },
        {
          title: 'Root cause: missing null check',
          content: 'The bug was a missing null check in the auth middleware causing crashes.',
          type: 'bug_root_cause' as const,
          project_root: '/test/project',
          tags: ['auth'],
          source: 'mined' as const,
          confidence: 0.8,
          session_id: 'test-session-1',
        },
      ];

      const count = store.addDecisions(decisions);
      expect(count).toBe(2);
      store.markSessionMined('/fake/session.jsonl', 2);

      expect(store.isSessionMined('/fake/session.jsonl')).toBe(true);
      expect(store.getMinedSessionCount()).toBe(1);

      const results = store.queryDecisions({ project_root: '/test/project' });
      expect(results.length).toBe(2);
      expect(results.some((d) => d.type === 'tech_choice')).toBe(true);
      expect(results.some((d) => d.type === 'bug_root_cause')).toBe(true);
    });

    it('full-text search finds mined decisions', () => {
      store.addDecision({
        title: 'Switched from REST to GraphQL',
        content:
          'We decided to switch to GraphQL because the frontend team needed more flexible queries and we were over-fetching data with REST endpoints.',
        type: 'architecture_decision',
        project_root: '/test/project',
        tags: ['api', 'graphql'],
        source: 'mined',
        confidence: 0.9,
      });

      store.addDecision({
        title: 'Use Redis for session cache',
        content:
          'Going with Redis for session storage because of its TTL support and pub/sub capabilities.',
        type: 'tech_choice',
        project_root: '/test/project',
        tags: ['cache', 'session'],
        source: 'mined',
        confidence: 0.85,
      });

      const graphqlResults = store.queryDecisions({
        project_root: '/test/project',
        search: 'GraphQL REST',
      });
      expect(graphqlResults.length).toBeGreaterThanOrEqual(1);
      expect(graphqlResults[0].title).toContain('GraphQL');

      const redisResults = store.queryDecisions({
        project_root: '/test/project',
        search: 'Redis session',
      });
      expect(redisResults.length).toBeGreaterThanOrEqual(1);
      expect(redisResults[0].title).toContain('Redis');
    });

    it('code-aware linkage works for mined decisions', () => {
      store.addDecision({
        title: 'Auth provider uses Clerk',
        content: 'Decided to use Clerk for authentication because of better DX and pricing.',
        type: 'tech_choice',
        project_root: '/test/project',
        symbol_id: 'src/auth/provider.ts::AuthProvider#class',
        file_path: 'src/auth/provider.ts',
        source: 'mined',
        confidence: 0.85,
      });

      const bySymbol = store.getDecisionsForSymbol('src/auth/provider.ts::AuthProvider#class');
      expect(bySymbol.length).toBe(1);
      expect(bySymbol[0].title).toBe('Auth provider uses Clerk');

      const byFile = store.getDecisionsForFile('src/auth/provider.ts');
      expect(byFile.length).toBe(1);
    });

    it('temporal validity filters correctly', () => {
      store.addDecision({
        title: 'Use MySQL (old)',
        content: 'Original database choice.',
        type: 'tech_choice',
        project_root: '/test/project',
        valid_from: '2025-01-01T00:00:00Z',
        source: 'mined',
        confidence: 0.9,
      });
      const d1 = store.queryDecisions({ project_root: '/test/project' })[0];
      store.invalidateDecision(d1.id, '2025-06-01T00:00:00Z');

      store.addDecision({
        title: 'Use PostgreSQL (new)',
        content: 'Migrated to PostgreSQL.',
        type: 'tech_choice',
        project_root: '/test/project',
        valid_from: '2025-06-01T00:00:00Z',
        source: 'mined',
        confidence: 0.9,
      });

      // Active only: should return only PostgreSQL
      const active = store.queryDecisions({ project_root: '/test/project' });
      expect(active.length).toBe(1);
      expect(active[0].title).toContain('PostgreSQL');

      // As of January 2025: MySQL should be active
      const jan = store.queryDecisions({
        project_root: '/test/project',
        as_of: '2025-03-01T00:00:00Z',
      });
      expect(jan.length).toBe(1);
      expect(jan[0].title).toContain('MySQL');

      // As of July 2025: only PostgreSQL (MySQL invalidated)
      const jul = store.queryDecisions({
        project_root: '/test/project',
        as_of: '2025-07-01T00:00:00Z',
      });
      expect(jul.length).toBe(1);
      expect(jul[0].title).toContain('PostgreSQL');

      // Include all: both
      const all = store.queryDecisions({
        project_root: '/test/project',
        include_invalidated: true,
      });
      expect(all.length).toBe(2);
    });
  });
});

describe('Conversation Miner — privacy filtering', () => {
  it('strips <private> blocks before mining', async () => {
    const { stripPrivacyTags } = await import('../../src/memory/conversation-miner.js');
    const input = 'visible <private>password=hunter2</private> tail';
    expect(stripPrivacyTags(input)).toBe('visible  tail');
  });

  it('strips <persisted-output> blocks (Claude Code captured tool output)', async () => {
    const { stripPrivacyTags } = await import('../../src/memory/conversation-miner.js');
    const input = 'before <persisted-output>...100KB of file body...</persisted-output> after';
    expect(stripPrivacyTags(input)).toBe('before  after');
  });

  it('strips <system-reminder> blocks', async () => {
    const { stripPrivacyTags } = await import('../../src/memory/conversation-miner.js');
    const input = 'note <system-reminder>TodoWrite has not been used</system-reminder> end';
    expect(stripPrivacyTags(input)).toBe('note  end');
  });

  it('strips <task-notification> autonomous protocol payloads', async () => {
    const { stripPrivacyTags } = await import('../../src/memory/conversation-miner.js');
    const input = 'a <task-notification>{"agent":"Explore","status":"done"}</task-notification> b';
    expect(stripPrivacyTags(input)).toBe('a  b');
  });

  it('strips <ide_selection> echoes', async () => {
    const { stripPrivacyTags } = await import('../../src/memory/conversation-miner.js');
    const input = 'pre <ide_selection>secret_key = "abc"</ide_selection> post';
    expect(stripPrivacyTags(input)).toBe('pre  post');
  });

  it('strips <local-command-stdout> blocks', async () => {
    const { stripPrivacyTags } = await import('../../src/memory/conversation-miner.js');
    const input = '<local-command-stdout>API_TOKEN=secret\n</local-command-stdout>';
    expect(stripPrivacyTags(input)).toBe('');
  });

  it('keeps <command-message> and <command-name> (real user slash-commands)', async () => {
    const { stripPrivacyTags } = await import('../../src/memory/conversation-miner.js');
    const input = '<command-name>/loop</command-name> body <command-message>5m</command-message>';
    expect(stripPrivacyTags(input)).toBe(input);
  });

  it('handles multiple privacy tags in one message', async () => {
    const { stripPrivacyTags } = await import('../../src/memory/conversation-miner.js');
    const input = '<private>a</private> middle <system-reminder>b</system-reminder>';
    expect(stripPrivacyTags(input)).toBe(' middle ');
  });

  it('does not regex-bomb on >256 KiB payloads', async () => {
    const { stripPrivacyTags } = await import('../../src/memory/conversation-miner.js');
    const huge = `<persisted-output>${'x'.repeat(300_000)}</persisted-output>`;
    const start = Date.now();
    const out = stripPrivacyTags(huge);
    expect(Date.now() - start).toBeLessThan(200);
    expect(out).toBe('');
  });

  it('detects internal-protocol-only payloads', async () => {
    const { isInternalProtocolPayload } = await import('../../src/memory/conversation-miner.js');
    expect(isInternalProtocolPayload('<system-reminder>x</system-reminder>')).toBe(true);
    expect(
      isInternalProtocolPayload(
        '<task-notification>foo</task-notification>\n  <system-reminder>bar</system-reminder>',
      ),
    ).toBe(true);
    expect(isInternalProtocolPayload('real user content')).toBe(false);
    expect(isInternalProtocolPayload('user wrote this <private>x</private>')).toBe(false);
    expect(isInternalProtocolPayload('')).toBe(false);
  });

  it('handles empty and missing input gracefully', async () => {
    const { stripPrivacyTags } = await import('../../src/memory/conversation-miner.js');
    expect(stripPrivacyTags('')).toBe('');
    expect(stripPrivacyTags('plain text')).toBe('plain text');
  });

  it('is case-insensitive on tag names', async () => {
    const { stripPrivacyTags } = await import('../../src/memory/conversation-miner.js');
    const input = '<Private>secret</Private> <SYSTEM-REMINDER>x</SYSTEM-REMINDER>';
    expect(stripPrivacyTags(input)).toBe(' ');
  });
});

describe('Conversation Miner — worktree adoption', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-adopt-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the path unchanged when not a linked worktree', async () => {
    const { adoptWorktreeRoot } = await import('../../src/memory/conversation-miner.js');
    const cache = new Map<string, string>();
    const root = path.join(tmpDir, 'plain-project');
    fs.mkdirSync(root);
    expect(adoptWorktreeRoot(root, cache)).toBe(root);
  });

  it('returns the path unchanged when the directory does not exist', async () => {
    const { adoptWorktreeRoot } = await import('../../src/memory/conversation-miner.js');
    const cache = new Map<string, string>();
    const ghost = path.join(tmpDir, 'no-such');
    expect(adoptWorktreeRoot(ghost, cache)).toBe(ghost);
  });

  it('returns parent main root when the path is a linked worktree', async () => {
    const { adoptWorktreeRoot } = await import('../../src/memory/conversation-miner.js');
    const cache = new Map<string, string>();

    // Build a fake linked-worktree layout:
    //   tmpDir/main/.git/worktrees/feat-x/
    //   tmpDir/main/.git/worktrees/feat-x/commondir   → "../.."  (relative)
    //   tmpDir/wt-feat-x/.git                          → file: "gitdir: <admin>"
    const main = path.join(tmpDir, 'main');
    const mainGit = path.join(main, '.git');
    const adminDir = path.join(mainGit, 'worktrees', 'feat-x');
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, 'commondir'), '../..\n');
    // Bare HEAD/refs files some `git rev-parse` paths probe — not strictly
    // required by `detectGitWorktree`, but harmless and realistic.
    fs.writeFileSync(path.join(mainGit, 'HEAD'), 'ref: refs/heads/main\n');

    const wt = path.join(tmpDir, 'wt-feat-x');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${adminDir}\n`);
    // detectGitWorktree validates that the resolved main root has a real
    // .git *directory*; the dir was already created above.

    const adopted = adoptWorktreeRoot(wt, cache);
    expect(adopted).toBe(main);
  });

  it('caches results for the same path', async () => {
    const { adoptWorktreeRoot } = await import('../../src/memory/conversation-miner.js');
    const cache = new Map<string, string>();
    const root = path.join(tmpDir, 'cached');
    fs.mkdirSync(root);
    adoptWorktreeRoot(root, cache);
    expect(cache.has(root)).toBe(true);
    // Second call must read from cache, not re-stat (we can't easily prove
    // no fs read, but at least result is stable).
    expect(adoptWorktreeRoot(root, cache)).toBe(root);
  });
});
