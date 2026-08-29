import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TRA-304: TRA-38's dbPath sharing between two checkouts of the same git
 * remote is only safe when those checkouts are used *sequentially*. A holder
 * marker beside the DB records "this pid has this DB open from this root";
 * `registerProject()` skips the sibling's dbPath while a foreign holder is
 * live, and the deletion paths (prune, removeProjectArtifacts) keep a DB that
 * someone still holds.
 */

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function write(filePath: string, content: string): void {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Minimal git repo fixture with an `origin` remote (mirrors TRA-38's tests). */
function makeGitRepo(root: string, remoteUrl?: string): void {
  mkdirp(root);
  write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(root, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
  if (remoteUrl) {
    write(
      path.join(root, '.git', 'config'),
      ['[remote "origin"]', `\turl = ${remoteUrl}`, ''].join('\n'),
    );
  }
}

function holderIdOf(root: string): string {
  return crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
}

const REMOTE = 'https://github.com/acme/widgets.git';

describe('index-DB holders (TRA-304)', () => {
  let tmpHome: string;
  let tmpProjects: string;
  let registry: typeof import('../registry.js');
  let holders: typeof import('../db-holders.js');
  let globalMod: typeof import('../global.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-holders-home-'));
    tmpProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-holders-projects-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    registry = await import('../registry.js');
    holders = await import('../db-holders.js');
    globalMod = await import('../global.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProjects, { recursive: true, force: true });
  });

  /** Plant a holder marker for `root` on `dbPath` as if another process wrote it. */
  function plantHolder(
    dbPath: string,
    root: string,
    opts: { pid?: number; ageMs?: number } = {},
  ): void {
    const dir = holders.holdersDir(dbPath);
    mkdirp(dir);
    // Same id scheme the module uses: sha256(absolute root), first 16 hex chars.
    const id = holderIdOf(root);
    write(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        pid: opts.pid ?? process.pid,
        root: path.resolve(root),
        startedAt: new Date(Date.now() - (opts.ageMs ?? 0)).toISOString(),
      }),
    );
  }

  /** A pid that is guaranteed not to be running. */
  function deadPid(): number {
    for (let pid = 999_990; pid > 100; pid--) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
      }
    }
    throw new Error('no dead pid found');
  }

  describe('registerProject', () => {
    it('gives a new checkout its own DB while a sibling holder is live', () => {
      const first = path.join(tmpProjects, 'run-1');
      const second = path.join(tmpProjects, 'run-2');
      makeGitRepo(first, REMOTE);
      makeGitRepo(second, REMOTE);

      const a = registry.registerProject(first);
      // registerProject already announced `first` on its own DB (live pid = us).
      expect(holders.liveHolderRoots(a.dbPath)).toEqual([path.resolve(first)]);

      const b = registry.registerProject(second);
      expect(b.dbPath).not.toBe(a.dbPath);
      expect(b.dbPath).toBe(globalMod.getDbPath(second));
      expect(b.lastIndexed).toBeNull();
    });

    it('shares the sibling DB when its holder pid is dead (TRA-38 win preserved)', () => {
      const first = path.join(tmpProjects, 'run-1');
      const second = path.join(tmpProjects, 'run-2');
      makeGitRepo(first, REMOTE);
      makeGitRepo(second, REMOTE);

      const a = registry.registerProject(first);
      // Simulate the first run's process having exited without cleanup.
      holders.releaseDbHolder(a.dbPath, first);
      plantHolder(a.dbPath, first, { pid: deadPid() });

      const b = registry.registerProject(second);
      expect(b.dbPath).toBe(a.dbPath);
      // The dead marker is reaped by the scan that rejected it.
      expect(fs.readdirSync(holders.holdersDir(a.dbPath))).not.toContain(
        `${holderIdOf(first)}.json`,
      );
    });

    it('treats a holder older than the TTL as dead even with a live pid', () => {
      const first = path.join(tmpProjects, 'run-1');
      const second = path.join(tmpProjects, 'run-2');
      makeGitRepo(first, REMOTE);
      makeGitRepo(second, REMOTE);

      const a = registry.registerProject(first);
      holders.releaseDbHolder(a.dbPath, first);
      // Live pid (our own), but announced longer ago than the TTL allows.
      plantHolder(a.dbPath, first, { ageMs: holders.HOLDER_TTL_MS + 60_000 });

      const b = registry.registerProject(second);
      expect(b.dbPath).toBe(a.dbPath);
    });

    it('leaves a project with no resolvable git remote on its path-based DB', () => {
      const plain = path.join(tmpProjects, 'no-remote');
      makeGitRepo(plain); // no origin configured

      const entry = registry.registerProject(plain);
      expect(entry.dbPath).toBe(globalMod.getDbPath(plain));
      expect(entry.remoteIdentity).toBeUndefined();
    });

    it('falls back to its own DB when the holder directory is unwritable', () => {
      const first = path.join(tmpProjects, 'run-1');
      const second = path.join(tmpProjects, 'run-2');
      makeGitRepo(first, REMOTE);
      makeGitRepo(second, REMOTE);

      const a = registry.registerProject(first);
      holders.releaseDbHolder(a.dbPath, first);
      // Block the announce: a plain file where the holder directory must go.
      fs.rmSync(holders.holdersDir(a.dbPath), { recursive: true, force: true });
      fs.writeFileSync(holders.holdersDir(a.dbPath), 'not a directory', 'utf8');

      const b = registry.registerProject(second);
      expect(b.dbPath).toBe(globalMod.getDbPath(second));
    });
  });

  describe('deletion paths', () => {
    it('prune classifies a held but unregistered DB as live', async () => {
      const { INDEX_DIR } = globalMod;
      mkdirp(INDEX_DIR);
      const dbPath = path.join(INDEX_DIR, 'ghost-0123456789ab.db');
      fs.writeFileSync(dbPath, '');
      const { scanIndexDir } = await import('../cli/prune.js');

      // No registry anchor at all: without a holder this is an orphan.
      expect(scanIndexDir().find((c) => c.path === dbPath)?.category).toBe('orphan_unregistered');

      plantHolder(dbPath, path.join(tmpProjects, 'holder-root'));
      expect(scanIndexDir().find((c) => c.path === dbPath)?.category).toBe('live');
    });

    it('removeProjectArtifacts keeps a DB that another root still holds', async () => {
      const root = path.join(tmpProjects, 'run-1');
      makeGitRepo(root, REMOTE);
      const entry = registry.registerProject(root);
      mkdirp(path.dirname(entry.dbPath));
      fs.writeFileSync(entry.dbPath, '');

      plantHolder(entry.dbPath, path.join(tmpProjects, 'other-root'));

      const { removeProjectArtifacts } = await import('../daemon/project-artifacts.js');
      const result = removeProjectArtifacts(root);
      expect(fs.existsSync(entry.dbPath)).toBe(true);
      expect(result.kept).toContain(entry.dbPath);
      expect(result.deleted).not.toContain(entry.dbPath);
    });

    it('removeProjectArtifacts deletes a DB nobody else holds', async () => {
      const root = path.join(tmpProjects, 'run-1');
      makeGitRepo(root, REMOTE);
      const entry = registry.registerProject(root);
      mkdirp(path.dirname(entry.dbPath));
      fs.writeFileSync(entry.dbPath, '');

      const { removeProjectArtifacts } = await import('../daemon/project-artifacts.js');
      const result = removeProjectArtifacts(root);
      expect(fs.existsSync(entry.dbPath)).toBe(false);
      expect(result.deleted).toContain(entry.dbPath);
      // The holder directory goes with the DB it described.
      expect(fs.existsSync(holders.holdersDir(entry.dbPath))).toBe(false);
    });
  });
});
