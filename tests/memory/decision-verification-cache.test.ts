/**
 * Per-batch memoization for staleness verification (Task 3 perf).
 *
 * `verifyDecisions` does up to 2 synchronous git subprocess spawns per
 * anchored decision. When decisions cluster on the same file + created_at
 * (a very common shape — "many decisions about one hot module"), a shared
 * per-batch cache collapses the duplicate `git log` / `git show` spawns.
 *
 * We assert (a) the shared cache is populated exactly once per unique input
 * tuple, and (b) verdicts are byte-identical to the un-cached path (pure
 * optimization).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import type { DecisionRow } from '../../src/memory/decision-types.js';
import {
  createVerifyCache,
  verifyDecision,
  verifyDecisions,
} from '../../src/memory/decision-verification.js';

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

function seedSymbol(store: Store, rel: string, symbolId: string, src: string): void {
  const byteLen = Buffer.byteLength(src, 'utf8');
  const fileId = store.insertFile(rel, 'typescript', 'h', byteLen);
  store.insertSymbol(fileId, {
    symbolId,
    name: symbolId.split('::').pop() ?? symbolId,
    kind: 'function',
    byteStart: 0,
    byteEnd: byteLen,
  });
}

describe('verifyDecisions — per-batch git memoization', () => {
  let repo: string;
  let store: Store;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-verify-cache-'));
    git(repo, ['init', '-q']);
    store = new Store(initializeDatabase(':memory:'));
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  });

  afterEach(() => {
    store.db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('caches one commit lookup + one slice read per unique tuple across a batch', () => {
    // One file, many symbols sharing the SAME byte range + created_at → every
    // decision resolves to the SAME (file,ts) commit key and the SAME
    // (commit,file,range) slice key. The cache must therefore hold exactly ONE
    // commit entry and ONE slice entry, not N of each.
    const rel = 'src/hot.ts';
    let src = '';
    const N = 12;
    for (let s = 0; s < N; s++) src += `export function h${s}() { return ${s}; }\n`;
    fs.writeFileSync(path.join(repo, rel), src);
    git(repo, ['add', rel]);
    git(repo, ['commit', '-q', '-m', 'add hot']);
    const byteLen = Buffer.byteLength(src, 'utf8');
    const fileId = store.insertFile(rel, 'typescript', 'h', byteLen);
    const createdAt = new Date().toISOString();
    const decisions: DecisionRow[] = [];
    for (let s = 0; s < N; s++) {
      store.insertSymbol(fileId, {
        symbolId: `${rel}::h${s}#function`,
        name: `h${s}`,
        kind: 'function',
        byteStart: 0,
        byteEnd: byteLen,
      });
      decisions.push(
        baseRow({
          id: s + 1,
          symbol_id: `${rel}::h${s}#function`,
          file_path: rel,
          created_at: createdAt,
        }),
      );
    }

    // Drive verifyDecision manually with a shared cache and inspect its size.
    const cache = createVerifyCache();
    for (const d of decisions) {
      const v = verifyDecision(d, store, repo, cache);
      expect(v.verification).toBe('ok');
    }
    // Without memoization the module would spawn 2*N=24 git processes. With the
    // cache, the shared tuple collapses to exactly 1 commit + 1 slice entry.
    expect(cache.commitByFileTs.size).toBe(1);
    expect(cache.sliceByCommit.size).toBe(1);
  });

  it('produces identical verdicts to per-row verification (pure optimization)', () => {
    // Three anchors: unchanged (ok), body changed in place (code_changed),
    // deleted symbol (symbol_missing).
    const relOk = 'src/ok.ts';
    const okSrc = 'export function ok() { return 1; }\n';
    fs.writeFileSync(path.join(repo, relOk), okSrc);
    const relChanged = 'src/changed.ts';
    const changedV1 = 'export function chg() { return 1; }\n';
    fs.writeFileSync(path.join(repo, relChanged), changedV1);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'v1']);
    const createdAt = new Date().toISOString();

    seedSymbol(store, relOk, `${relOk}::ok#function`, okSrc);

    // changed symbol: body edited after createdAt.
    const changedV2 = 'export function chg() { return 999; }\n';
    fs.writeFileSync(path.join(repo, relChanged), changedV2);
    seedSymbol(store, relChanged, `${relChanged}::chg#function`, changedV2);

    const decisions = [
      baseRow({
        id: 1,
        symbol_id: `${relOk}::ok#function`,
        file_path: relOk,
        created_at: createdAt,
      }),
      baseRow({
        id: 2,
        symbol_id: `${relChanged}::chg#function`,
        file_path: relChanged,
        created_at: createdAt,
      }),
      baseRow({
        id: 3,
        symbol_id: `${relOk}::gone#function`,
        file_path: relOk,
        created_at: createdAt,
      }),
    ];

    // Batch (cached) path.
    const cachedOut = verifyDecisions(decisions, store, repo);
    // Un-cached reference: verify each row with a fresh cache each time.
    const refOut = decisions.map((d) => {
      const v = verifyDecision(d, store, repo, createVerifyCache());
      return v.stale ? { id: d.id, verification: v.verification, stale: true } : { id: d.id };
    });

    const cachedShape = cachedOut.map((d) => {
      const r = d as DecisionRow & { verification?: string; stale?: boolean };
      return r.stale ? { id: r.id, verification: r.verification, stale: true } : { id: r.id };
    });
    expect(cachedShape).toEqual(refOut);
    // Spot-check the actual verdicts.
    const byId = new Map(cachedShape.map((d) => [d.id, d]));
    expect(byId.get(1)).not.toHaveProperty('stale');
    expect(byId.get(2)).toMatchObject({ verification: 'code_changed', stale: true });
    expect(byId.get(3)).toMatchObject({ verification: 'symbol_missing', stale: true });
  });
});
