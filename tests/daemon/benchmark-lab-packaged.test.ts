/**
 * TRA-2298 guard: Benchmark Lab fixtures endpoint in packaged/installed artifact
 * must not fail with HTTP 500 outside a repository checkout.
 *
 * Verifies that the packaged npm distribution ships the pinned battery under
 * `dist/benchmark-lab/fixtures` and that `GET /api/benchmark-lab/fixtures` serves
 * all 8 fixtures cleanly without tests/ present in the installation tree.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
      // connecting
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`packaged daemon on port ${port} did not become ready within ${timeoutMs}ms`);
}

describe('benchmark-lab in packaged distribution (TRA-2298)', () => {
  let tmpDir: string;
  let child: ChildProcess | null = null;
  let port: number;

  beforeAll(async () => {
    expect(fs.existsSync(CLI), 'dist/cli.js must be built before running packaged test').toBe(true);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmcp-packaged-lab-'));

    // 1. Pack the package into a tarball exactly as published to npm
    const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    execFileSync(pnpmBin, ['pack', '--pack-destination', tmpDir], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });

    const tarball = fs.readdirSync(tmpDir).find((f) => f.endsWith('.tgz'));
    if (!tarball) throw new Error('pnpm pack did not produce a .tgz tarball');

    // 2. Extract into tmpDir/package
    execFileSync('tar', ['-xzf', path.join(tmpDir, tarball), '-C', tmpDir], {
      stdio: 'pipe',
    });

    const packageDir = path.join(tmpDir, 'package');
    expect(fs.existsSync(packageDir)).toBe(true);

    // Verify invariant: this packaged install has NO tests/ folder
    expect(fs.existsSync(path.join(packageDir, 'tests'))).toBe(false);

    // Verify the pinned fixtures were packaged inside dist/benchmark-lab/fixtures
    const pkgFixturesDir = path.join(packageDir, 'dist', 'benchmark-lab', 'fixtures');
    expect(fs.existsSync(pkgFixturesDir), 'dist/benchmark-lab/fixtures missing in package').toBe(
      true,
    );

    // Provide node_modules so native modules (better-sqlite3, etc.) resolve
    fs.symlinkSync(
      path.join(REPO_ROOT, 'node_modules'),
      path.join(packageDir, 'node_modules'),
      'junction',
    );

    port = await getFreePort();
    const sandboxData = path.join(tmpDir, 'data');
    const sandboxHome = path.join(tmpDir, 'home');
    fs.mkdirSync(sandboxData, { recursive: true });
    fs.mkdirSync(sandboxHome, { recursive: true });

    child = spawn(
      process.execPath,
      [path.join(packageDir, 'dist', 'cli.js'), 'serve-http', '--port', String(port)],
      {
        cwd: packageDir,
        env: {
          ...process.env,
          TRACE_MCP_ALLOW_EPHEMERAL_DAEMON: '1',
          TRACE_MCP_DATA_DIR: sandboxData,
          TRACE_MCP_HOME: sandboxHome,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    await waitForHealth(port);
  }, 60_000);

  afterAll(async () => {
    if (child) {
      child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('serves GET /api/benchmark-lab/fixtures with 200 and all 8 pinned fixtures outside checkout', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/benchmark-lab/fixtures`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      fixtures: Array<{ id: string; kind: string; query: string; k: number }>;
    };

    expect(Array.isArray(data.fixtures)).toBe(true);
    expect(data.fixtures.length).toBe(8);

    const ids = data.fixtures.map((f) => f.id);
    expect(ids).toContain('01-search-indexer-entry-point');
    expect(ids).toContain('02-search-gather-context');
    expect(ids).toContain('03-search-decision-store');
    expect(ids).toContain('04-search-pack-context');
    expect(ids).toContain('05-context-ask-shared');
    expect(ids).toContain('06-context-pipeline');
    expect(ids).toContain('07-decisions-fts-search');
    expect(ids).toContain('08-decisions-tag-filter');

    for (const f of data.fixtures) {
      expect(typeof f.id).toBe('string');
      expect(['symbol', 'file', 'decision']).toContain(f.kind);
      expect(typeof f.query).toBe('string');
      expect(typeof f.k).toBe('number');
      expect(f.k).toBeGreaterThan(0);
    }
  });
});
