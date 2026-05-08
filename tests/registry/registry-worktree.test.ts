import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY_PATH } from '../../src/global.js';
import { resolveWorktreeAware, worktreeHint } from '../../src/registry-worktree.js';
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

let tmpDir: string;
let savedRegistry: string | null;

function writeRegistryProjects(projects: Record<string, { root: string; name: string }>): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  const reg = {
    version: 1,
    projects: Object.fromEntries(
      Object.entries(projects).map(([key, p]) => [
        key,
        {
          name: p.name,
          root: p.root,
          dbPath: path.join(p.root, '.trace-mcp', 'index.db'),
          lastIndexed: null,
          addedAt: new Date().toISOString(),
        },
      ]),
    ),
  };
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

describe('resolveWorktreeAware', () => {
  beforeEach(() => {
    tmpDir = createTmpDir('registry-worktree-');
    savedRegistry = fs.existsSync(REGISTRY_PATH) ? fs.readFileSync(REGISTRY_PATH, 'utf-8') : null;
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
    if (savedRegistry !== null) {
      fs.writeFileSync(REGISTRY_PATH, savedRegistry);
    } else if (fs.existsSync(REGISTRY_PATH)) {
      fs.rmSync(REGISTRY_PATH);
    }
    savedRegistry = null;
  });

  it('returns direct match without probing when path is registered', () => {
    const project = path.join(tmpDir, 'my-project');
    fs.mkdirSync(project);
    writeRegistryProjects({
      [project]: { root: project, name: 'my-project' },
    });

    const result = resolveWorktreeAware(project);
    expect(result.direct).toBeTruthy();
    expect(result.direct?.name).toBe('my-project');
    expect(result.isLinkedWorktree).toBe(false);
    expect(result.canonicalCandidates).toHaveLength(0);
  });

  it('returns no canonical candidates for a path not inside a git work-tree', () => {
    const path1 = path.join(tmpDir, 'not-a-repo');
    fs.mkdirSync(path1);

    const result = resolveWorktreeAware(path1);
    expect(result.direct).toBeNull();
    expect(result.isLinkedWorktree).toBe(false);
    expect(result.canonicalCandidates).toHaveLength(0);
  });

  it('finds a canonical candidate when the requested path is a linked worktree of a registered repo', () => {
    // Set up a main repo + register it
    const main = path.join(tmpDir, 'main');
    fs.mkdirSync(main);
    runGit(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'README.md'), '# main\n');
    runGit(main, 'add', '.');
    runGit(main, 'commit', '-q', '-m', 'init');

    writeRegistryProjects({
      [main]: { root: main, name: 'main-repo' },
    });

    // Create a linked worktree (NOT registered)
    const linked = path.join(tmpDir, 'wt-feature');
    runGit(main, 'worktree', 'add', '-q', '-b', 'feature', linked);

    const result = resolveWorktreeAware(linked);
    expect(result.direct).toBeNull(); // worktree itself isn't registered
    expect(result.isLinkedWorktree).toBe(true);
    expect(result.canonicalCandidates).toHaveLength(1);
    expect(result.canonicalCandidates[0].entry.name).toBe('main-repo');
    expect(result.canonicalCandidates[0].rationale).toBe('main_worktree_match');
  });

  it('does not propose candidates when the requested path IS the main worktree', () => {
    const main = path.join(tmpDir, 'main');
    fs.mkdirSync(main);
    runGit(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'f.txt'), 'x');
    runGit(main, 'add', '.');
    runGit(main, 'commit', '-q', '-m', 'init');

    // Register a sibling linked worktree but query the main itself
    const linked = path.join(tmpDir, 'wt-feature');
    runGit(main, 'worktree', 'add', '-q', '-b', 'feature', linked);

    writeRegistryProjects({
      [linked]: { root: linked, name: 'linked-feature' },
    });

    const result = resolveWorktreeAware(main);
    // Main worktree must not be flagged as linkedWorktree, even when a
    // sibling is registered. Otherwise we'd nag every operator who runs
    // out of the main checkout.
    expect(result.isLinkedWorktree).toBe(false);
  });

  it('returns no candidates when no registered project shares the common-dir', () => {
    // Two separate independent repos. Worktree of repo-A shouldn't suggest repo-B.
    const repoA = path.join(tmpDir, 'a');
    const repoB = path.join(tmpDir, 'b');
    for (const r of [repoA, repoB]) {
      fs.mkdirSync(r);
      runGit(r, 'init', '-q');
      fs.writeFileSync(path.join(r, 'f.txt'), 'x');
      runGit(r, 'add', '.');
      runGit(r, 'commit', '-q', '-m', 'init');
    }
    writeRegistryProjects({ [repoB]: { root: repoB, name: 'b' } });

    const linkedOfA = path.join(tmpDir, 'a-feature');
    runGit(repoA, 'worktree', 'add', '-q', '-b', 'feature', linkedOfA);

    const result = resolveWorktreeAware(linkedOfA);
    expect(result.isLinkedWorktree).toBe(true);
    expect(result.canonicalCandidates).toHaveLength(0);
  });

  it('worktreeHint returns null when no candidates', () => {
    expect(
      worktreeHint({
        direct: null,
        isLinkedWorktree: false,
        canonicalCandidates: [],
        probe: null,
      }),
    ).toBeNull();
  });

  it('worktreeHint surfaces the canonical name when candidates exist', () => {
    const main = path.join(tmpDir, 'main');
    fs.mkdirSync(main);
    runGit(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'f.txt'), 'x');
    runGit(main, 'add', '.');
    runGit(main, 'commit', '-q', '-m', 'init');
    writeRegistryProjects({ [main]: { root: main, name: 'canonical-main' } });

    const linked = path.join(tmpDir, 'wt');
    runGit(main, 'worktree', 'add', '-q', '-b', 'feature', linked);

    const result = resolveWorktreeAware(linked);
    const hint = worktreeHint(result);
    expect(hint).toBeTruthy();
    expect(hint).toContain('canonical-main');
    expect(hint).toContain('worktree');
  });
});
