import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDaemonSpawnInvocation, resolveTraceMcpBinary } from '../../src/daemon/lifecycle.js';

describe('Windows daemon binary resolution (TRA-2892)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tra-2892-res-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves trace.cmd when created by current installer', () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const traceCmd = path.join(binDir, 'trace.cmd');
    fs.writeFileSync(traceCmd, '@echo off\r\n');

    const resolved = resolveTraceMcpBinary({ home: tmpDir, isWin: true });
    expect(resolved).toBe(traceCmd);
  });

  it('resolves legacy trace-mcp.cmd when trace.cmd is absent', () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const legacyCmd = path.join(binDir, 'trace-mcp.cmd');
    fs.writeFileSync(legacyCmd, '@echo off\r\n');

    const resolved = resolveTraceMcpBinary({ home: tmpDir, isWin: true });
    expect(resolved).toBe(legacyCmd);
  });

  it('prefers trace.cmd over legacy trace-mcp.cmd when both exist', () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const traceCmd = path.join(binDir, 'trace.cmd');
    const legacyCmd = path.join(binDir, 'trace-mcp.cmd');
    fs.writeFileSync(traceCmd, '@echo off\r\n');
    fs.writeFileSync(legacyCmd, '@echo off\r\n');

    const resolved = resolveTraceMcpBinary({ home: tmpDir, isWin: true });
    expect(resolved).toBe(traceCmd);
  });

  it('falls back to argv1 when no shim exists in home', () => {
    const fakeCli = path.join(tmpDir, 'trace-mcp', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
    fs.writeFileSync(fakeCli, '// fake cli');

    const resolved = resolveTraceMcpBinary({
      home: tmpDir,
      isWin: true,
      argv1: fakeCli,
    });
    expect(resolved).toBe(path.resolve(fakeCli));
  });

  it('falls back to argv1 when path contains trace instead of trace-mcp', () => {
    const fakeCli = path.join(tmpDir, 'trace', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
    fs.writeFileSync(fakeCli, '// fake cli');

    const resolved = resolveTraceMcpBinary({
      home: tmpDir,
      isWin: true,
      argv1: fakeCli,
    });
    expect(resolved).toBe(path.resolve(fakeCli));
  });
});

describe('resolveDaemonSpawnInvocation contract (TRA-2892)', () => {
  it('launches JS entrypoint via process.execPath with shell: false on Windows', () => {
    const cliJs = 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\trace-mcp\\dist\\cli.js';
    const inv = resolveDaemonSpawnInvocation(cliJs, 3737, {
      isWin: true,
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
    });

    expect(inv.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(inv.args).toEqual([cliJs, 'serve-http', '--port', '3737']);
    expect(inv.shell).toBe(false);
  });

  it('launches JS entrypoint with spaces in path safely via process.execPath', () => {
    const cliJs = 'C:\\Program Files\\My Apps\\trace-mcp\\dist\\cli.js';
    const inv = resolveDaemonSpawnInvocation(cliJs, 3740, {
      isWin: true,
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
    });

    expect(inv.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(inv.args).toEqual([cliJs, 'serve-http', '--port', '3740']);
    expect(inv.shell).toBe(false);
  });

  it('formats .cmd shim command string without args array on Windows to prevent DEP0190', () => {
    const shimCmd = 'C:\\Users\\alice\\.trace\\bin\\trace.cmd';
    const inv = resolveDaemonSpawnInvocation(shimCmd, 3737, { isWin: true });

    expect(inv.command).toBe('C:\\Users\\alice\\.trace\\bin\\trace.cmd serve-http --port 3737');
    expect(inv.args).toEqual([]);
    expect(inv.shell).toBe(true);
  });

  it('quotes .cmd shim with spaces in command string on Windows', () => {
    const shimCmd = 'C:\\Users\\Alice Smith\\.trace\\bin\\trace.cmd';
    const inv = resolveDaemonSpawnInvocation(shimCmd, 3737, { isWin: true });

    expect(inv.command).toBe(
      '"C:\\Users\\Alice Smith\\.trace\\bin\\trace.cmd" serve-http --port 3737',
    );
    expect(inv.args).toEqual([]);
    expect(inv.shell).toBe(true);
  });

  it('launches POSIX shim directly with shell: false', () => {
    const shimPosix = '/Users/alice/.trace/bin/trace';
    const inv = resolveDaemonSpawnInvocation(shimPosix, 3737, { isWin: false });

    expect(inv.command).toBe(shimPosix);
    expect(inv.args).toEqual(['serve-http', '--port', '3737']);
    expect(inv.shell).toBe(false);
  });

  it('launches POSIX JS fallback via process.execPath with shell: false', () => {
    const cliJs = '/opt/trace-mcp/dist/cli.js';
    const inv = resolveDaemonSpawnInvocation(cliJs, 3737, {
      isWin: false,
      execPath: '/usr/local/bin/node',
    });

    expect(inv.command).toBe('/usr/local/bin/node');
    expect(inv.args).toEqual([cliJs, 'serve-http', '--port', '3737']);
    expect(inv.shell).toBe(false);
  });
});

describe('Executable daemon auto-spawn harness (TRA-2892)', () => {
  let tmpDir: string;
  let serverProc: ReturnType<typeof spawn> | null = null;
  let serverPort: number | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tra-2892-spawn- spaces '));
    serverPort = null;
  });

  afterEach(async () => {
    if (serverPort) {
      try {
        await fetch(`http://127.0.0.1:${serverPort}/shutdown`).catch(() => {});
      } catch {
        // Best-effort shutdown signal
      }
    }
    if (serverProc && !serverProc.killed) {
      if (process.platform === 'win32' && serverProc.pid) {
        try {
          spawnSync('taskkill', ['/pid', String(serverProc.pid), '/t', '/f'], { stdio: 'ignore' });
        } catch {
          // ignore
        }
      }
      serverProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
      if (!serverProc.killed) {
        serverProc.kill('SIGKILL');
      }
    }
    serverProc = null;
    serverPort = null;
    await new Promise((r) => setTimeout(r, 100));
    try {
      await fs.promises.rm(tmpDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } catch {
      // Best-effort temp dir cleanup on Windows
    }
  });

  function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer();
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

  async function waitForHealth(port: number, timeoutMs = 8_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          const body = (await res.json()) as { status: string };
          if (body.status === 'ok') return true;
        }
      } catch {
        // waiting for server to bind
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it('starts daemon from JS fallback via process.execPath, reaches /health, and preserves arguments in paths with spaces', async () => {
    const port = await getFreePort();
    serverPort = port;

    // Create a mock CLI JS entrypoint inside a path with spaces
    const mockCli = path.join(tmpDir, 'mock cli.js');
    const mockCliCode = `
import http from 'node:http';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 0;

if (!args.includes('serve-http')) {
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', transport: 'http', args }));
    return;
  }
  if (req.url === '/shutdown') {
    res.writeHead(200);
    res.end();
    server.close(() => process.exit(0));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  // ready
});
`;
    fs.writeFileSync(mockCli, mockCliCode);

    // Resolve invocation using our Windows-aware resolution
    const inv = resolveDaemonSpawnInvocation(mockCli, port, {
      isWin: true, // test Windows spawn contract
      execPath: process.execPath,
    });

    // Ensure contract guarantees: shell MUST be false, command MUST be Node
    expect(inv.command).toBe(process.execPath);
    expect(inv.shell).toBe(false);
    expect(inv.args).toEqual([mockCli, 'serve-http', '--port', String(port)]);

    const warnings: { code?: string; message?: string }[] = [];
    const warningListener = (w: { code?: string; message?: string }) => {
      warnings.push(w);
    };
    process.on('warning', warningListener);

    try {
      serverProc = spawn(inv.command, inv.args, {
        detached: true,
        stdio: 'ignore',
        cwd: tmpDir,
        shell: inv.shell,
        windowsHide: true,
      });
      serverProc.unref();

      const healthy = await waitForHealth(port);
      expect(healthy).toBe(true);

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; args: string[] };
      expect(data.status).toBe('ok');
      expect(data.args).toContain('serve-http');
      expect(data.args).toContain('--port');
      expect(data.args).toContain(String(port));

      // Assert no DEP0190 warning was emitted
      const dep0190 = warnings.find((w) => w.code === 'DEP0190');
      expect(dep0190).toBeUndefined();
    } finally {
      process.off('warning', warningListener);
    }
  });

  it('starts daemon from managed shim, reaches /health, and preserves arguments in paths with spaces', async () => {
    const port = await getFreePort();
    serverPort = port;

    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    // Create a mock CLI JS
    const mockCli = path.join(tmpDir, 'server.js');
    fs.writeFileSync(
      mockCli,
      `
import http from 'node:http';
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 0;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', transport: 'http', args }));
    return;
  }
  if (req.url === '/shutdown') {
    res.writeHead(200);
    res.end();
    server.close(() => process.exit(0));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1');
`,
    );

    const isWindows = process.platform === 'win32';
    const shimName = isWindows ? 'trace.cmd' : 'trace';
    const shimPath = path.join(binDir, shimName);

    if (isWindows) {
      // Mock Windows CMD shim
      fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${mockCli}" %*\r\n`);
    } else {
      // Mock POSIX shim
      fs.writeFileSync(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${mockCli}" "$@"\n`, {
        mode: 0o755,
      });
    }

    const inv = resolveDaemonSpawnInvocation(shimPath, port, { isWin: isWindows });
    if (isWindows) {
      expect(inv.shell).toBe(true);
      expect(inv.args).toEqual([]);
      expect(inv.command).toContain(shimPath);
    } else {
      expect(inv.command).toBe(shimPath);
      expect(inv.args).toEqual(['serve-http', '--port', String(port)]);
      expect(inv.shell).toBe(false);
    }

    serverProc = spawn(inv.command, inv.args, {
      detached: true,
      stdio: 'ignore',
      cwd: tmpDir,
      shell: inv.shell,
      windowsHide: true,
    });
    serverProc.unref();

    const healthy = await waitForHealth(port);
    expect(healthy).toBe(true);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; args: string[] };
    expect(data.status).toBe('ok');
    expect(data.args).toContain('serve-http');
    expect(data.args).toContain(String(port));
  });
});
