/**
 * Batch commit-lookup optimization for staleness verification (TRA-129).
 *
 * `lastCommitBefore` used to run one `git log -1 --before=<ts>` spawn per
 * unique (file, created_at) pair — the fully-scattered worst case (N decisions
 * on N distinct files, each with its own `created_at`) meant N separate `git
 * log` spawns, on top of the already-batched `git show` half (see
 * decision-verification-batch.test.ts).
 *
 * `verifyDecisions` now resolves the commit lookup with ONE `git log` per
 * DISTINCT FILE (`batchResolveCommitsByFile`), pulling that file's whole
 * commit history and binary-searching it in-process for every decision
 * anchored to that file — regardless of how many distinct `created_at`
 * values those decisions carry. This test seeds multiple decisions per file
 * with DIFFERENT timestamps (so the (file, created_at) memo key can't
 * collapse them) and asserts the `git log` subcommand spawns exactly once
 * per distinct file, not once per decision.
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

function git(cwd: string, args: string[], commitIso?: string): string {
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
      // Git commit timestamps only have second-level granularity — two real
      // commits made back-to-back in a fast test can land on the same
      // second, making their order ambiguous. Pin explicit, well-separated
      // dates so the "before ts1 → v1, before ts2 → v2" assertions below are
      // deterministic instead of a timing-dependent flake.
      ...(commitIso ? { GIT_AUTHOR_DATE: commitIso, GIT_COMMITTER_DATE: commitIso } : {}),
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

/** Same technique as decision-verification-batch.test.ts — see its comment for why. */
function countGitInvocations(traceLog: string, subcommand: string): number {
  const re = new RegExp(`trace: built-in: git ${subcommand}(?:\\s|$)`, 'g');
  return (traceLog.match(re) ?? []).length;
}

describe('verifyDecisions — batched commit lookups on the scattered worst case', () => {
  let repo: string;
  let store: Store;
  let logFile: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-verify-log-batch-'));
    git(repo, ['init', '-q']);
    store = new Store(initializeDatabase(':memory:'));
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    logFile = `${repo}.trace.log`;
  });

  afterEach(() => {
    store.db.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(logFile, { force: true });
  });

  it('resolves 2 decisions x N distinct files x distinct timestamps with N `git log` spawns, not 2N', () => {
    const N = 10;
    const decisions: DecisionRow[] = [];
    // Base time far enough in the past that "commit v1, then v2" and their
    // in-between `created_at` markers never collide on the same second.
    const base = Date.parse('2026-01-01T00:00:00.000Z');

    for (let i = 0; i < N; i++) {
      const rel = `src/f${i}.ts`;
      const fileBase = base + i * 60_000; // 60s window per file, well isolated
      const v1CommitAt = new Date(fileBase).toISOString();
      const ts1 = new Date(fileBase + 10_000).toISOString(); // between v1 and v2 commits
      const v2CommitAt = new Date(fileBase + 20_000).toISOString();
      const ts2 = new Date(fileBase + 30_000).toISOString(); // after v2 commit

      const v1 = `export function f${i}() { return ${i}; }\n`;
      fs.writeFileSync(path.join(repo, rel), v1);
      git(repo, ['add', rel]);
      git(repo, ['commit', '-q', '-m', `f${i} v1`], v1CommitAt);

      const v2 = `export function f${i}() { return ${i} + 1; }\n`;
      fs.writeFileSync(path.join(repo, rel), v2);
      git(repo, ['add', rel]);
      git(repo, ['commit', '-q', '-m', `f${i} v2`], v2CommitAt);

      const byteLen = Buffer.byteLength(v2, 'utf8');
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
          id: i * 2 + 1,
          symbol_id: `${rel}::f${i}#function`,
          file_path: rel,
          created_at: ts1,
        }),
        baseRow({
          id: i * 2 + 2,
          symbol_id: `${rel}::f${i}#function`,
          file_path: rel,
          created_at: ts2,
        }),
      );
    }

    fs.writeFileSync(logFile, '');
    const prevTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = logFile;
    let out: ReturnType<typeof verifyDecisions>;
    try {
      out = verifyDecisions(decisions, store, repo);
    } finally {
      if (prevTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = prevTrace;
    }

    const traceLog = fs.readFileSync(logFile, 'utf8');
    const logCount = countGitInvocations(traceLog, 'log');

    // Correctness: every decision resolves against its own commit — the ts1
    // anchors see the v1 body (stale, since HEAD is v2), ts2 anchors see the
    // current v2 body (fresh).
    const byId = new Map(out.map((d) => [d.id, d as DecisionRow & { stale?: boolean }]));
    for (let i = 0; i < N; i++) {
      expect(byId.get(i * 2 + 1)?.stale).toBe(true); // ts1: body changed since
      expect(byId.get(i * 2 + 2)?.stale ?? false).toBe(false); // ts2: unchanged since
    }
    // One `git log` per distinct file (N), never one per decision (2N).
    expect(logCount).toBe(N);
  });
});
