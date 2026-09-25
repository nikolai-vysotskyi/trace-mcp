import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpRootOutsideTaskDir } from '../../tests/test-utils.js';

/**
 * GH#1371 edge 3 / TRA-1916: a same-remote clone that shares the canonical
 * checkout's index DB writes its branch's files into the canonical index
 * (the `files` table keys rows by repo-relative path with no branch/commit
 * column — a full-walk `reconcileScope` even deletes canonical-only rows the
 * clone's tree doesn't contain).
 *
 * The intended invariant, pinned here:
 * - registration: a checkout whose commit differs from its same-remote
 *   sibling's gets its own DB instead of sharing (TRA-38 reuse is kept for
 *   same-commit checkouts);
 * - write path: a follower that already shares an owner's DB but sits on a
 *   different commit is served read-only (no index, no watcher) instead of
 *   polluting the owner's index.
 */

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REMOTE = 'https://github.com/acme/widgets.git';

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function write(filePath: string, content: string): void {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Minimal git repo fixture with an `origin` remote. */
function makeGitRepo(
  root: string,
  remoteUrl?: string,
  opts?: { head?: string; refs?: Record<string, string>; packedRefs?: string; noHead?: boolean },
): void {
  mkdirp(root);
  if (!opts?.noHead) {
    write(path.join(root, '.git', 'HEAD'), opts?.head ?? 'ref: refs/heads/main\n');
  }
  write(path.join(root, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
  if (remoteUrl) {
    write(
      path.join(root, '.git', 'config'),
      ['[remote "origin"]', `\turl = ${remoteUrl}`, ''].join('\n'),
    );
  }
  for (const [ref, sha] of Object.entries(opts?.refs ?? {})) {
    write(path.join(root, '.git', ref), `${sha}\n`);
  }
  if (opts?.packedRefs !== undefined) {
    write(path.join(root, '.git', 'packed-refs'), opts.packedRefs);
  }
}

/** Linked-worktree fixture: `.git` file + per-worktree admin dir. */
function makeLinkedWorktree(mainRoot: string, wtPath: string, branch: string, sha: string): void {
  const adminDir = path.join(mainRoot, '.git', 'worktrees', 'wt1');
  mkdirp(wtPath);
  mkdirp(adminDir);
  write(path.join(wtPath, '.git'), `gitdir: ${adminDir}\n`);
  write(path.join(adminDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  write(path.join(adminDir, 'commondir'), '../..\n');
  write(path.join(mainRoot, '.git', `refs/heads/${branch}`), `${sha}\n`);
  write(path.join(wtPath, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
}

describe('shared-DB branch isolation (TRA-1916 / GH#1371 edge 3)', () => {
  let tmpHome: string;
  let tmpProjects: string;
  let globalMod: typeof import('../global.js');
  let registry: typeof import('../registry.js');
  let holders: typeof import('../db-holders.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-branch-home-'));
    // Project fixtures must read as persistent: under a Multica runtime
    // os.tmpdir() itself is a `multica-task-<id>` dir whose roots classify
    // as ephemeral and never reach registry.json.
    tmpProjects = tmpRootOutsideTaskDir('trace-mcp-branch-projects-');
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    globalMod = await import('../global.js');
    registry = await import('../registry.js');
    holders = await import('../db-holders.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProjects, { recursive: true, force: true });
  });

  /** The first checkout's process is gone — its holder no longer blocks sharing. */
  function endRun(dbPath: string, root: string): void {
    holders.releaseDbHolder(dbPath, root);
  }

  describe('getGitHeadFingerprint', () => {
    it('resolves a symbolic HEAD through a loose ref to a sha fingerprint', () => {
      const root = path.join(tmpProjects, 'repo');
      makeGitRepo(root, REMOTE, { refs: { 'refs/heads/main': SHA_A } });
      expect(globalMod.getGitHeadFingerprint(root)).toBe(`sha:${SHA_A}`);
    });

    it('returns the detached HEAD sha directly', () => {
      const root = path.join(tmpProjects, 'detached');
      makeGitRepo(root, REMOTE, { head: `${SHA_B}\n` });
      expect(globalMod.getGitHeadFingerprint(root)).toBe(`sha:${SHA_B}`);
    });

    it('falls back to the ref name when the branch ref has no object yet', () => {
      const root = path.join(tmpProjects, 'fresh');
      makeGitRepo(root, REMOTE);
      expect(globalMod.getGitHeadFingerprint(root)).toBe('ref:refs/heads/main');
    });

    it('resolves a branch from packed-refs', () => {
      const root = path.join(tmpProjects, 'packed');
      makeGitRepo(root, REMOTE, {
        packedRefs: [
          '# pack-refs with: peeled fully-peeled sorted',
          `${SHA_A} refs/heads/main`,
          '',
        ].join('\n'),
      });
      expect(globalMod.getGitHeadFingerprint(root)).toBe(`sha:${SHA_A}`);
    });

    it('resolves a linked worktree HEAD through the shared common dir', () => {
      const main = path.join(tmpProjects, 'main');
      makeGitRepo(main, REMOTE, { refs: { 'refs/heads/main': SHA_A } });
      const wt = path.join(tmpProjects, 'wt1');
      makeLinkedWorktree(main, wt, 'feature', SHA_B);
      expect(globalMod.getGitHeadFingerprint(wt)).toBe(`sha:${SHA_B}`);
      expect(globalMod.getGitHeadFingerprint(main)).toBe(`sha:${SHA_A}`);
    });

    it('returns null for a non-git directory and for an unreadable HEAD', () => {
      const plain = path.join(tmpProjects, 'plain');
      mkdirp(plain);
      expect(globalMod.getGitHeadFingerprint(plain)).toBeNull();
      const noHead = path.join(tmpProjects, 'no-head');
      makeGitRepo(noHead, REMOTE, { noHead: true });
      expect(globalMod.getGitHeadFingerprint(noHead)).toBeNull();
    });
  });

  describe('registerProject — diverged checkouts stay isolated', () => {
    it('gives a same-remote checkout on a different commit its own DB', () => {
      const first = path.join(tmpProjects, 'canonical');
      const second = path.join(tmpProjects, 'clone');
      makeGitRepo(first, REMOTE, { refs: { 'refs/heads/main': SHA_A } });
      makeGitRepo(second, REMOTE, { refs: { 'refs/heads/main': SHA_B } });

      const firstEntry = registry.registerProject(first);
      endRun(firstEntry.dbPath, first);
      const secondEntry = registry.registerProject(second);

      expect(secondEntry.dbPath).not.toBe(firstEntry.dbPath);
      expect(secondEntry.dbPath).toBe(globalMod.getDbPath(second));
      // Identity is still recorded — only the storage is isolated.
      expect(secondEntry.remoteIdentity).toBe('github.com/acme/widgets');
      expect(secondEntry.lastIndexed).toBeNull();
    });

    it('keeps sharing when both checkouts sit on the same commit', () => {
      const first = path.join(tmpProjects, 'canonical');
      const second = path.join(tmpProjects, 'clone');
      makeGitRepo(first, REMOTE, { refs: { 'refs/heads/main': SHA_A } });
      makeGitRepo(second, REMOTE, { refs: { 'refs/heads/main': SHA_A } });

      const firstEntry = registry.registerProject(first);
      endRun(firstEntry.dbPath, first);
      registry.updateLastIndexed(first);
      const secondEntry = registry.registerProject(second);

      expect(secondEntry.dbPath).toBe(firstEntry.dbPath);
      expect(secondEntry.lastIndexed).toBe(registry.getProject(first)!.lastIndexed);
    });

    it('isolates checkouts on different branch names', () => {
      const first = path.join(tmpProjects, 'canonical');
      const second = path.join(tmpProjects, 'clone');
      makeGitRepo(first, REMOTE, { head: 'ref: refs/heads/main\n' });
      makeGitRepo(second, REMOTE, { head: 'ref: refs/heads/feature\n' });

      const firstEntry = registry.registerProject(first);
      endRun(firstEntry.dbPath, first);
      const secondEntry = registry.registerProject(second);

      expect(secondEntry.dbPath).toBe(globalMod.getDbPath(second));
    });

    it('still reuses a missing sibling checkout\u2019s DB (ephemeral win)', () => {
      const first = path.join(tmpProjects, 'run-1');
      const second = path.join(tmpProjects, 'run-2');
      makeGitRepo(first, REMOTE);
      makeGitRepo(second, REMOTE);

      const firstEntry = registry.registerProject(first);
      endRun(firstEntry.dbPath, first);
      fs.rmSync(first, { recursive: true, force: true });

      const secondEntry = registry.registerProject(second);
      expect(secondEntry.dbPath).toBe(firstEntry.dbPath);
    });

    it('isolates when a live sibling\u2019s HEAD is unreadable (fail safe)', () => {
      const first = path.join(tmpProjects, 'canonical');
      const second = path.join(tmpProjects, 'clone');
      makeGitRepo(first, REMOTE, { refs: { 'refs/heads/main': SHA_A } });
      makeGitRepo(second, REMOTE, { noHead: true });

      const firstEntry = registry.registerProject(first);
      endRun(firstEntry.dbPath, first);
      const secondEntry = registry.registerProject(second);

      expect(secondEntry.dbPath).toBe(globalMod.getDbPath(second));
    });
  });

  describe('shouldServeSharedDbReadOnly — diverged followers serve read-only', () => {
    function registerSharingPair(): { first: string; second: string; dbPath: string } {
      const first = path.join(tmpProjects, 'canonical');
      const second = path.join(tmpProjects, 'clone');
      makeGitRepo(first, REMOTE, { refs: { 'refs/heads/main': SHA_A } });
      makeGitRepo(second, REMOTE, { refs: { 'refs/heads/main': SHA_A } });
      const firstEntry = registry.registerProject(first);
      endRun(firstEntry.dbPath, first);
      const secondEntry = registry.registerProject(second);
      expect(secondEntry.dbPath).toBe(firstEntry.dbPath);
      return { first, second, dbPath: firstEntry.dbPath };
    }

    it('lets the owner write and a matching follower write', () => {
      const { first, second, dbPath } = registerSharingPair();
      expect(registry.findSharedDbOwner(dbPath)?.root).toBe(first);
      expect(registry.shouldServeSharedDbReadOnly(first, dbPath)).toEqual({
        readOnly: false,
        owner: null,
        reason: null,
      });
      expect(registry.shouldServeSharedDbReadOnly(second, dbPath)).toEqual({
        readOnly: false,
        owner: null,
        reason: null,
      });
    });

    it('serves a diverged follower read-only, naming the owner', () => {
      const { first, second, dbPath } = registerSharingPair();
      // The clone moves to another commit after sharing (the GH#1371 shape).
      write(path.join(second, '.git', 'refs', 'heads', 'main'), `${SHA_B}\n`);

      const verdict = registry.shouldServeSharedDbReadOnly(second, dbPath);
      expect(verdict.readOnly).toBe(true);
      expect(verdict.owner?.root).toBe(first);
      expect(verdict.reason).toContain('different commit');

      // The owner is unaffected.
      expect(registry.shouldServeSharedDbReadOnly(first, dbPath).readOnly).toBe(false);
    });

    it('leaves a sole project writable and a dead owner out of the verdict', () => {
      const solo = path.join(tmpProjects, 'solo');
      makeGitRepo(solo, 'https://github.com/org/solo.git');
      const entry = registry.registerProject(solo);
      expect(registry.shouldServeSharedDbReadOnly(solo, entry.dbPath).readOnly).toBe(false);

      const { first, second, dbPath } = registerSharingPair();
      write(path.join(second, '.git', 'refs', 'heads', 'main'), `${SHA_B}\n`);
      expect(registry.shouldServeSharedDbReadOnly(second, dbPath).readOnly).toBe(true);
      // The owner goes missing: no positive proof of divergence remains.
      fs.rmSync(first, { recursive: true, force: true });
      expect(registry.shouldServeSharedDbReadOnly(second, dbPath)).toEqual({
        readOnly: false,
        owner: null,
        reason: null,
      });
    });
  });
});
