import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { compareBranches } from '../../src/tools/changed-symbols.js';

describe('compareBranches', () => {
  let store: Store;
  let repoDir: string;

  beforeEach(() => {
    const db = initializeDatabase(':memory:');
    store = new Store(db);

    // Create a temporary git repo with two branches
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-compare-'));
    const run = (cmd: string) =>
      execSync(cmd, { cwd: repoDir, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' } });

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

    // Index the base file
    const fileId = store.insertFile('src/auth.ts', 'typescript', 'h1', 200);
    store.insertSymbol(fileId, {
      symbolId: 'src/auth.ts::login#function',
      name: 'login',
      kind: 'function',
      fqn: 'login',
      byteStart: 0,
      byteEnd: 60,
      lineStart: 1,
      lineEnd: 3,
    });
    store.insertSymbol(fileId, {
      symbolId: 'src/auth.ts::logout#function',
      name: 'logout',
      kind: 'function',
      fqn: 'logout',
      byteStart: 62,
      byteEnd: 100,
      lineStart: 5,
      lineEnd: 7,
    });

    // Create feature branch with changes
    run('git checkout -b feature/auth-upgrade');

    // Modify login function
    fs.writeFileSync(
      path.join(repoDir, 'src/auth.ts'),
      [
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
      ].join('\n'),
    );

    // Add a new file
    fs.writeFileSync(
      path.join(repoDir, 'src/mfa.ts'),
      [
        'export function enableMfa(userId: string) {',
        '  return generateSecret(userId);',
        '}',
      ].join('\n'),
    );

    run('git add -A');
    run('git commit -m "upgrade auth"');
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('resolves merge-base and returns branch comparison', () => {
    const result = compareBranches(store, repoDir, {
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
  });

  it('groups by category by default', () => {
    const result = compareBranches(store, repoDir, {
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

  it('groups by file when requested', () => {
    const result = compareBranches(store, repoDir, {
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

  it('includes risk assessment with blast radius', () => {
    const result = compareBranches(store, repoDir, {
      branch: 'feature/auth-upgrade',
      base: 'main',
      includeBlastRadius: true,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.riskAssessment).toBeDefined();
    expect(Array.isArray(data.riskAssessment)).toBe(true);
  });

  it('returns error for non-existent branch', () => {
    const result = compareBranches(store, repoDir, {
      branch: 'nonexistent-branch',
      base: 'main',
    });

    expect(result.isErr()).toBe(true);
  });

  it('includes summary counts', () => {
    const result = compareBranches(store, repoDir, {
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
});
