import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeWorktree, sharesGitCommonDir } from '../../src/utils/git-worktree.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

function runGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

describe('probeWorktree', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('worktree-probe-');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('returns NULL_PROBE for a non-git path', () => {
    const probe = probeWorktree(tmpDir);
    expect(probe.isInsideWorkTree).toBe(false);
    expect(probe.commonDir).toBeNull();
  });

  it('returns NULL_PROBE for a non-existent path', () => {
    const probe = probeWorktree(path.join(tmpDir, 'does-not-exist'));
    expect(probe.isInsideWorkTree).toBe(false);
    expect(probe.commonDir).toBeNull();
  });

  it('detects the main worktree of a regular repo', () => {
    const repo = path.join(tmpDir, 'main-repo');
    fs.mkdirSync(repo);
    runGit(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-q', '-m', 'init');

    const probe = probeWorktree(repo);
    expect(probe.isInsideWorkTree).toBe(true);
    expect(probe.isLinkedWorktree).toBe(false);
    expect(probe.commonDir).toBeTruthy();
    expect(path.basename(probe.commonDir!)).toBe('.git');
    expect(probe.mainWorktreePath).toBe(fs.realpathSync(repo));
  });

  it('detects a linked worktree as such, with the same commonDir as main', () => {
    const main = path.join(tmpDir, 'main');
    fs.mkdirSync(main);
    runGit(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'README.md'), '# test\n');
    runGit(main, 'add', '.');
    runGit(main, 'commit', '-q', '-m', 'init');

    const linked = path.join(tmpDir, 'linked');
    runGit(main, 'worktree', 'add', '-q', '-b', 'feature', linked);

    const mainProbe = probeWorktree(main);
    const linkedProbe = probeWorktree(linked);

    expect(mainProbe.isInsideWorkTree).toBe(true);
    expect(mainProbe.isLinkedWorktree).toBe(false);
    expect(linkedProbe.isInsideWorkTree).toBe(true);
    expect(linkedProbe.isLinkedWorktree).toBe(true);

    // Linked and main MUST share the same common-dir
    expect(linkedProbe.commonDir).toBe(mainProbe.commonDir);
    // mainWorktreePath should resolve to the main checkout for both
    expect(linkedProbe.mainWorktreePath).toBe(mainProbe.mainWorktreePath);
  });
});

describe('sharesGitCommonDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('shares-git-common-');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('returns false for two unrelated paths', () => {
    expect(sharesGitCommonDir(tmpDir, path.join(tmpDir, 'nope'))).toBe(false);
  });

  it('returns true for main + its linked worktree', () => {
    const main = path.join(tmpDir, 'main');
    fs.mkdirSync(main);
    runGit(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'README.md'), '# test\n');
    runGit(main, 'add', '.');
    runGit(main, 'commit', '-q', '-m', 'init');

    const linked = path.join(tmpDir, 'linked');
    runGit(main, 'worktree', 'add', '-q', '-b', 'feature', linked);

    expect(sharesGitCommonDir(main, linked)).toBe(true);
  });

  it('returns false for two independent repos', () => {
    const repoA = path.join(tmpDir, 'a');
    const repoB = path.join(tmpDir, 'b');
    for (const r of [repoA, repoB]) {
      fs.mkdirSync(r);
      runGit(r, 'init', '-q');
      fs.writeFileSync(path.join(r, 'f.txt'), 'x');
      runGit(r, 'add', '.');
      runGit(r, 'commit', '-q', '-m', 'init');
    }

    expect(sharesGitCommonDir(repoA, repoB)).toBe(false);
  });
});
