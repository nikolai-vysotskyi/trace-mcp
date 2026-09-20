/**
 * TRA-1607: the daemon-spawn.lock file + stale window are a cross-surface
 * contract — the stdio auto-spawn, `daemon start`/`restart` (this module) and
 * the desktop app (`packages/app/src/main/daemon-install.ts`, which cannot
 * import from src/) must agree on all three values. If any of these change
 * here, mirror the change there.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate TRACE_MCP_HOME before global.ts resolves it.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-spawn-contract-'));
process.env.TRACE_MCP_DATA_DIR = TMP_HOME;

const { afterAll, describe, expect, it } = await import('vitest');
const { getSpawnLockPath, getSpawnLockStaleMs } = await import('../lifecycle.js');

describe('spawn-lock cross-surface contract', () => {
  afterAll(() => {
    try {
      fs.rmSync(TMP_HOME, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  });

  it('lock file is daemon-spawn.lock under the state home', () => {
    expect(path.basename(getSpawnLockPath())).toBe('daemon-spawn.lock');
    expect(getSpawnLockPath()).toBe(path.join(TMP_HOME, 'daemon-spawn.lock'));
  });

  it('stale window matches the desktop reimplementation (30 s)', () => {
    expect(getSpawnLockStaleMs()).toBe(30_000);
  });
});
