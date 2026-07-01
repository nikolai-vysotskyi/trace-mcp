/**
 * End-to-end staleness scenarios for Task 3, driving the real `Store` +
 * a real on-disk git repo (not the hand-seeded rows the unit tests use).
 *
 * Scenarios the shipped 8 tests do not cover:
 *   1. Delete the symbol's file ENTIRELY (disk + index) → symbol_missing,
 *      withheld from the wake-up surface.
 *   2. Change the symbol's source body but keep the same name/location →
 *      code_changed (not silently served as fresh).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import type { DecisionRow } from '../../src/memory/decision-types.js';
import { verifyDecision, verifyDecisions } from '../../src/memory/decision-verification.js';

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

/** Seed a file + one full-range symbol into the code Store; returns the fileId. */
function seedSymbol(store: Store, relPath: string, symbolId: string, source: string): number {
  const byteLen = Buffer.byteLength(source, 'utf8');
  const fileId = store.insertFile(relPath, 'typescript', 'hash', byteLen);
  store.insertSymbol(fileId, {
    symbolId,
    name: symbolId.split('::').pop() ?? symbolId,
    kind: 'function',
    byteStart: 0,
    byteEnd: byteLen,
  });
  return fileId;
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

describe('staleness verification — end-to-end (real Store + git)', () => {
  let repo: string;
  let store: Store;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-verify-e2e-'));
    git(repo, ['init', '-q']);
    store = new Store(initializeDatabase(':memory:'));
  });

  afterEach(() => {
    store.db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('flags + withholds a decision whose entire file was deleted from disk and index', () => {
    const rel = 'src/gone.ts';
    const src = 'export function doomed() {\n  return 42;\n}\n';
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), src);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'add doomed']);
    const fileId = seedSymbol(store, rel, `${rel}::doomed#function`, src);

    const decision = makeDecisionRow({
      symbol_id: `${rel}::doomed#function`,
      file_path: rel,
      created_at: new Date().toISOString(),
    });

    // Sanity: while the file/symbol exist, the decision is fresh.
    expect(verifyDecision(decision, store, repo).verification).toBe('ok');

    // Now delete the file ENTIRELY: from disk AND drop it from the index
    // (what the indexer does on a removed file).
    fs.rmSync(path.join(repo, rel));
    store.deleteFile(fileId);
    // The symbol must no longer resolve.
    expect(store.getSymbolBySymbolId(`${rel}::doomed#function`)).toBeUndefined();

    // query_decisions path: flagged in place.
    const flagged = verifyDecision(decision, store, repo);
    expect(flagged.verification).toBe('symbol_missing');
    expect(flagged.stale).toBe(true);

    // get_wake_up path: withheld entirely from the surface.
    const withheld = verifyDecisions([decision], store, repo, { withhold: true });
    expect(withheld).toHaveLength(0);
  });

  it('flags code_changed when the body changes in place (same name/location)', () => {
    const rel = 'src/mut.ts';
    const original = 'export function mut() {\n  return 1;\n}\n';
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), original);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'v1']);

    // Decision captured against v1 (committed state).
    const decision = makeDecisionRow({
      symbol_id: `${rel}::mut#function`,
      file_path: rel,
      created_at: new Date().toISOString(),
    });

    // Change the body in place, keep the same symbol id + full-range offsets.
    const changed = 'export function mut() {\n  return 424242;\n}\n';
    fs.writeFileSync(path.join(repo, rel), changed);
    seedSymbol(store, rel, `${rel}::mut#function`, changed);

    const v = verifyDecision(decision, store, repo);
    expect(v.verification).toBe('code_changed');
    expect(v.stale).toBe(true);

    // It must NOT be silently served as fresh: withhold drops it, annotate flags it.
    expect(verifyDecisions([decision], store, repo, { withhold: true })).toHaveLength(0);
    const annotated = verifyDecisions([decision], store, repo);
    expect(annotated[0]).toMatchObject({ verification: 'code_changed', stale: true });
  });

  it('does NOT flag when only whitespace / trailing spaces change (cosmetic diff)', () => {
    // Guards against over-flagging: the verifier normalizes trailing whitespace
    // + CRLF, so a purely cosmetic reformat must stay "ok".
    const rel = 'src/cosmetic.ts';
    const original = 'export function keep() {\n  return 1;\n}\n';
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), original);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'v1']);

    const decision = makeDecisionRow({
      symbol_id: `${rel}::keep#function`,
      file_path: rel,
      created_at: new Date().toISOString(),
    });

    // Add trailing spaces on each line — normalize() should erase the diff.
    const cosmetic = 'export function keep() {   \n  return 1;  \n}\n';
    fs.writeFileSync(path.join(repo, rel), cosmetic);
    seedSymbol(store, rel, `${rel}::keep#function`, cosmetic);

    expect(verifyDecision(decision, store, repo).verification).toBe('ok');
  });
});
