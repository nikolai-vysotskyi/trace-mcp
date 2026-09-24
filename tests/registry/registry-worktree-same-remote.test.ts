/**
 * GH#1371 / TRA-1881: worktrees of a *bare* mirror never share a common-dir
 * with the canonical checkout, so `resolveWorktreeAware` must fall back to
 * git remote identity (the same signal TRA-38 registration uses) instead of
 * cold-indexing the short-lived checkout from scratch.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY_PATH } from '../../src/global.js';
import { resolveWorktreeAware, worktreeHint } from '../../src/registry-worktree.js';
import { probeWorktree } from '../../src/utils/git-worktree.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

const REMOTE_URL = 'https://github.com/org/bare-mirror-fixture.git';

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

function writeRegistryProjects(
  projects: Record<string, { root: string; name: string; remoteIdentity?: string }>,
): void {
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
          ...(p.remoteIdentity ? { remoteIdentity: p.remoteIdentity } : {}),
        },
      ]),
    ),
  };
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

/** Canonical checkout: normal repo whose origin is the shared remote. */
function makeCanonical(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  runGit(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# canonical\n');
  runGit(dir, 'add', '.');
  runGit(dir, 'commit', '-q', '-m', 'init');
  runGit(dir, 'remote', 'add', 'origin', REMOTE_URL);
}

/** Bare mirror of `source` whose origin is rewritten to the shared remote. */
function makeBareMirror(barePath: string, source: string, cwd: string): void {
  runGit(cwd, 'clone', '-q', '--bare', source, barePath);
  runGit(cwd, '--git-dir', barePath, 'remote', 'set-url', 'origin', REMOTE_URL);
}

let tmpDir: string;
let savedRegistry: string | null;

beforeEach(() => {
  const realpath: (p: string) => string =
    typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync;
  tmpDir = realpath(createTmpDir('registry-worktree-bare-'));
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

describe('resolveWorktreeAware same-remote fallback (TRA-1881)', () => {
  it('routes a bare-mirror worktree to the canonical checkout via remote identity', () => {
    const canonical = path.join(tmpDir, 'canonical');
    makeCanonical(canonical);
    writeRegistryProjects({ [canonical]: { root: canonical, name: 'canonical' } });

    const bare = path.join(tmpDir, 'mirror.git');
    makeBareMirror(bare, canonical, tmpDir);
    const wt = path.join(tmpDir, 'wt-run-1');
    runGit(tmpDir, '--git-dir', bare, 'worktree', 'add', '-q', '--detach', wt);

    // Sanity: the common dirs really do differ (bare mirror vs checkout),
    // so only the remote-identity fallback can match here.
    const wtProbe = probeWorktree(wt);
    const canonicalProbe = probeWorktree(canonical);
    expect(wtProbe.isLinkedWorktree).toBe(true);
    expect(wtProbe.commonDir).toBeTruthy();
    expect(canonicalProbe.commonDir).toBeTruthy();
    expect(wtProbe.commonDir).not.toBe(canonicalProbe.commonDir);

    const result = resolveWorktreeAware(wt);
    expect(result.direct).toBeNull();
    expect(result.canonicalCandidates).toHaveLength(1);
    expect(result.canonicalCandidates[0].entry.name).toBe('canonical');
    expect(result.canonicalCandidates[0].rationale).toBe('same_remote');

    const hint = worktreeHint(result);
    expect(hint).toBeTruthy();
    expect(hint).toContain('canonical');
  });

  it('does not route to a deleted-dir ("Missing folder") row with a cached remote identity', () => {
    const canonical = path.join(tmpDir, 'canonical');
    makeCanonical(canonical);

    const bare = path.join(tmpDir, 'mirror.git');
    makeBareMirror(bare, canonical, tmpDir);
    const wt = path.join(tmpDir, 'wt-run-1');
    runGit(tmpDir, '--git-dir', bare, 'worktree', 'add', '-q', '--detach', wt);

    // Registry holds only a dead row: directory gone (with its parent, so
    // boot self-heal never pruned it), but the cached remoteIdentity matches.
    const deadRoot = path.join(tmpDir, 'deleted-canonical');
    writeRegistryProjects({
      [deadRoot]: {
        root: deadRoot,
        name: 'deleted-canonical',
        remoteIdentity: 'github.com/org/bare-mirror-fixture',
      },
    });
    expect(fs.existsSync(deadRoot)).toBe(false);

    const result = resolveWorktreeAware(wt);
    expect(result.canonicalCandidates).toHaveLength(0);
  });

  it('does not route when remotes differ', () => {
    const canonical = path.join(tmpDir, 'canonical');
    makeCanonical(canonical);
    writeRegistryProjects({ [canonical]: { root: canonical, name: 'canonical' } });

    const other = path.join(tmpDir, 'other.git');
    makeBareMirror(other, canonical, tmpDir);
    runGit(
      tmpDir,
      '--git-dir',
      other,
      'remote',
      'set-url',
      'origin',
      'https://github.com/org/other.git',
    );
    const wt = path.join(tmpDir, 'wt-other');
    runGit(tmpDir, '--git-dir', other, 'worktree', 'add', '-q', '--detach', wt);

    const result = resolveWorktreeAware(wt);
    expect(result.canonicalCandidates).toHaveLength(0);
  });
});
