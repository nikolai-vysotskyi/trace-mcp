/**
 * Behavioural coverage for `getChangedSymbols()` in
 * `src/tools/quality/changed-symbols.ts` (the implementation behind the
 * `get_changed_symbols` MCP tool). Maps git diff hunks to indexed symbols
 * and reports added/modified/removed change kinds plus optional blast radius.
 * Git is mocked via `node:child_process.execFileSync` so tests run offline.
 *
 * Complements the existing injection-only suite
 * (tests/tools/changed-symbols-injection.test.ts) — this file covers the
 * happy-path shape, filter semantics, and change-type classification.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { getChangedSymbols } from '../../../src/tools/quality/changed-symbols.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExec = vi.mocked(execFileSync);

interface GitMock {
  /** Optional merge-base output returned for `git merge-base <base> <ref>`. */
  mergeBase?: string;
  /** Output for `git diff --name-status …`. */
  nameStatus?: string;
  /** Output for `git diff --unified=0 …`. */
  unified?: string;
}

function mockGit(g: GitMock): void {
  mockExec.mockImplementation(((_cmd: string, args: readonly string[] | undefined) => {
    const a = (args ?? []) as string[];
    if (a[0] === 'merge-base') return g.mergeBase ?? 'abc1234';
    if (a[0] === 'diff' && a.includes('--name-status')) return g.nameStatus ?? '';
    if (a[0] === 'diff' && a.includes('--unified=0')) return g.unified ?? '';
    return '';
  }) as never);
}

function seedFiles(store: Store): void {
  // Modified file with two symbols
  const modFile = store.insertFile('src/auth/login.ts', 'typescript', 'h-mod', 500);
  store.insertSymbol(modFile, {
    symbolId: 'src/auth/login.ts::login#function',
    name: 'login',
    kind: 'function',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 5,
    lineEnd: 15,
    signature: 'function login()',
  });
  store.insertSymbol(modFile, {
    symbolId: 'src/auth/login.ts::logout#function',
    name: 'logout',
    kind: 'function',
    byteStart: 110,
    byteEnd: 200,
    lineStart: 40,
    lineEnd: 50,
    signature: 'function logout()',
  });

  // Added file
  const addFile = store.insertFile('src/auth/sso.ts', 'typescript', 'h-add', 300);
  store.insertSymbol(addFile, {
    symbolId: 'src/auth/sso.ts::ssoEntry#function',
    name: 'ssoEntry',
    kind: 'function',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 10,
    signature: 'function ssoEntry()',
  });

  // Removed file
  const delFile = store.insertFile('src/legacy/old.ts', 'typescript', 'h-del', 200);
  store.insertSymbol(delFile, {
    symbolId: 'src/legacy/old.ts::oldFn#function',
    name: 'oldFn',
    kind: 'function',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 8,
    signature: 'function oldFn()',
  });
}

describe('getChangedSymbols() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createTestStore();
    seedFiles(store);
  });

  it('classifies adds/modifies/removes from git diff into changeKind', () => {
    mockGit({
      nameStatus: 'A\tsrc/auth/sso.ts\nM\tsrc/auth/login.ts\nD\tsrc/legacy/old.ts',
      unified:
        '+++ b/src/auth/sso.ts\n@@ -0,0 +1,10 @@\n' + '+++ b/src/auth/login.ts\n@@ -5,3 +5,5 @@\n',
    });

    const result = getChangedSymbols(store, '/proj', { since: 'main', until: 'HEAD' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    const kinds = result.value.changedSymbols.map((s) => s.changeKind).sort();
    expect(kinds).toContain('added');
    expect(kinds).toContain('modified');
    expect(kinds).toContain('removed');

    // Summary mirrors the per-symbol counts
    const summary = result.value.summary;
    expect(summary.added).toBeGreaterThanOrEqual(1);
    expect(summary.modified).toBeGreaterThanOrEqual(1);
    expect(summary.removed).toBeGreaterThanOrEqual(1);
  });

  it('result envelope carries since/until/changedFiles/changedSymbols/summary', () => {
    mockGit({
      nameStatus: 'M\tsrc/auth/login.ts',
      unified: '+++ b/src/auth/login.ts\n@@ -5,3 +5,5 @@\n',
    });

    const result = getChangedSymbols(store, '/proj', { since: 'main', until: 'HEAD' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.since).toBe('main');
    expect(result.value.until).toBe('HEAD');
    expect(typeof result.value.changedFiles).toBe('number');
    expect(Array.isArray(result.value.changedSymbols)).toBe(true);
    expect(result.value.summary).toMatchObject({
      added: expect.any(Number),
      modified: expect.any(Number),
      removed: expect.any(Number),
      renamed: expect.any(Number),
    });

    // Each symbol entry has the documented shape.
    for (const s of result.value.changedSymbols) {
      expect(typeof s.symbolId).toBe('string');
      expect(typeof s.name).toBe('string');
      expect(typeof s.kind).toBe('string');
      expect(typeof s.file).toBe('string');
      expect(['added', 'modified', 'removed', 'renamed']).toContain(s.changeKind);
    }
  });

  it('includeBlastRadius=true populates blastRadius on each changed symbol', () => {
    mockGit({
      nameStatus: 'M\tsrc/auth/login.ts',
      unified: '+++ b/src/auth/login.ts\n@@ -5,3 +5,5 @@\n',
    });

    const result = getChangedSymbols(store, '/proj', {
      since: 'main',
      until: 'HEAD',
      includeBlastRadius: true,
      maxBlastDepth: 2,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.changedSymbols.length).toBeGreaterThan(0);
    for (const s of result.value.changedSymbols) {
      expect(typeof s.blastRadius).toBe('number');
    }
  });

  it('empty diff (since == until) yields zero changed symbols + zero summary', () => {
    mockGit({ nameStatus: '', unified: '' });

    const result = getChangedSymbols(store, '/proj', { since: 'HEAD', until: 'HEAD' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.changedSymbols).toEqual([]);
    expect(result.value.changedFiles).toBe(0);
    expect(result.value.summary).toEqual({ added: 0, modified: 0, removed: 0, renamed: 0 });
  });

  it('auto-detects base branch when "since" is omitted (calls git merge-base)', () => {
    mockGit({
      mergeBase: 'merge-base-sha',
      nameStatus: 'M\tsrc/auth/login.ts',
      unified: '+++ b/src/auth/login.ts\n@@ -5,3 +5,5 @@\n',
    });

    const result = getChangedSymbols(store, '/proj', { until: 'HEAD' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    // merge-base was invoked to resolve the implicit base
    const mergeBaseCall = mockExec.mock.calls.find((c) => {
      const a = (c[1] ?? []) as string[];
      return a[0] === 'merge-base';
    });
    expect(mergeBaseCall).toBeDefined();
    expect(result.value.since).toBe('merge-base-sha');
  });
});
