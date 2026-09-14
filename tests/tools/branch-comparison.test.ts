import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { compareBranches } from '../../src/tools/quality/changed-symbols.js';
import { contentHash, initContentHasher } from '../../src/util/hash.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';

describe('compareBranches', () => {
  let store: Store;
  let repoDir: string;

  beforeEach(async () => {
    store = createTestStore();
    await initContentHasher();

    // Create a temporary git repo with two branches
    repoDir = createTmpDir('branch-compare-');
    const run = (cmd: string) =>
      execSync(cmd, {
        cwd: repoDir,
        encoding: 'utf-8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
        },
      });

    // Init repo with main branch
    run('git init -b main');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });

    // Initial file on main
    fs.writeFileSync(
      path.join(repoDir, 'src/auth.ts'),
      [
        'export function login(email: string) {',
        '  return findUser(email);',
        '}',
        '',
        'export function logout() {',
        '  clearSession();',
        '}',
      ].join('\n'),
    );
    run('git add -A');
    run('git commit -m "initial"');

    // Create feature branch with changes
    run('git checkout -b feature/auth-upgrade');

    // Modify login function
    const upgradedAuthContent = [
      'export function login(email: string, password: string) {',
      '  const user = findUser(email);',
      '  return verify(password, user.hash);',
      '}',
      '',
      'export function logout() {',
      '  clearSession();',
      '}',
      '',
      'export function register(email: string) {',
      '  return createUser(email);',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(repoDir, 'src/auth.ts'), upgradedAuthContent);

    // Add a new file
    fs.writeFileSync(
      path.join(repoDir, 'src/mfa.ts'),
      ['export function enableMfa(userId: string) {', '  return generateSecret(userId);', '}'].join(
        '\n',
      ),
    );

    run('git add -A');
    run('git commit -m "upgrade auth"');

    // Index the tree as it stands on the feature branch — the tip we're
    // about to diff against (`until`). content_hash must match that blob for
    // the freshness gate in getChangedSymbols/compareBranches to join it;
    // using the pre-upgrade content here would reproduce the exact stale-span
    // bug (TRA-1075) this gate exists to catch.
    const fileId = store.insertFile(
      'src/auth.ts',
      'typescript',
      contentHash(Buffer.from(upgradedAuthContent)),
      200,
    );
    store.insertSymbol(fileId, {
      symbolId: 'src/auth.ts::login#function',
      name: 'login',
      kind: 'function',
      fqn: 'login',
      byteStart: 0,
      byteEnd: 60,
      lineStart: 1,
      lineEnd: 4,
    });
    store.insertSymbol(fileId, {
      symbolId: 'src/auth.ts::logout#function',
      name: 'logout',
      kind: 'function',
      fqn: 'logout',
      byteStart: 62,
      byteEnd: 100,
      lineStart: 6,
      lineEnd: 8,
    });
    store.insertSymbol(fileId, {
      symbolId: 'src/auth.ts::register#function',
      name: 'register',
      kind: 'function',
      fqn: 'register',
      byteStart: 102,
      byteEnd: 140,
      lineStart: 10,
      lineEnd: 12,
    });
  }, 60_000);

  afterEach(() => {
    removeTmpDir(repoDir);
  }, 30_000);

  it('resolves merge-base and returns branch comparison', async () => {
    const result = await compareBranches(store, repoDir, {
      branch: 'feature/auth-upgrade',
      base: 'main',
      includeBlastRadius: false,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.branch).toBe('feature/auth-upgrade');
    expect(data.base).toBe('main');
    expect(data.mergeBase).toBeTruthy();
    expect(data.commitCount).toBe(1);
    expect(data.changedFiles).toBeGreaterThan(0);
    expect(data.staleFiles).toEqual([]);
  });

  it('groups by category by default', async () => {
    const result = await compareBranches(store, repoDir, {
      branch: 'feature/auth-upgrade',
      base: 'main',
      includeBlastRadius: false,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    // grouped should have changeKind keys
    const groupKeys = Object.keys(data.grouped);
    expect(groupKeys.length).toBeGreaterThan(0);
    for (const key of groupKeys) {
      expect(['added', 'modified', 'removed', 'renamed']).toContain(key);
    }
  });

  it('groups by file when requested', async () => {
    const result = await compareBranches(store, repoDir, {
      branch: 'feature/auth-upgrade',
      base: 'main',
      includeBlastRadius: false,
      groupBy: 'file',
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    // Group keys should be file paths
    for (const key of Object.keys(data.grouped)) {
      expect(key).toContain('/'); // file paths contain slashes
    }
  });

  it('includes risk assessment with blast radius', async () => {
    const result = await compareBranches(store, repoDir, {
      branch: 'feature/auth-upgrade',
      base: 'main',
      includeBlastRadius: true,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.riskAssessment).toBeDefined();
    expect(Array.isArray(data.riskAssessment)).toBe(true);
  });

  it('returns error for non-existent branch', async () => {
    const result = await compareBranches(store, repoDir, {
      branch: 'nonexistent-branch',
      base: 'main',
    });

    expect(result.isErr()).toBe(true);
  });

  it('includes summary counts', async () => {
    const result = await compareBranches(store, repoDir, {
      branch: 'feature/auth-upgrade',
      base: 'main',
      includeBlastRadius: false,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.summary).toBeDefined();
    expect(typeof data.summary.added).toBe('number');
    expect(typeof data.summary.modified).toBe('number');
    expect(typeof data.summary.removed).toBe('number');
  });

  // --- Freshness gate (TRA-1075) ---
  it('excludes the file and reports staleFiles when the index was built against a different tree', async () => {
    // Simulate the exact bug: index recorded spans for the *pre-upgrade*
    // main content, but we diff against the feature branch tip. The blob at
    // `until` no longer matches content_hash, so auth.ts must be excluded
    // rather than joined against spans that shifted (login moved from lines
    // 1-3 to 1-4, logout from 5-7 to 6-8).
    const staleFileId = store.insertFile(
      'src/stale.ts',
      'typescript',
      contentHash(Buffer.from('this content never existed in the repo')),
      50,
    );
    store.insertSymbol(staleFileId, {
      symbolId: 'src/stale.ts::whatever#function',
      name: 'whatever',
      kind: 'function',
      fqn: 'whatever',
      byteStart: 0,
      byteEnd: 20,
      lineStart: 1,
      lineEnd: 1,
    });
    fs.writeFileSync(path.join(repoDir, 'src/stale.ts'), 'export function whatever() {}\n');
    execSync('git add -A && git commit -m "add stale.ts"', {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    const result = await compareBranches(store, repoDir, {
      branch: 'feature/auth-upgrade',
      base: 'main',
      includeBlastRadius: false,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.staleFiles).toContain('src/stale.ts');
    expect(data.changedSymbols.some((s) => s.file === 'src/stale.ts')).toBe(false);
    // auth.ts was indexed with a matching hash — still resolves normally.
    expect(data.changedSymbols.some((s) => s.file === 'src/auth.ts')).toBe(true);
  });
});
