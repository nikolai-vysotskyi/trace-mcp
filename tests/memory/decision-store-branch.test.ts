/**
 * Branch-aware decision memory — schema migration, capture, and read-filter tests.
 *
 * Covers:
 *   - Additive schema migration (column + indices, idempotent, backfill = NULL)
 *   - getCurrentBranch() against a real temporary git repo (clean branch,
 *     detached HEAD, and non-git directory)
 *   - queryDecisions() git_branch filter — three modes (current, all, <name>)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionInput } from '../../src/memory/decision-store.js';
import { DecisionStore } from '../../src/memory/decision-store.js';
import { getCurrentBranch } from '../../src/utils/git-branch.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      // Avoid host config bleeding into the test fixture.
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'trace-mcp tests',
      GIT_AUTHOR_EMAIL: 'tests@trace-mcp.local',
      GIT_COMMITTER_NAME: 'trace-mcp tests',
      GIT_COMMITTER_EMAIL: 'tests@trace-mcp.local',
    },
  });
}

function makeRepo(branch: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-branch-repo-'));
  // -b lets us avoid relying on the host's init.defaultBranch.
  git(dir, ['init', '-b', branch]);
  // Need at least one commit for HEAD to be a real ref (not unborn).
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

// ─── 1. Schema migration ─────────────────────────────────────────────────

describe('schema migration: git_branch column', () => {
  let dbPath: string;
  let store: DecisionStore | null;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-branch-db-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = null;
  });

  afterEach(() => {
    if (store) store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('creates the git_branch column on a fresh DB', () => {
    store = new DecisionStore(dbPath);
    const cols = (store.db.pragma('table_info(decisions)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('git_branch');
  });

  it('creates branch indices on a fresh DB', () => {
    store = new DecisionStore(dbPath);
    const idx = (
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decisions'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toContain('idx_decisions_branch');
    expect(idx).toContain('idx_decisions_file_branch');
  });

  it('backfills existing rows to NULL when upgrading from a legacy schema', () => {
    // Build a legacy-shaped DB by hand: no git_branch column, no service_name,
    // no updated_at — i.e. the v1 schema before any of the additive migrations.
    // We include FTS5 + triggers because the DDL re-creates them with
    // IF NOT EXISTS, and ALTER TABLE on a content-table with stale triggers
    // is what would otherwise hit "database disk image is malformed".
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE decisions (
        id              INTEGER PRIMARY KEY,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        type            TEXT NOT NULL,
        project_root    TEXT NOT NULL,
        symbol_id       TEXT,
        file_path       TEXT,
        tags            TEXT,
        valid_from      TEXT NOT NULL,
        valid_until     TEXT,
        session_id      TEXT,
        source          TEXT NOT NULL DEFAULT 'manual',
        confidence      REAL NOT NULL DEFAULT 1.0,
        created_at      TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE decisions_fts USING fts5(
        title, content, tags,
        content=decisions, content_rowid=id, tokenize='porter unicode61'
      );
      CREATE TRIGGER decisions_ai AFTER INSERT ON decisions BEGIN
        INSERT INTO decisions_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END;
      INSERT INTO decisions (title, content, type, project_root, valid_from, created_at)
      VALUES ('legacy A', 'legacy content', 'preference', '/p', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
             ('legacy B', 'legacy content', 'tech_choice', '/p', '2025-01-02T00:00:00Z', '2025-01-02T00:00:00Z');
    `);
    raw.close();

    // Open through DecisionStore — preMigrate must add the column without losing data.
    store = new DecisionStore(dbPath);
    const rows = store.db
      .prepare('SELECT id, title, git_branch FROM decisions ORDER BY id')
      .all() as Array<{
      id: number;
      title: string;
      git_branch: string | null;
    }>;
    expect(rows.length).toBe(2);
    expect(rows[0].git_branch).toBeNull();
    expect(rows[1].git_branch).toBeNull();
  });

  it('is idempotent — opening twice does not error', () => {
    store = new DecisionStore(dbPath);
    store.close();
    // Second open hits preMigrate's column-exists branch and the
    // CREATE TABLE/INDEX IF NOT EXISTS guards in DECISIONS_DDL.
    store = new DecisionStore(dbPath);
    const cols = (store.db.pragma('table_info(decisions)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols.filter((c) => c === 'git_branch').length).toBe(1);
  });

  it('persists git_branch on insert and round-trips through SELECT', () => {
    store = new DecisionStore(dbPath);
    const row = store.addDecision({
      title: 'Branch-tagged',
      content: 'made on feature branch',
      type: 'preference',
      project_root: '/p',
      git_branch: 'feature/auth',
    });
    expect(row.git_branch).toBe('feature/auth');
    const fetched = store.getDecision(row.id);
    expect(fetched?.git_branch).toBe('feature/auth');
  });

  it('stores NULL when git_branch is omitted', () => {
    store = new DecisionStore(dbPath);
    const row = store.addDecision({
      title: 'No branch',
      content: 'pre-feature behavior',
      type: 'preference',
      project_root: '/p',
    });
    expect(row.git_branch).toBeNull();
  });
});

// ─── 2. Capture: getCurrentBranch ────────────────────────────────────────

describe('getCurrentBranch (capture path)', () => {
  let cleanups: string[] = [];

  afterEach(() => {
    for (const dir of cleanups) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanups = [];
  });

  it('returns null for a non-existent path', () => {
    expect(getCurrentBranch('/definitely/does/not/exist/here')).toBeNull();
  });

  it('returns null for a non-git directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-nogit-'));
    cleanups.push(dir);
    expect(getCurrentBranch(dir)).toBeNull();
  });

  it('returns the branch name on a clean checkout', () => {
    const repo = makeRepo('main');
    cleanups.push(repo);
    expect(getCurrentBranch(repo)).toBe('main');
  });

  it('returns null on detached HEAD', () => {
    const repo = makeRepo('main');
    cleanups.push(repo);
    // Detach by checking out the commit SHA directly.
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['checkout', '--detach', sha]);
    expect(getCurrentBranch(repo)).toBeNull();
  });

  it('returns the worktree branch when called inside a linked worktree', () => {
    const repo = makeRepo('main');
    cleanups.push(repo);
    // git rev-parse --abbrev-ref HEAD respects the per-worktree HEAD,
    // so a linked worktree on a different branch must report that branch.
    const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-wt-'));
    cleanups.push(wtParent);
    const wt = path.join(wtParent, 'feat');
    git(repo, ['worktree', 'add', '-b', 'feat/x', wt]);
    expect(getCurrentBranch(wt)).toBe('feat/x');
  });
});

// ─── 3. Read filter: queryDecisions { git_branch } ───────────────────────

describe('queryDecisions: git_branch filter', () => {
  let store: DecisionStore;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-filter-db-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);

    const base: Omit<DecisionInput, 'title' | 'git_branch'> = {
      content: 'seeded',
      type: 'preference',
      project_root: '/p',
    };
    store.addDecision({ ...base, title: 'agnostic 1', git_branch: null });
    store.addDecision({ ...base, title: 'agnostic 2' /* git_branch omitted = null */ });
    store.addDecision({ ...base, title: 'on master', git_branch: 'master' });
    store.addDecision({ ...base, title: 'on master too', git_branch: 'master' });
    store.addDecision({ ...base, title: 'on feat/x', git_branch: 'feat/x' });
    store.addDecision({ ...base, title: 'on feat/y', git_branch: 'feat/y' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('mode "all" returns every row regardless of branch', () => {
    const rows = store.queryDecisions({ project_root: '/p', git_branch: 'all' });
    expect(rows.length).toBe(6);
  });

  it('omitted git_branch is back-compat (no filter)', () => {
    const rows = store.queryDecisions({ project_root: '/p' });
    expect(rows.length).toBe(6);
  });

  it('a specific branch returns that branch + branch-agnostic rows', () => {
    const rows = store.queryDecisions({ project_root: '/p', git_branch: 'master' });
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['agnostic 1', 'agnostic 2', 'on master', 'on master too']);
  });

  it('a different branch isolates from sibling branches but still includes NULL', () => {
    const rows = store.queryDecisions({ project_root: '/p', git_branch: 'feat/x' });
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['agnostic 1', 'agnostic 2', 'on feat/x']);
  });

  it('explicit null returns only branch-agnostic rows', () => {
    const rows = store.queryDecisions({ project_root: '/p', git_branch: null });
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['agnostic 1', 'agnostic 2']);
  });

  it('an unknown branch name returns only branch-agnostic rows', () => {
    const rows = store.queryDecisions({ project_root: '/p', git_branch: 'never-seen' });
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['agnostic 1', 'agnostic 2']);
  });
});
