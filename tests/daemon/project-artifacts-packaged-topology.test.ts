/**
 * TRA-2778: Packaged daemon (`dist/cli.js`) must cleanly clean up topology rows
 * on project removal (DELETE /api/projects) without throwing MODULE_NOT_FOUND.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('no free port')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // still starting up
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`packaged daemon on port ${port} did not become healthy within ${timeoutMs}ms`);
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 2000);
  });
}

describe('packaged daemon topology cleanup on project delete (TRA-2778)', () => {
  let tmpHome: string;
  let tmpProjects: string;
  let testRoot: string;
  let canonicalTestRoot: string;
  let otherRoot: string;
  let port: number;
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    expect(fs.existsSync(CLI), 'dist/cli.js must be built before running packaged test').toBe(true);

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-packaged-topo-home-'));
    tmpProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-packaged-topo-proj-'));

    testRoot = path.join(tmpProjects, 'test-project');
    otherRoot = path.join(tmpProjects, 'other-project');

    for (const r of [testRoot, otherRoot]) {
      fs.mkdirSync(path.join(r, '.git'), { recursive: true });
      fs.writeFileSync(path.join(r, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      fs.writeFileSync(path.join(r, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
    }

    // Set up isolated global dirs
    const indexDir = path.join(tmpHome, 'index');
    fs.mkdirSync(indexDir, { recursive: true });

    // Seed registry.json with schema { version: 1, projects: { ... } }
    const testDbPath = path.join(indexDir, 'test-project-0123456789ab.db');
    fs.writeFileSync(testDbPath, '');
    canonicalTestRoot = fs.realpathSync(testRoot);
    const registryData = {
      version: 1,
      projects: {
        [canonicalTestRoot]: {
          name: 'test-project',
          root: canonicalTestRoot,
          dbPath: testDbPath,
          lastIndexed: new Date().toISOString(),
          addedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(path.join(tmpHome, 'registry.json'), JSON.stringify(registryData, null, 2));

    // Seed topology.db using SQLite schema
    const topoDbPath = path.join(tmpHome, 'topology.db');
    const db = new Database(topoDbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS subprojects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          repo_root TEXT NOT NULL,
          project_root TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(repo_root, project_root)
        );
        CREATE TABLE IF NOT EXISTS services (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          repo_root TEXT NOT NULL,
          db_path TEXT NOT NULL,
          service_type TEXT,
          detection_source TEXT,
          project_group TEXT,
          metadata TEXT,
          indexed_at TEXT DEFAULT (datetime('now')),
          UNIQUE(name)
        );
      `);

      db.prepare(`
        INSERT INTO subprojects (name, repo_root, project_root) VALUES (?, ?, ?)
      `).run('test-proj', canonicalTestRoot, canonicalTestRoot);
      db.prepare(`
        INSERT INTO subprojects (name, repo_root, project_root) VALUES (?, ?, ?)
      `).run('other-proj', otherRoot, otherRoot);

      db.prepare(`
        INSERT INTO services (name, repo_root, db_path, service_type) VALUES (?, ?, ?, ?)
      `).run('test-svc', canonicalTestRoot, testDbPath, 'backend');
      db.prepare(`
        INSERT INTO services (name, repo_root, db_path, service_type) VALUES (?, ?, ?, ?)
      `).run('other-svc', otherRoot, path.join(indexDir, 'other.db'), 'backend');
    } finally {
      db.close();
    }

    port = await getFreePort();
    child = spawn(process.execPath, [CLI, 'serve-http', '--port', String(port)], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TRACE_MCP_ALLOW_EPHEMERAL_DAEMON: '1',
        TRACE_MCP_DATA_DIR: tmpHome,
        TRACE_MCP_HOME: tmpHome,
        TRACE_MCP_MANAGED_BY: 'test',
        CI: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitForHealth(port);
  }, 30_000);

  afterAll(async () => {
    if (child) {
      await stopChild(child);
      child = null;
    }
    if (tmpHome && fs.existsSync(tmpHome)) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
    if (tmpProjects && fs.existsSync(tmpProjects)) {
      fs.rmSync(tmpProjects, { recursive: true, force: true });
    }
  });

  it('deletes project via DELETE /api/projects and removes topology rows without MODULE_NOT_FOUND', async () => {
    const deleteUrl = `http://127.0.0.1:${port}/api/projects?project=${encodeURIComponent(testRoot)}`;
    const res = await fetch(deleteUrl, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      project: string;
      topology: { subprojects: number; services: number };
      failures: Array<{ tier: string; error: string }>;
    };

    expect(body.status).toBe('removed');
    expect(body.project).toBe(testRoot);

    // Verify topology rows were reported as cleaned
    expect(body.topology.subprojects).toBe(1);
    expect(body.topology.services).toBe(1);

    // Critical assertion: NO MODULE_NOT_FOUND or topology cleanup failures
    const topologyFailures = body.failures.filter((f) => f.tier === 'topology');
    expect(topologyFailures).toEqual([]);

    // Check on-disk topology.db
    const topoDbPath = path.join(tmpHome, 'topology.db');
    const db = new Database(topoDbPath);
    try {
      const subRows = db.prepare('SELECT repo_root FROM subprojects').all() as Array<{
        repo_root: string;
      }>;
      const serviceRows = db.prepare('SELECT repo_root FROM services').all() as Array<{
        repo_root: string;
      }>;

      const subRoots = subRows.map((r) => r.repo_root);
      const svcRoots = serviceRows.map((r) => r.repo_root);

      expect(subRoots).toContain(otherRoot);
      expect(subRoots).not.toContain(testRoot);

      expect(svcRoots).toContain(otherRoot);
      expect(svcRoots).not.toContain(testRoot);
    } finally {
      db.close();
    }

    // Check registry.json
    const registryContent = JSON.parse(
      fs.readFileSync(path.join(tmpHome, 'registry.json'), 'utf-8'),
    );
    const registeredRoots = Object.keys(registryContent.projects ?? {});
    expect(registeredRoots).not.toContain(canonicalTestRoot);
    expect(registeredRoots).not.toContain(testRoot);
  });
});
