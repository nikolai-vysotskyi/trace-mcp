import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  LockError,
  type LockHolder,
  releaseLock,
  withLock,
} from '../../src/utils/pid-lock.js';

describe('pid-lock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-pid-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires a fresh lock and writes a valid holder payload', () => {
    const handle = acquireLock({ lockDir: dir, name: 'h-reindex' });
    const holder = JSON.parse(readFileSync(handle.filePath, 'utf-8')) as LockHolder;
    expect(holder.pid).toBe(process.pid);
    expect(holder.op).toBe('h-reindex');
    expect(holder.hostname).toBeTruthy();
    expect(holder.started_at).toBeGreaterThan(0);
    releaseLock(handle);
  });

  it('refuses to double-acquire the same lock from the same process', () => {
    const handle = acquireLock({ lockDir: dir, name: 'h-double' });
    expect(() => acquireLock({ lockDir: dir, name: 'h-double' })).toThrowError(LockError);
    releaseLock(handle);
  });

  it('does not block when the existing lock points at a dead PID', () => {
    // Plant a stale lock with PID=1 (but on this host, so we can probe).
    // PID=1 is init/launchd — alive. PID=999999999 is essentially never alive.
    const lockPath = join(dir, 'h-stale.pid');
    const stale: LockHolder = {
      pid: 999_999_999,
      hostname: require('node:os').hostname(),
      op: 'reindex',
      started_at: Date.now() - 86_400_000,
    };
    writeFileSync(lockPath, JSON.stringify(stale));
    const handle = acquireLock({ lockDir: dir, name: 'h-stale' });
    expect(handle.pid).toBe(process.pid);
    releaseLock(handle);
  });

  it('blocks when the existing lock is held by a live process on the same host', () => {
    const lockPath = join(dir, 'h-live.pid');
    const live: LockHolder = {
      pid: process.pid, // we are alive
      hostname: require('node:os').hostname(),
      op: 'reindex',
      started_at: Date.now(),
    };
    writeFileSync(lockPath, JSON.stringify(live));
    let err: unknown = null;
    try {
      acquireLock({ lockDir: dir, name: 'h-live' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LockError);
    const lockErr = err as LockError;
    expect(lockErr.holder?.pid).toBe(process.pid);
    expect(lockErr.message).toContain('Lock held by pid=');
  });

  it('treats unparseable lock files as stale', () => {
    const lockPath = join(dir, 'h-bad.pid');
    writeFileSync(lockPath, 'not json');
    const handle = acquireLock({ lockDir: dir, name: 'h-bad' });
    expect(handle.pid).toBe(process.pid);
    releaseLock(handle);
  });

  it('release is idempotent and safe to call twice', () => {
    const handle = acquireLock({ lockDir: dir, name: 'h-idempotent' });
    releaseLock(handle);
    expect(() => releaseLock(handle)).not.toThrow();
  });

  it('release does not unlink a lock another process claimed under our nose', () => {
    const handle = acquireLock({ lockDir: dir, name: 'h-stolen' });
    // simulate someone else stealing the slot — overwrite the holder file
    writeFileSync(
      handle.filePath,
      JSON.stringify({
        pid: process.pid + 7777,
        hostname: require('node:os').hostname(),
        op: 'reindex',
        started_at: Date.now(),
      }),
    );
    releaseLock(handle);
    // The file must still exist — the other process owns it now.
    expect(() => statSync(handle.filePath)).not.toThrow();
  });

  it('withLock releases on success', async () => {
    const result = await withLock({ lockDir: dir, name: 'h-withlock-ok' }, async () => 42);
    expect(result).toBe(42);
    expect(() => statSync(join(dir, 'h-withlock-ok.pid'))).toThrow();
  });

  it('withLock releases on failure', async () => {
    await expect(
      withLock({ lockDir: dir, name: 'h-withlock-fail' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(() => statSync(join(dir, 'h-withlock-fail.pid'))).toThrow();
  });
});
