import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import type { DecisionRow } from '../../src/memory/decision-types.js';
import { verifyDecision, verifyDecisions } from '../../src/memory/decision-verification.js';

/**
 * These tests build a real on-disk git repo so the staleness verifier can
 * resolve "the source slice at the last commit ≤ created_at" against actual
 * history. The code Store is seeded to mirror what the indexer would produce.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

/** Seed a file + one symbol spanning its full byte range into the code Store. */
function seedSymbol(store: Store, relPath: string, symbolId: string, source: string): void {
  const byteLen = Buffer.byteLength(source, 'utf8');
  const fileId = store.insertFile(relPath, 'typescript', 'hash', byteLen);
  store.insertSymbol(fileId, {
    symbolId,
    name: symbolId.split('::').pop() ?? symbolId,
    kind: 'function',
    byteStart: 0,
    byteEnd: byteLen,
  });
}

function makeDecisionRow(over: Partial<DecisionRow>): DecisionRow {
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

describe('decision staleness verification', () => {
  let repo: string;
  let store: Store;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-verify-'));
    git(repo, ['init', '-q']);
    store = new Store(initializeDatabase(':memory:'));
  });

  afterEach(() => {
    store.db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('serves a decision whose symbol still exists and is unchanged', () => {
    const rel = 'src/foo.ts';
    const src = 'export function foo() {\n  return 1;\n}\n';
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), src);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'add foo']);
    seedSymbol(store, rel, `${rel}::foo#function`, src);

    // Decision created AFTER the commit — its anchored code is unchanged since.
    const decision = makeDecisionRow({
      symbol_id: `${rel}::foo#function`,
      file_path: rel,
      created_at: new Date(Date.now()).toISOString(),
    });

    const v = verifyDecision(decision, store, repo);
    expect(v.verification).toBe('ok');
    expect(v.stale).toBe(false);
  });

  it('flags a decision whose symbol was deleted/renamed (symbol_missing)', () => {
    const rel = 'src/foo.ts';
    const src = 'export function foo() {\n  return 1;\n}\n';
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), src);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'add foo']);
    // NOTE: deliberately do NOT seed the symbol → it no longer resolves.

    const decision = makeDecisionRow({
      symbol_id: `${rel}::foo#function`,
      file_path: rel,
      created_at: new Date(Date.now()).toISOString(),
    });

    const v = verifyDecision(decision, store, repo);
    expect(v.verification).toBe('symbol_missing');
    expect(v.stale).toBe(true);
  });

  it('flags a decision whose source changed after created_at (code_changed)', () => {
    const rel = 'src/foo.ts';
    const original = 'export function foo() {\n  return 1;\n}\n';
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), original);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'v1']);

    // Decision captured against v1.
    const createdAt = new Date(Date.now()).toISOString();

    // Wait a tick, then materially change the body and re-index the Store to
    // the new on-disk state (what register_edit would do after the edit).
    const changed = 'export function foo() {\n  return 999;\n}\n';
    fs.writeFileSync(path.join(repo, rel), changed);
    seedSymbol(store, rel, `${rel}::foo#function`, changed);

    const decision = makeDecisionRow({
      symbol_id: `${rel}::foo#function`,
      file_path: rel,
      created_at: createdAt,
    });

    const v = verifyDecision(decision, store, repo);
    expect(v.verification).toBe('code_changed');
    expect(v.stale).toBe(true);
  });

  it('treats a bare (no symbol_id) decision as ok without touching git', () => {
    const decision = makeDecisionRow({ symbol_id: null, file_path: 'src/foo.ts' });
    const v = verifyDecision(decision, store, repo);
    expect(v.verification).toBe('ok');
    expect(v.stale).toBe(false);
  });

  it('fails open to ok when git is unavailable (no repo)', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-verify-nogit-'));
    try {
      const rel = 'src/foo.ts';
      const src = 'export function foo() {\n  return 1;\n}\n';
      fs.mkdirSync(path.join(nonGit, 'src'), { recursive: true });
      fs.writeFileSync(path.join(nonGit, rel), src);
      seedSymbol(store, rel, `${rel}::foo#function`, src);
      const decision = makeDecisionRow({
        symbol_id: `${rel}::foo#function`,
        file_path: rel,
        created_at: new Date().toISOString(),
      });
      const v = verifyDecision(decision, store, nonGit);
      expect(v.verification).toBe('ok');
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  describe('verifyDecisions batch', () => {
    it('annotates stale rows in place by default and leaves fresh rows untouched', () => {
      const rel = 'src/foo.ts';
      const src = 'export function foo() {\n  return 1;\n}\n';
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), src);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'v1']);
      seedSymbol(store, rel, `${rel}::foo#function`, src);

      const fresh = makeDecisionRow({
        id: 1,
        symbol_id: `${rel}::foo#function`,
        file_path: rel,
        created_at: new Date().toISOString(),
      });
      const missing = makeDecisionRow({
        id: 2,
        symbol_id: `${rel}::gone#function`,
        file_path: rel,
        created_at: new Date().toISOString(),
      });
      const bare = makeDecisionRow({ id: 3, symbol_id: null });

      const out = verifyDecisions([fresh, missing, bare], store, repo);
      expect(out).toHaveLength(3);
      const byId = new Map(out.map((d) => [d.id, d]));
      expect(byId.get(1)).not.toHaveProperty('stale');
      expect(byId.get(2)).toMatchObject({ verification: 'symbol_missing', stale: true });
      expect(byId.get(3)).not.toHaveProperty('stale');
    });

    it('withholds stale rows when opts.withhold is set', () => {
      const rel = 'src/foo.ts';
      const src = 'export function foo() {\n  return 1;\n}\n';
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), src);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'v1']);
      seedSymbol(store, rel, `${rel}::foo#function`, src);

      const fresh = makeDecisionRow({
        id: 1,
        symbol_id: `${rel}::foo#function`,
        file_path: rel,
        created_at: new Date().toISOString(),
      });
      const missing = makeDecisionRow({
        id: 2,
        symbol_id: `${rel}::gone#function`,
        file_path: rel,
        created_at: new Date().toISOString(),
      });

      const out = verifyDecisions([fresh, missing], store, repo, { withhold: true });
      expect(out.map((d) => d.id)).toEqual([1]);
    });

    it('returns rows untouched when no code store is available', () => {
      const rows = [makeDecisionRow({ id: 1, symbol_id: 'x::y#function' })];
      const out = verifyDecisions(rows, null, repo);
      expect(out).toBe(rows);
    });
  });
});
