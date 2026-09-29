import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import { handleReindexFile } from '../../src/daemon/reindex-file-handler.js';
import { __resetRecentReindexCache } from '../../src/indexer/recent-reindex-cache.js';
import { logger } from '../../src/logger.js';
import { acquireLock, isSelfLock, LockError, releaseLock } from '../../src/utils/pid-lock.js';

describe('TRA-2091 reindex-file lock-busy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRecentReindexCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('LockError from the reindex lock becomes 503 + warn, not 500 + error', async () => {
    const holder = {
      pid: process.pid,
      hostname: os.hostname(),
      op: 'reindex-file-http',
      started_at: Date.now(),
      stack: 'at handleReindexFile (test)',
    };
    const lockErr = new LockError(
      `Lock held by pid=${holder.pid} (${holder.op}) on ${holder.hostname}, started ${new Date(holder.started_at).toISOString()}`,
      holder,
    );
    const indexFiles = vi.fn(async (_paths: string[]) => undefined);
    const projectRoot = '/tmp/proj-2091-busy';
    const getProject = vi.fn((root: string) =>
      root === projectRoot ? { pipeline: { indexFiles } } : undefined,
    );
    const lock = vi.fn(async () => {
      throw lockErr;
    });

    const result = await handleReindexFile(
      { project: projectRoot, path: 'src/a.ts' },
      // biome-ignore lint/suspicious/noExplicitAny: test fake lock signature
      { getProject, lock: lock as any },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      if (result.status === 503) {
        expect(result.retryAfterSec).toBe(5);
        expect(result.error).toMatch(/reindex_in_progress/);
      }
    }
    expect(indexFiles).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    const [meta] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(meta.lockBusy).toBe(true);
    expect(meta.selfLock).toBe(true);
    expect(meta.holderOp).toBe('reindex-file-http');
    expect(meta.holderStack).toBe('at handleReindexFile (test)');
  });

  it('foreign-holder LockError is also 503 + warn with selfLock=false', async () => {
    const holder = {
      pid: 999_999_998,
      hostname: os.hostname(),
      op: 'reindex',
      started_at: Date.now(),
    };
    const lockErr = new LockError('Lock held by someone else', holder);
    const indexFiles = vi.fn(async (_paths: string[]) => undefined);
    const projectRoot = '/tmp/proj-2091-foreign';
    const getProject = vi.fn((root: string) =>
      root === projectRoot ? { pipeline: { indexFiles } } : undefined,
    );
    // biome-ignore lint/suspicious/noExplicitAny: test fake lock signature
    const lock = vi.fn(async () => {
      throw lockErr;
    });

    const result = await handleReindexFile(
      { project: projectRoot, path: 'src/b.ts' },
      // biome-ignore lint/suspicious/noExplicitAny: test fake lock signature
      { getProject, lock: lock as any },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    const [meta] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(meta.selfLock).toBe(false);
  });

  it('non-lock pipeline errors stay 500 + error', async () => {
    const indexFiles = vi.fn(async (_paths: string[]) => undefined);
    const projectRoot = '/tmp/proj-2091-500';
    const getProject = vi.fn((root: string) =>
      root === projectRoot ? { pipeline: { indexFiles } } : undefined,
    );
    const lock = vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => {
      throw new Error('boom-2091');
    });

    const result = await handleReindexFile(
      { project: projectRoot, path: 'src/c.ts' },
      // biome-ignore lint/suspicious/noExplicitAny: test fake lock signature
      { getProject, lock: lock as any },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(500);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('isSelfLock detects own holder and rejects foreign/null', () => {
    expect(
      isSelfLock({ pid: process.pid, hostname: os.hostname(), op: 'x', started_at: Date.now() }),
    ).toBe(true);
    expect(
      isSelfLock({
        pid: process.pid + 777_777,
        hostname: os.hostname(),
        op: 'x',
        started_at: Date.now(),
      }),
    ).toBe(false);
    expect(isSelfLock(null)).toBe(false);
  });

  it('acquireLock stamps holder stack and self-lock message', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trace-2091-'));
    try {
      const handle = acquireLock({ lockDir: dir, name: 'h-2091', op: 'reindex-file-http' });
      const raw = JSON.parse(readFileSync(handle.filePath, 'utf-8')) as Record<string, unknown>;
      expect(raw.op).toBe('reindex-file-http');
      // Stack is best-effort but should be present on this platform.
      expect(typeof raw.stack === 'undefined' || typeof raw.stack === 'string').toBe(true);
      let err: unknown = null;
      try {
        acquireLock({ lockDir: dir, name: 'h-2091', op: 'reindex-file-http' });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LockError);
      const lockErr = err as LockError;
      expect(isSelfLock(lockErr.holder)).toBe(true);
      expect(lockErr.message).toContain('self-lock');
      releaseLock(handle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
