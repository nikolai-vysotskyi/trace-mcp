import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TRA-1954: Restart storm mitigation.
// When a live daemon is undergoing a heavy warmup / indexing phase, /health
// may be starved for minutes. Parallel connections and tray restarts must not
// kill the live daemon in a death spiral.
//
// 1. Matrix policy test: pure functions tested without I/O.
// 2. Throttling of live daemon in restartDaemon().
// 3. Round-trip of restart marker file.
// 4. tryAutoSpawnDaemon leaves alive-but-silent daemon alone instead of killing it.

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('failed to get free port')));
      }
    });
  });
}

describe('restart throttle policy and lifecycle (TRA-1954)', () => {
  let tmpHome: string;
  let lifecycle: typeof import('../lifecycle.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-throttle-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    lifecycle = await import('../lifecycle.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('матрица политики: shouldThrottleRestartFor and shouldThrottleLiveRestart', () => {
    const now = 1_000_000;
    const cooldownMs = lifecycle.RESTART_COOLDOWN_MS; // 10 minutes = 600_000 ms
    const recent = now - 60_000; // 1 min ago
    const old = now - cooldownMs - 1_000; // 10m 1s ago

    // Live daemon with recent restart -> throttled unless force is true
    expect(
      lifecycle.shouldThrottleRestartFor({
        isAlive: true,
        lastRestartAt: recent,
        now,
        cooldownMs,
      }),
    ).toBe(true);

    expect(
      lifecycle.shouldThrottleRestartFor({
        isAlive: true,
        lastRestartAt: recent,
        force: true,
        now,
        cooldownMs,
      }),
    ).toBe(false);

    // Live daemon with old restart (> cooldown) -> not throttled
    expect(
      lifecycle.shouldThrottleRestartFor({
        isAlive: true,
        lastRestartAt: old,
        now,
        cooldownMs,
      }),
    ).toBe(false);

    // Live daemon with no previous restart -> not throttled
    expect(
      lifecycle.shouldThrottleRestartFor({
        isAlive: true,
        lastRestartAt: null,
        now,
        cooldownMs,
      }),
    ).toBe(false);

    // Dead daemon is NEVER throttled (dead process must be restarted)
    expect(
      lifecycle.shouldThrottleRestartFor({
        isAlive: false,
        lastRestartAt: recent,
        now,
        cooldownMs,
      }),
    ).toBe(false);

    expect(
      lifecycle.shouldThrottleRestartFor({
        isAlive: false,
        lastRestartAt: old,
        now,
        cooldownMs,
      }),
    ).toBe(false);

    expect(
      lifecycle.shouldThrottleRestartFor({
        isAlive: false,
        lastRestartAt: null,
        now,
        cooldownMs,
      }),
    ).toBe(false);

    // shouldThrottleLiveRestart edge cases
    expect(lifecycle.shouldThrottleLiveRestart(recent, now, cooldownMs)).toBe(true);
    // Exact boundary: elapsed == cooldownMs -> not throttled
    expect(lifecycle.shouldThrottleLiveRestart(now - cooldownMs, now, cooldownMs)).toBe(false);
    // Elapsed > cooldownMs -> not throttled
    expect(lifecycle.shouldThrottleLiveRestart(old, now, cooldownMs)).toBe(false);
    // Future timestamp (clock skew) -> not throttled
    expect(lifecycle.shouldThrottleLiveRestart(now + 10_000, now, cooldownMs)).toBe(false);
    // Invalid / missing timestamps
    expect(lifecycle.shouldThrottleLiveRestart(null, now, cooldownMs)).toBe(false);
    expect(lifecycle.shouldThrottleLiveRestart(undefined, now, cooldownMs)).toBe(false);
    expect(lifecycle.shouldThrottleLiveRestart(Number.NaN, now, cooldownMs)).toBe(false);
  });

  it('throttling живого: restartDaemon suppresses restart when alive and within cooldown', () => {
    // Register current process as the live daemon in isolated home
    lifecycle.writeOwnDaemonPidFile();
    expect(lifecycle.isDaemonProcessAlive()).toBe(true);

    // Write a fresh restart marker (restarted 30s ago)
    const markerTime = Date.now() - 30_000;
    lifecycle.writeRestartMarker(lifecycle.getRestartMarkerPath(), markerTime);

    // Attempt restart without force
    const result = lifecycle.restartDaemon({ port: 3741 });
    expect(result.ok).toBe(true);
    expect(result.throttled).toBe(true);
    expect(result.alreadyRunning).toBe(true);
    expect(result.strategy).toBe('already-running');

    // The marker timestamp should not have been overwritten since no restart ran
    const readBack = lifecycle.readRestartMarker();
    expect(readBack).toBe(markerTime);
  });

  it('round-trip маркера: write and read restart marker with corruption handling', () => {
    const markerPath = lifecycle.getRestartMarkerPath();

    // Absent marker returns null
    expect(lifecycle.readRestartMarker(markerPath)).toBeNull();

    // Write valid marker
    const now = 1729377000000;
    lifecycle.writeRestartMarker(markerPath, now);
    expect(fs.existsSync(markerPath)).toBe(true);

    const readBack = lifecycle.readRestartMarker(markerPath);
    expect(readBack).toBe(now);

    // Corrupt JSON returns null without throwing
    fs.writeFileSync(markerPath, '{ "broken": json', 'utf-8');
    expect(lifecycle.readRestartMarker(markerPath)).toBeNull();

    // Empty file returns null without throwing
    fs.writeFileSync(markerPath, '', 'utf-8');
    expect(lifecycle.readRestartMarker(markerPath)).toBeNull();

    // Plain numeric timestamp also parses
    fs.writeFileSync(markerPath, '1729377111000\n', 'utf-8');
    expect(lifecycle.readRestartMarker(markerPath)).toBe(1729377111000);
  });

  it('auto-spawn оставляет живой-немой демон в покое; последний под старым кодом убил бы сам тестовый процесс', async () => {
    // Fast backoff for test
    vi.stubEnv('TRACE_MCP_ALIVE_DAEMON_BACKOFF_MS', '50');

    // Register test process as the alive daemon
    lifecycle.writeOwnDaemonPidFile();
    expect(lifecycle.isDaemonProcessAlive()).toBe(true);

    // Free port where /health will not answer
    const port = await getFreePort();

    // tryAutoSpawnDaemon should attempt /health, back off, see that the daemon
    // process is still alive, and NOT kill it or restart it.
    const result = await lifecycle.tryAutoSpawnDaemon(port, 50);

    expect(result.ok).toBe(true);
    expect(result.alreadyRunning).toBe(true);

    // Process is still alive and was not killed
    expect(lifecycle.isDaemonProcessAlive()).toBe(true);
  });
});
