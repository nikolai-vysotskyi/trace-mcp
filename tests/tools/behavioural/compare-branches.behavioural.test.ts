/**
 * Behavioural coverage for `compareBranches()` in
 * `src/tools/quality/changed-symbols.ts` (the implementation behind the
 * `compare_branches` MCP tool). compareBranches is sugar over
 * getChangedSymbols: it resolves merge-base, counts commits, groups symbols
 * by category/file/risk, and emits a risk assessment ranked by blast radius.
 *
 * Git is mocked via `node:child_process.execFileSync` so the test runs offline.
 */

import { execFileSync } from 'node:child_process';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { compareBranches } from '../../../src/tools/quality/changed-symbols.js';
import { contentHash, initContentHasher } from '../../../src/util/hash.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExec = vi.mocked(execFileSync);

interface GitMock {
  mergeBase?: string;
  commitCount?: string;
  nameStatus?: string;
  unified?: string;
  /** Blob content returned for `git show <ref>:<path>`, keyed by path. */
  show?: Record<string, string>;
}

function mockGit(g: GitMock): void {
  mockExec.mockImplementation(((_cmd: string, args: readonly string[] | undefined) => {
    const a = (args ?? []) as string[];
    if (a[0] === 'merge-base') return g.mergeBase ?? 'mb-sha';
    if (a[0] === 'rev-list') return g.commitCount ?? '3';
    if (a[0] === 'show') {
      const spec = a[1] ?? '';
      const path = spec.slice(spec.indexOf(':') + 1);
      if (!g.show || !(path in g.show)) throw new Error(`no blob mocked for "${spec}"`);
      return Buffer.from(g.show[path]);
    }
    if (a[0] === 'diff' && a.includes('--name-status')) return g.nameStatus ?? '';
    if (a[0] === 'diff' && a.includes('--unified=0')) return g.unified ?? '';
    return '';
  }) as never);
}

// Real file contents, hashed for real, so the freshness check sees a match.
const PAYMENTS_CONTENT = 'export function charge() {}\nexport function refund() {}\n';
const EMAIL_CONTENT = 'export function sendEmail() {}\n';
const API_CONTENT = 'export function route() {}\n';

let PAYMENTS_HASH: string;
let EMAIL_HASH: string;
let API_HASH: string;

beforeAll(async () => {
  await initContentHasher();
  PAYMENTS_HASH = contentHash(Buffer.from(PAYMENTS_CONTENT));
  EMAIL_HASH = contentHash(Buffer.from(EMAIL_CONTENT));
  API_HASH = contentHash(Buffer.from(API_CONTENT));
});

function seedStore(store: Store): void {
  const f1 = store.insertFile('src/payments.ts', 'typescript', PAYMENTS_HASH, 600);
  store.insertSymbol(f1, {
    symbolId: 'src/payments.ts::charge#function',
    name: 'charge',
    kind: 'function',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 5,
    lineEnd: 15,
    signature: 'function charge()',
  });
  store.insertSymbol(f1, {
    symbolId: 'src/payments.ts::refund#function',
    name: 'refund',
    kind: 'function',
    byteStart: 110,
    byteEnd: 200,
    lineStart: 20,
    lineEnd: 30,
    signature: 'function refund()',
  });

  const f2 = store.insertFile('src/email.ts', 'typescript', EMAIL_HASH, 200);
  store.insertSymbol(f2, {
    symbolId: 'src/email.ts::sendEmail#function',
    name: 'sendEmail',
    kind: 'function',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 12,
    signature: 'function sendEmail()',
  });

  // Added (whole-file-added) src/api.ts — touched by diff name-status A
  const f3 = store.insertFile('src/api.ts', 'typescript', API_HASH, 100);
  store.insertSymbol(f3, {
    symbolId: 'src/api.ts::route#function',
    name: 'route',
    kind: 'function',
    byteStart: 0,
    byteEnd: 60,
    lineStart: 1,
    lineEnd: 8,
    signature: 'function route()',
  });
}

const ADDS_AND_MODS_DIFF = {
  mergeBase: 'mb-sha-1',
  commitCount: '4',
  nameStatus: 'M\tsrc/payments.ts\nM\tsrc/email.ts\nA\tsrc/api.ts',
  unified:
    '+++ b/src/payments.ts\n@@ -5,3 +5,5 @@\n' +
    '+++ b/src/payments.ts\n@@ -20,3 +20,5 @@\n' +
    '+++ b/src/email.ts\n@@ -1,3 +1,5 @@\n',
  show: {
    'src/payments.ts': PAYMENTS_CONTENT,
    'src/email.ts': EMAIL_CONTENT,
    'src/api.ts': API_CONTENT,
  },
};

describe('compareBranches() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createTestStore();
    seedStore(store);
  });

  it('returns { branch, base, mergeBase, commitCount, changedSymbols, summary }', async () => {
    mockGit(ADDS_AND_MODS_DIFF);

    const result = await compareBranches(store, '/proj', { branch: 'feat-x', base: 'main' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.branch).toBe('feat-x');
    expect(result.value.base).toBe('main');
    expect(result.value.mergeBase).toBe('mb-sha-1');
    expect(result.value.commitCount).toBe(4);
    expect(Array.isArray(result.value.changedSymbols)).toBe(true);
    expect(result.value.summary).toMatchObject({
      added: expect.any(Number),
      modified: expect.any(Number),
      removed: expect.any(Number),
      renamed: expect.any(Number),
    });
    expect(result.value.staleFiles).toEqual([]);
  });

  it('group_by="category" buckets symbols by changeKind', async () => {
    mockGit(ADDS_AND_MODS_DIFF);

    const result = await compareBranches(store, '/proj', {
      branch: 'feat-x',
      base: 'main',
      groupBy: 'category',
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    const keys = Object.keys(result.value.grouped);
    // Each grouped key must be a valid changeKind
    for (const k of keys) {
      expect(['added', 'modified', 'removed', 'renamed']).toContain(k);
    }
    // At least one of the well-known categories appeared
    expect(keys.length).toBeGreaterThan(0);
  });

  it('group_by="file" buckets symbols by their source file', async () => {
    mockGit(ADDS_AND_MODS_DIFF);

    const result = await compareBranches(store, '/proj', {
      branch: 'feat-x',
      base: 'main',
      groupBy: 'file',
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    const keys = Object.keys(result.value.grouped);
    // Every key should look like a file path (contains a slash or .ts).
    for (const k of keys) {
      expect(/\.ts$/.test(k) || k.includes('/')).toBe(true);
    }
  });

  it('group_by="risk" produces low/medium/high buckets keyed by blastRadius', async () => {
    mockGit(ADDS_AND_MODS_DIFF);

    const result = await compareBranches(store, '/proj', {
      branch: 'feat-x',
      base: 'main',
      groupBy: 'risk',
      includeBlastRadius: true,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    for (const k of Object.keys(result.value.grouped)) {
      expect(['low', 'medium', 'high']).toContain(k);
    }
  });

  it('includeBlastRadius=true + maxBlastDepth is propagated to per-symbol blastRadius', async () => {
    mockGit(ADDS_AND_MODS_DIFF);

    const result = await compareBranches(store, '/proj', {
      branch: 'feat-x',
      base: 'main',
      includeBlastRadius: true,
      maxBlastDepth: 1,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.changedSymbols.length).toBeGreaterThan(0);
    for (const s of result.value.changedSymbols) {
      expect(typeof s.blastRadius).toBe('number');
    }
    expect(Array.isArray(result.value.riskAssessment)).toBe(true);
  });

  // --- Freshness gate (TRA-1075) ---
  // compareBranches accepts an arbitrary `branch` argument and joins the diff
  // against whatever the index happened to hold at last reindex — the branch
  // never has to have been checked out. The content_hash gate is what makes
  // that safe: a divergent file is excluded and reported, not silently joined.

  it('excludes stale files from the diff and reports them in staleFiles, without failing the whole comparison', async () => {
    mockGit({
      ...ADDS_AND_MODS_DIFF,
      show: {
        ...ADDS_AND_MODS_DIFF.show,
        // src/payments.ts drifted from what the index recorded — e.g. the
        // index was built against a different checkout of `feat-x`.
        'src/payments.ts': 'export function charge(extra) {}\n',
      },
    });

    const result = await compareBranches(store, '/proj', { branch: 'feat-x', base: 'main' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.staleFiles).toEqual(['src/payments.ts']);
    expect(result.value.changedSymbols.some((s) => s.file === 'src/payments.ts')).toBe(false);
    // The rest of the comparison still resolves normally.
    expect(result.value.changedSymbols.some((s) => s.file === 'src/email.ts')).toBe(true);
  });
});
