import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectGitWorktree, } from '../../src/project-root.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function write(filePath: string, content: string): void {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-worktree-'));
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Create a minimal "main" repo with a real .git directory and package.json.
 * Returns the repo root.
 */
function makeMainRepo(base: string): string {
  const root = path.join(base, 'main-repo');
  mkdirp(path.join(root, '.git', 'worktrees'));
  write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(root, 'package.json'), '{"name":"main"}');
  return root;
}

/**
 * Create a linked worktree at `base/worktrees/<name>` that points back to
 * the main repo.  Returns the worktree root.
 */
function makeLinkedWorktree(mainRoot: string, base: string, name: string): string {
  const wtRoot = path.join(base, 'worktrees', name);
  const adminDir = path.join(mainRoot, '.git', 'worktrees', name);

  mkdirp(wtRoot);
  mkdirp(adminDir);

  // The worktree's .git file points to the admin dir
  write(path.join(wtRoot, '.git'), `gitdir: ${adminDir}\n`);
  // package.json so findProjectRoot stops here
  write(path.join(wtRoot, 'package.json'), '{"name":"worktree"}');

  // Admin dir: commondir points to main .git (relative)
  const relCommondir = path.relative(adminDir, path.join(mainRoot, '.git'));
  write(path.join(adminDir, 'commondir'), relCommondir + '\n');
  write(path.join(adminDir, 'gitdir'), path.join(wtRoot, '.git') + '\n');

  return wtRoot;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectGitWorktree', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for a normal repo (no worktree)', () => {
    const mainRoot = makeMainRepo(tmpDir);
    expect(detectGitWorktree(mainRoot)).toBeNull();
  });

  it('returns null when no .git entry exists', () => {
    const dir = path.join(tmpDir, 'empty');
    mkdirp(dir);
    expect(detectGitWorktree(dir)).toBeNull();
  });

  it('detects a linked worktree and returns the main repo root', () => {
    const mainRoot = makeMainRepo(tmpDir);
    const wtRoot = makeLinkedWorktree(mainRoot, tmpDir, 'feature-x');

    const info = detectGitWorktree(wtRoot);
    expect(info).not.toBeNull();
    expect(info!.mainRoot).toBe(mainRoot);
  });

  it('detects worktree from a subdirectory inside it', () => {
    const mainRoot = makeMainRepo(tmpDir);
    const wtRoot = makeLinkedWorktree(mainRoot, tmpDir, 'feat-sub');

    const subDir = path.join(wtRoot, 'src', 'controllers');
    mkdirp(subDir);

    const info = detectGitWorktree(subDir);
    expect(info).not.toBeNull();
    expect(info!.mainRoot).toBe(mainRoot);
  });

  it('handles absolute path in commondir', () => {
    const mainRoot = makeMainRepo(tmpDir);
    const wtRoot = path.join(tmpDir, 'worktrees', 'abs-test');
    const adminDir = path.join(mainRoot, '.git', 'worktrees', 'abs-test');

    mkdirp(wtRoot);
    mkdirp(adminDir);
    write(path.join(wtRoot, '.git'), `gitdir: ${adminDir}\n`);
    write(path.join(wtRoot, 'package.json'), '{"name":"wt"}');

    // Use absolute path in commondir
    write(path.join(adminDir, 'commondir'), path.join(mainRoot, '.git') + '\n');

    const info = detectGitWorktree(wtRoot);
    expect(info).not.toBeNull();
    expect(info!.mainRoot).toBe(mainRoot);
  });

  it('returns null when commondir is missing and fallback .git is not a dir', () => {
    // Malformed worktree: admin dir exists but no commondir, and ../.. is not a real .git
    const wtRoot = path.join(tmpDir, 'bad-wt');
    const adminDir = path.join(tmpDir, 'fake-admin', 'worktrees', 'x');
    mkdirp(wtRoot);
    mkdirp(adminDir);
    write(path.join(wtRoot, '.git'), `gitdir: ${adminDir}\n`);
    write(path.join(wtRoot, 'package.json'), '{}');
    // No commondir, and tmpDir/fake-admin/.git doesn't exist

    const info = detectGitWorktree(wtRoot);
    expect(info).toBeNull();
  });

  it('returns null when .git file has unexpected content', () => {
    const dir = path.join(tmpDir, 'weird');
    mkdirp(dir);
    write(path.join(dir, '.git'), 'not a gitdir line\n');
    write(path.join(dir, 'package.json'), '{}');

    expect(detectGitWorktree(dir)).toBeNull();
  });
});
