/* TRA-1607: the desktop app shares daemon-spawn.lock with the CLI
   (src/daemon/lifecycle.ts). Same file, same format, same stale rule. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireSpawnLock,
  releaseSpawnLock,
  SPAWN_LOCK_NAME,
  SPAWN_LOCK_STALE_MS,
} from '../daemon-install';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-spawn-lock-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('desktop spawn lock (TRA-1607)', () => {
  it('acquires and releases', () => {
    expect(acquireSpawnLock(home)).toBe(true);
    expect(fs.existsSync(path.join(home, SPAWN_LOCK_NAME))).toBe(true);
    releaseSpawnLock(home);
    expect(fs.existsSync(path.join(home, SPAWN_LOCK_NAME))).toBe(false);
  });

  it('a second acquire fails while the first is held', () => {
    expect(acquireSpawnLock(home)).toBe(true);
    // Same process, second handle: the file names our own pid and is fresh,
    // so from the lock's point of view it is held (CLI and app are separate
    // processes in production; here the live-pid check is what refuses).
    expect(acquireSpawnLock(home)).toBe(false);
    releaseSpawnLock(home);
    expect(acquireSpawnLock(home)).toBe(true);
    releaseSpawnLock(home);
  });

  it('reclaims a lock whose holder is dead', () => {
    fs.writeFileSync(path.join(home, SPAWN_LOCK_NAME), '999999999\n');
    expect(acquireSpawnLock(home)).toBe(true);
    releaseSpawnLock(home);
  });

  it('reclaims a stale lock even when the holder pid is alive', () => {
    // Our own pid is alive by definition; age it past the stale window.
    fs.writeFileSync(path.join(home, SPAWN_LOCK_NAME), `${process.pid}\n`);
    const old = Date.now() - SPAWN_LOCK_STALE_MS - 1_000;
    fs.utimesSync(path.join(home, SPAWN_LOCK_NAME), new Date(old), new Date(old));
    expect(acquireSpawnLock(home)).toBe(true);
    releaseSpawnLock(home);
  });

  it('release does not remove a lock owned by someone else', () => {
    fs.writeFileSync(path.join(home, SPAWN_LOCK_NAME), '999999999\n');
    // 999999999 is not us and (almost surely) not alive — but release must
    // not unlink a file that does not name our pid regardless.
    releaseSpawnLock(home);
    expect(fs.existsSync(path.join(home, SPAWN_LOCK_NAME))).toBe(true);
  });

  it('uses the same file name the CLI uses', () => {
    expect(SPAWN_LOCK_NAME).toBe('daemon-spawn.lock');
  });
});
