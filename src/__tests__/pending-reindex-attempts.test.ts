import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TRA-274: `pendingReindexForVersion` was cleared only after a forced rebuild
// COMPLETED. On a machine where the daemon is restarted before that (many
// concurrent CLI sessions sharing one launchd daemon), the flag survived every
// restart, so every new daemon force-rebuilt every registered project again —
// a livelock that ran 264 restarts without a single project finishing.
// The attempt counter bounds it: after MAX_PENDING_REINDEX_ATTEMPTS tries the
// flag is dropped and the project falls back to the cheap incremental path.

describe('pending-reindex attempt bounding (TRA-274)', () => {
  let tmpHome: string;
  let registry: typeof import('../registry.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-reindex-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    registry = await import('../registry.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function addProject(name: string): string {
    const dir = path.join(tmpHome, name);
    fs.mkdirSync(dir, { recursive: true });
    registry.registerProject(dir);
    return dir;
  }

  it('counts attempts across daemon restarts and gives up after the cap', () => {
    const root = addProject('proj');
    registry.markAllProjectsPendingReindex('2.0.0');

    for (let i = 1; i <= registry.MAX_PENDING_REINDEX_ATTEMPTS; i++) {
      expect(registry.recordPendingReindexAttempt(root)).toBe(i);
      // Still within budget — the forced rebuild is allowed to run.
      expect(registry.getProject(root)?.pendingReindexForVersion).toBe('2.0.0');
    }

    // One restart past the cap: the daemon drops the flag instead of
    // force-rebuilding forever.
    expect(registry.recordPendingReindexAttempt(root)).toBeGreaterThan(
      registry.MAX_PENDING_REINDEX_ATTEMPTS,
    );
  });

  it('clearPendingReindex also clears the attempt counter', () => {
    const root = addProject('proj');
    registry.markAllProjectsPendingReindex('2.0.0');
    registry.recordPendingReindexAttempt(root);

    registry.clearPendingReindex(root);

    const entry = registry.getProject(root);
    expect(entry?.pendingReindexForVersion).toBeUndefined();
    expect(entry?.pendingReindexAttempts).toBeUndefined();
  });

  it('a new version resets the attempt counter', () => {
    const root = addProject('proj');
    registry.markAllProjectsPendingReindex('2.0.0');
    registry.recordPendingReindexAttempt(root);
    registry.recordPendingReindexAttempt(root);

    registry.markAllProjectsPendingReindex('2.1.0');

    expect(registry.getProject(root)?.pendingReindexAttempts).toBeUndefined();
    expect(registry.recordPendingReindexAttempt(root)).toBe(1);
  });
});
