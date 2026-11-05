import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { semverGt } from '../src/updater.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER_SRC = path.resolve(THIS_DIR, '../hooks/trace-mcp-launcher.sh');

function fakeNodeBody(version: string, marker = 'NODE_ARGS'): string {
  return `#!/bin/bash\nif [ "\${1:-}" = "-v" ]; then echo "v${version}"; exit 0; fi\necho "${marker}:$*"\n`;
}

describe('Version alignment and divergence on isolated fixtures (TRA-2903)', () => {
  let tmpRoot: string;
  let fakeHome: string;
  let traceHome: string;
  let fakeNode: string;
  let pkgDir: string;
  let cliPath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tmcp-concurrency-fixture-'));
    fakeHome = path.join(tmpRoot, 'home');
    traceHome = path.join(fakeHome, '.trace');
    fs.mkdirSync(traceHome, { recursive: true });

    fakeNode = path.join(fakeHome, 'fake-node');
    fs.writeFileSync(fakeNode, fakeNodeBody('22.22.2'), { mode: 0o755 });

    pkgDir = path.join(tmpRoot, 'node_modules', 'trace-mcp');
    const distDir = path.join(pkgDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    cliPath = path.join(distDir, 'cli.js');
    fs.writeFileSync(cliPath, '// fake cli script\n');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  describe.skipIf(process.platform === 'win32')('Launcher shim divergence detection', () => {
    it('detects and logs version divergence when launcher.env and package.json disagree without cyclic restart', () => {
      // package.json on disk has 3.42.7
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'trace-mcp', version: '3.42.7' }),
      );

      // launcher.env was stamped with 3.42.8 (the incident condition)
      const launcherEnv = [
        '# Managed by trace-mcp',
        `TRACE_MCP_NODE="${fakeNode}"`,
        `TRACE_MCP_CLI="${cliPath}"`,
        'TRACE_MCP_VERSION="3.42.8"',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(traceHome, 'launcher.env'), launcherEnv);

      const result = spawnSync(LAUNCHER_SRC, ['serve'], {
        env: {
          HOME: fakeHome,
          TRACE_MCP_HOME: traceHome,
          PATH: '/usr/bin:/bin',
        },
        encoding: 'utf-8',
        timeout: 10_000,
      });

      // Shim still launches cleanly: no exit 127, no hang, no loop
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`NODE_ARGS:${cliPath} serve`);

      // Launcher log must record the divergence warning
      const launcherLog = fs.readFileSync(path.join(traceHome, 'launcher.log'), 'utf-8');
      expect(launcherLog).toContain('WARN: version divergence');
      expect(launcherLog).toContain('config TRACE_MCP_VERSION=3.42.8');
      expect(launcherLog).toContain('has version 3.42.7');
    });

    it('does not log divergence warning when launcher.env matches package.json', () => {
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'trace-mcp', version: '3.42.8' }),
      );

      const launcherEnv = [
        '# Managed by trace-mcp',
        `TRACE_MCP_NODE="${fakeNode}"`,
        `TRACE_MCP_CLI="${cliPath}"`,
        'TRACE_MCP_VERSION="3.42.8"',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(traceHome, 'launcher.env'), launcherEnv);

      const result = spawnSync(LAUNCHER_SRC, ['serve'], {
        env: {
          HOME: fakeHome,
          TRACE_MCP_HOME: traceHome,
          PATH: '/usr/bin:/bin',
        },
        encoding: 'utf-8',
        timeout: 10_000,
      });

      expect(result.status).toBe(0);
      const launcherLog = fs.readFileSync(path.join(traceHome, 'launcher.log'), 'utf-8');
      expect(launcherLog).not.toContain('WARN: version divergence');
    });
  });

  describe('Daemon staleness logic', () => {
    it('refuses restart when on-disk package is older than running daemon (downgrade prevention)', () => {
      const runningDaemonVersion = '3.42.8';
      const installedOnDiskVersion = '3.42.7';

      // Verify semverGt logic that guards the staleness watchdog in src/cli.ts
      const shouldShutdown = semverGt(installedOnDiskVersion, runningDaemonVersion);
      expect(shouldShutdown).toBe(false);

      const isDowngrade = semverGt(runningDaemonVersion, installedOnDiskVersion);
      expect(isDowngrade).toBe(true);
    });

    it('approves restart when on-disk package is newer than running daemon (upgrade adoption)', () => {
      const runningDaemonVersion = '3.42.8';
      const installedOnDiskVersion = '3.42.9';

      const shouldShutdown = semverGt(installedOnDiskVersion, runningDaemonVersion);
      expect(shouldShutdown).toBe(true);
    });
  });

  describe('Auto-update downgrade prevention on disk fixture', () => {
    it('refuses to downgrade when launcher.env records higher version than target release', async () => {
      vi.resetModules();
      process.env.TRACE_MCP_HOME = traceHome;
      process.env.TRACE_MCP_DATA_DIR = traceHome;
      process.env.TRACE_MCP_FORCE_NOT_DEV_CHECKOUT = '1';
      const prevNoAutoUpdate = process.env.TRACE_MCP_NO_AUTO_UPDATE;
      delete process.env.TRACE_MCP_NO_AUTO_UPDATE;
      (globalThis as Record<string, unknown>).PKG_VERSION_INJECTED = '3.42.0';

      try {
        const cachePath = path.join(traceHome, 'update-check.json');
        fs.writeFileSync(
          cachePath,
          JSON.stringify({ lastChecked: Date.now(), latestVersion: '3.42.7' }),
        );

        fs.writeFileSync(
          path.join(traceHome, 'launcher.env'),
          `TRACE_MCP_VERSION="3.42.8"\nTRACE_MCP_NODE="${fakeNode}"\nTRACE_MCP_CLI="${cliPath}"\n`,
        );

        const { checkAndInstallUpdate: checkUpdate } = await import('../src/updater.js');

        const updated = await checkUpdate({ checkIntervalHours: 24 });
        expect(updated).toBe(false);

        // Verify cache synchronized with launcher version
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        expect(cache.installedVersion).toBe('3.42.8');
      } finally {
        delete process.env.TRACE_MCP_HOME;
        delete process.env.TRACE_MCP_DATA_DIR;
        delete process.env.TRACE_MCP_FORCE_NOT_DEV_CHECKOUT;
        (globalThis as Record<string, unknown>).PKG_VERSION_INJECTED = undefined;
        if (prevNoAutoUpdate !== undefined) {
          process.env.TRACE_MCP_NO_AUTO_UPDATE = prevNoAutoUpdate;
        } else {
          delete process.env.TRACE_MCP_NO_AUTO_UPDATE;
        }
      }
    });
  });
});
