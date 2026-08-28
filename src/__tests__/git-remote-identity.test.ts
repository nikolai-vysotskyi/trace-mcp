import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TRA-38: project identity in trace-mcp used to be the raw, exact absolute
 * filesystem path — nothing else. Any workflow that checks out the same
 * logical repo to a fresh path repeatedly (most notably Multica's own
 * `repo checkout <url>`, which lands every run under a brand-new per-run
 * ephemeral directory) resolved to a different path hash every time, so each
 * run spawned a brand-new registry entry + brand-new DB + full reindex,
 * orphaning the previous checkout's entry. That's the root cause behind the
 * TRA-35 registry duplication bug (13x/7x/7x duplicate entries observed).
 *
 * These tests pin the fix: a project root whose git `origin` remote matches
 * an already-registered *different* root reuses that root's dbPath (and
 * inherited lastIndexed) instead of building a new index — while a project
 * with no resolvable git remote (non-git, or no `origin` configured) keeps
 * behaving exactly as before this feature existed.
 */

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function write(filePath: string, content: string): void {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Create a minimal git repo at `root`, optionally with an `origin` remote. */
function makeGitRepo(root: string, remoteUrl?: string): void {
  mkdirp(root);
  mkdirp(path.join(root, '.git'));
  write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(root, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
  if (remoteUrl) {
    write(
      path.join(root, '.git', 'config'),
      [
        '[core]',
        '\trepositoryformatversion = 0',
        '[remote "origin"]',
        `\turl = ${remoteUrl}`,
        '\tfetch = +refs/heads/*:refs/remotes/origin/*',
        '',
      ].join('\n'),
    );
  }
}

describe('git remote identity (TRA-38)', () => {
  let tmpHome: string;
  let tmpProjects: string;
  let globalMod: typeof import('../global.js');
  let registry: typeof import('../registry.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-identity-home-'));
    tmpProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-identity-projects-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    globalMod = await import('../global.js');
    registry = await import('../registry.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProjects, { recursive: true, force: true });
  });

  describe('normalizeGitRemote', () => {
    it('normalizes https, ssh, and scp-like URLs to the same canonical form', () => {
      const expected = 'github.com/nikolai-vysotskyi/trace-mcp';
      expect(
        globalMod.normalizeGitRemote('https://github.com/nikolai-vysotskyi/trace-mcp.git'),
      ).toBe(expected);
      expect(globalMod.normalizeGitRemote('https://github.com/nikolai-vysotskyi/trace-mcp')).toBe(
        expected,
      );
      expect(globalMod.normalizeGitRemote('git@github.com:nikolai-vysotskyi/trace-mcp.git')).toBe(
        expected,
      );
      expect(
        globalMod.normalizeGitRemote('ssh://git@github.com/nikolai-vysotskyi/trace-mcp.git'),
      ).toBe(expected);
      expect(globalMod.normalizeGitRemote('https://GitHub.com/nikolai-vysotskyi/trace-mcp/')).toBe(
        expected,
      );
    });

    it('returns null for a local filesystem path used as a remote', () => {
      expect(globalMod.normalizeGitRemote('/Users/foo/bare-repo.git')).toBeNull();
      expect(globalMod.normalizeGitRemote('../sibling-repo')).toBeNull();
    });

    it('treats different repos as different identities', () => {
      const a = globalMod.normalizeGitRemote('https://github.com/org/repo-a.git');
      const b = globalMod.normalizeGitRemote('https://github.com/org/repo-b.git');
      expect(a).not.toBe(b);
    });
  });

  describe('getProjectRemoteIdentity', () => {
    it('reads the origin remote from .git/config', () => {
      const root = path.join(tmpProjects, 'repo-with-remote');
      makeGitRepo(root, 'git@github.com:acme/widgets.git');
      expect(globalMod.getProjectRemoteIdentity(root)).toBe('github.com/acme/widgets');
    });

    it('returns null for a git repo with no remote configured', () => {
      const root = path.join(tmpProjects, 'repo-no-remote');
      makeGitRepo(root);
      expect(globalMod.getProjectRemoteIdentity(root)).toBeNull();
    });

    it('returns null for a non-git directory', () => {
      const root = path.join(tmpProjects, 'plain-dir');
      mkdirp(root);
      expect(globalMod.getProjectRemoteIdentity(root)).toBeNull();
    });
  });

  describe('registerProject — dbPath reuse across checkouts of the same remote', () => {
    it("reuses the first checkout's dbPath + lastIndexed for a second checkout of the same remote", () => {
      const remote = 'https://github.com/nikolai-vysotskyi/trace-mcp.git';
      const first = path.join(tmpProjects, 'run-1', 'workdir');
      const second = path.join(tmpProjects, 'run-2', 'workdir');
      makeGitRepo(first, remote);
      makeGitRepo(second, remote);

      const firstEntry = registry.registerProject(first);
      registry.updateLastIndexed(first);
      const firstIndexed = registry.getProject(first)!.lastIndexed;
      expect(firstIndexed).not.toBeNull();

      const secondEntry = registry.registerProject(second);

      expect(secondEntry.dbPath).toBe(firstEntry.dbPath);
      expect(secondEntry.lastIndexed).toBe(firstIndexed);
      expect(secondEntry.remoteIdentity).toBe('github.com/nikolai-vysotskyi/trace-mcp');

      // Both remain independently registered by their literal path — the
      // registry must still support "this literal path is registered".
      expect(registry.getProject(first)?.root).toBe(first);
      expect(registry.getProject(second)?.root).toBe(second);
      expect(registry.listProjects()).toHaveLength(2);
    });

    it('reuses the sibling even when it predates the remoteIdentity cache field (pre-TRA-38 entry)', () => {
      const remote = 'https://github.com/acme/legacy.git';
      const first = path.join(tmpProjects, 'legacy-checkout');
      makeGitRepo(first, remote);
      const firstEntry = registry.registerProject(first);

      // Simulate an entry that was written by a pre-TRA-38 build: no
      // `remoteIdentity` field cached on disk, only derivable live from its
      // .git/config (which the checkout above still has).
      const raw = JSON.parse(fs.readFileSync(globalMod.REGISTRY_PATH, 'utf-8'));
      delete raw.projects[first].remoteIdentity;
      fs.writeFileSync(globalMod.REGISTRY_PATH, JSON.stringify(raw));

      const second = path.join(tmpProjects, 'fresh-checkout');
      makeGitRepo(second, remote);
      const secondEntry = registry.registerProject(second);

      expect(secondEntry.dbPath).toBe(firstEntry.dbPath);
    });

    it('falls back to the exact path-based dbPath — unchanged — for a project with no git remote', () => {
      const root = path.join(tmpProjects, 'no-remote-project');
      mkdirp(root);
      const entry = registry.registerProject(root);
      expect(entry.dbPath).toBe(globalMod.getDbPath(root));
      expect(entry.remoteIdentity).toBeUndefined();
    });

    it('never collides two genuinely different repos', () => {
      const a = path.join(tmpProjects, 'proj-a');
      const b = path.join(tmpProjects, 'proj-b');
      makeGitRepo(a, 'https://github.com/org/repo-a.git');
      makeGitRepo(b, 'https://github.com/org/repo-b.git');

      const entryA = registry.registerProject(a);
      const entryB = registry.registerProject(b);

      expect(entryA.dbPath).not.toBe(entryB.dbPath);
    });

    it('re-registering an already-registered root is unaffected — no dbPath drift', () => {
      const root = path.join(tmpProjects, 'stable-project');
      makeGitRepo(root, 'https://github.com/org/stable.git');
      const first = registry.registerProject(root);
      const again = registry.registerProject(root);
      expect(again).toEqual(first);
    });

    it('findRegisteredEntryByRemote excludes the given root and returns null with no match', () => {
      const root = path.join(tmpProjects, 'solo-project');
      makeGitRepo(root, 'https://github.com/org/solo.git');
      registry.registerProject(root);

      expect(registry.findRegisteredEntryByRemote('github.com/org/solo', root)).toBeNull();
      expect(registry.findRegisteredEntryByRemote('github.com/org/unrelated')).toBeNull();
    });
  });

  describe('setupProject — end-to-end dbPath reuse (TRA-38)', () => {
    it('a second checkout of an already-registered remote opens the SAME on-disk DB, not a fresh one', async () => {
      const { setupProject } = await import('../project-setup.js');
      const remote = 'https://github.com/nikolai-vysotskyi/trace-mcp.git';
      const first = path.join(tmpProjects, 'setup-run-1', 'workdir');
      const second = path.join(tmpProjects, 'setup-run-2', 'workdir');
      makeGitRepo(first, remote);
      makeGitRepo(second, remote);

      const firstResult = setupProject(first);
      expect(fs.existsSync(firstResult.dbPath)).toBe(true);

      const secondResult = setupProject(second);
      expect(secondResult.dbPath).toBe(firstResult.dbPath);
      expect(secondResult.isNew).toBe(true); // the second root is still a new registry row

      // No stray DB was left behind at the second root's own path-based
      // location — the whole point of registering before initializeDatabase.
      const strayDbPath = globalMod.getDbPath(second);
      expect(strayDbPath).not.toBe(firstResult.dbPath);
      expect(fs.existsSync(strayDbPath)).toBe(false);
    });
  });
});
