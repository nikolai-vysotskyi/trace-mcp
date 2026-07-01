/**
 * Batch blob-read optimization for staleness verification (Task 3 perf).
 *
 * The fully-scattered worst case — N decisions each anchored to a DISTINCT
 * file — defeats the per-batch memo cache (every (file,ts) and (commit,slice)
 * key is unique). Historically that meant up to 2*N synchronous git spawns
 * (`git log` + `git show` per decision).
 *
 * `verifyDecisions` now collapses the `git show` half into a SINGLE
 * `git cat-file --batch` invocation for the whole batch, so the worst case
 * drops from ~2*N spawns to ~N+1. This test counts real git process spawns
 * via a PATH shim and asserts the blob-read side is batched.
 *
 * Correctness (identical verdicts) is covered by decision-verification-cache
 * and decision-verification tests; here we only assert the spawn-count win and
 * that verdicts are still correct on distinct files.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import type { DecisionRow } from '../../src/memory/decision-types.js';
import { verifyDecisions } from '../../src/memory/decision-verification.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e.com',
    },
  }).trim();
}

function baseRow(over: Partial<DecisionRow>): DecisionRow {
  return {
    id: 1,
    title: 't',
    content: 'c',
    type: 'architecture_decision',
    project_root: '/p',
    service_name: null,
    symbol_id: null,
    file_path: null,
    tags: null,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_until: null,
    session_id: null,
    source: 'manual',
    confidence: 1,
    git_branch: null,
    review_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    hit_count: 0,
    last_hit_at: null,
    ...over,
  };
}

/**
 * Install a `git` shim earlier on PATH that appends its subcommand to a log
 * file, then execs the real git. Returns { binDir, logFile, realGit }.
 */
function installGitSpy(tmp: string): { binDir: string; logFile: string; env: NodeJS.ProcessEnv } {
  const realGit = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
  const dir = path.join(tmp, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(tmp, 'git-calls.log');
  const shim = path.join(dir, 'git');
  fs.writeFileSync(
    shim,
    `#!/bin/bash\necho "$1" >> ${JSON.stringify(logFile)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  return {
    binDir: dir,
    logFile,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
  };
}

describe('verifyDecisions — batched blob reads on the scattered worst case', () => {
  let repo: string;
  let store: Store;
  let logFile: string;
  let spyEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-verify-batch-'));
    git(repo, ['init', '-q']);
    store = new Store(initializeDatabase(':memory:'));
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const spy = installGitSpy(repo);
    logFile = spy.logFile;
    spyEnv = spy.env;
  });

  afterEach(() => {
    store.db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('reads N distinct-file blobs with a single cat-file batch, not N git show spawns', () => {
    const N = 20;
    const decisions: DecisionRow[] = [];
    for (let i = 0; i < N; i++) {
      const rel = `src/f${i}.ts`;
      const src = `export function f${i}() { return ${i}; }\n`;
      fs.writeFileSync(path.join(repo, rel), src);
    }
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'seed']);
    const createdAt = new Date().toISOString();

    for (let i = 0; i < N; i++) {
      const rel = `src/f${i}.ts`;
      const src = `export function f${i}() { return ${i}; }\n`;
      const byteLen = Buffer.byteLength(src, 'utf8');
      const fileId = store.insertFile(rel, 'typescript', `h${i}`, byteLen);
      store.insertSymbol(fileId, {
        symbolId: `${rel}::f${i}#function`,
        name: `f${i}`,
        kind: 'function',
        byteStart: 0,
        byteEnd: byteLen,
      });
      decisions.push(
        baseRow({
          id: i + 1,
          symbol_id: `${rel}::f${i}#function`,
          file_path: rel,
          created_at: createdAt,
        }),
      );
    }

    // Run verification under the git spy so we can count `show` vs `cat-file`.
    fs.writeFileSync(logFile, '');
    const prevPath = process.env.PATH;
    process.env.PATH = spyEnv.PATH as string;
    let out: ReturnType<typeof verifyDecisions>;
    try {
      out = verifyDecisions(decisions, store, repo);
    } finally {
      process.env.PATH = prevPath;
    }

    const calls = fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const showCount = calls.filter((c) => c === 'show').length;
    const catFileCount = calls.filter((c) => c === 'cat-file').length;

    // All N verdicts must be "ok" (unchanged since createdAt) — correctness.
    expect(out.every((d) => !(d as { stale?: boolean }).stale)).toBe(true);
    // The batched path must NOT spawn a per-decision `git show`.
    expect(showCount).toBe(0);
    // Exactly one cat-file batch process covers all N blob reads.
    expect(catFileCount).toBe(1);
  });
});
