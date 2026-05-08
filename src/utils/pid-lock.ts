/**
 * Per-target PID lock for long-running mutator operations (reindex,
 * embed_repo, etc.).
 *
 * Two MCP clients can spawn concurrent `reindex` calls on the same project —
 * either by accident (an Edit hook fires while the user manually triggers
 * reindex) or because two daemons share a project root. Without a lock both
 * runs walk the same SQLite, write overlapping batches, and may bloat the
 * vector store with duplicate embeddings. mempalace ran into this enough
 * (#1023, #1212, #1415) that they ship a per-target PID file with atomic
 * O_EXCL claim plus stale-lock recovery.
 *
 * Lock file format:
 *   { pid: number, started_at: number, hostname: string, op: string }
 *
 * Acquire path:
 *   1. Try O_EXCL create. If it succeeds, we own the lock.
 *   2. On EEXIST, read the existing lock and check liveness with `kill(pid, 0)`.
 *      Different host → assume stale (we can't probe). Same host + alive → refuse.
 *      Same host + dead → delete the stale lock and retry once.
 *
 * Release: unlink. Always best-effort — never throw on release.
 *
 * The lock files live in ~/.trace-mcp/locks/<projectHash>-<op>.pid so they
 * are scoped to (project, operation) and don't block other operations or
 * other projects.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LockHandle {
  /** Absolute path to the lock file. Released via releaseLock(). */
  filePath: string;
  /** PID written into the lock — should match process.pid. */
  pid: number;
}

export interface LockHolder {
  pid: number;
  hostname: string;
  op: string;
  /** Wall-clock timestamp at acquire (ms). */
  started_at: number;
}

export class LockError extends Error {
  constructor(
    message: string,
    public readonly holder: LockHolder | null,
  ) {
    super(message);
    this.name = 'LockError';
  }
}

interface AcquireOptions {
  /**
   * Directory where lock files live. Defaults to `${TRACE_MCP_HOME}/locks`,
   * but is injectable for tests.
   */
  lockDir: string;
  /**
   * Logical lock name (e.g. `<projectHash>-reindex`). Becomes the file basename.
   */
  name: string;
  /**
   * Operation tag stored inside the lock for diagnostics. Default: name.
   */
  op?: string;
}

function lockFilePath(opts: AcquireOptions): string {
  return path.join(opts.lockDir, `${opts.name}.pid`);
}

function readHolder(filePath: string): LockHolder | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.op !== 'string' ||
      typeof parsed.started_at !== 'number'
    ) {
      return null;
    }
    return parsed as LockHolder;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    // Signal 0 doesn't actually deliver a signal — it's a permission/existence probe.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM means a process with that PID exists but we can't signal it →
    // treat as alive (someone else owns it).
    return code === 'EPERM';
  }
}

/**
 * Try to acquire `name`. Throws {@link LockError} when the lock is held by a
 * live process on the same host. Stale locks from dead processes (or from a
 * different host — we can't probe) are reclaimed automatically.
 */
export function acquireLock(opts: AcquireOptions): LockHandle {
  fs.mkdirSync(opts.lockDir, { recursive: true });
  const filePath = lockFilePath(opts);
  const op = opts.op ?? opts.name;
  const hostname = os.hostname();

  const tryClaim = (): LockHandle | null => {
    const payload: LockHolder = {
      pid: process.pid,
      started_at: Date.now(),
      hostname,
      op,
    };
    // Atomic create+exclusive — fails with EEXIST if anyone else got there first.
    const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(
        tmp,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      fs.writeFileSync(fd, JSON.stringify(payload));
      try {
        fs.fsyncSync(fd);
      } catch {
        // best-effort
      }
      fs.closeSync(fd);
      fd = null;
      // link the tmp into the canonical path under O_EXCL semantics.
      // linkSync fails with EEXIST if another writer claimed in between.
      fs.linkSync(tmp, filePath);
      fs.unlinkSync(tmp);
      return { filePath, pid: process.pid };
    } catch (e) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignored
        }
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignored
      }
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return null; // canonical path is held — caller decides
      throw e;
    }
  };

  // First attempt — common path.
  let claimed = tryClaim();
  if (claimed) return claimed;

  // Held — examine the holder.
  const holder = readHolder(filePath);
  if (!holder) {
    // Unparseable lock file — treat as stale.
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignored
    }
    claimed = tryClaim();
    if (claimed) return claimed;
    throw new LockError(`Lock ${filePath} held by an unidentifiable process`, null);
  }

  const sameHost = holder.hostname === hostname;
  const alive = sameHost && processIsAlive(holder.pid);
  if (alive) {
    throw new LockError(
      `Lock held by pid=${holder.pid} (${holder.op}) on ${holder.hostname}, started ${new Date(holder.started_at).toISOString()}`,
      holder,
    );
  }

  // Stale (dead PID on this host, or different host so we can't tell — we
  // err on the side of clearing rather than blocking forever).
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignored — possibly already cleaned up by the holder
  }
  claimed = tryClaim();
  if (claimed) return claimed;
  // Someone raced us in — surface the new holder.
  const newHolder = readHolder(filePath);
  throw new LockError(
    `Lock ${filePath} reclaimed by another process: ${JSON.stringify(newHolder)}`,
    newHolder,
  );
}

/**
 * Release a lock. Best-effort — never throws. Safe to call multiple times.
 */
export function releaseLock(handle: LockHandle): void {
  try {
    // Only unlink if the lock still belongs to us — defensive guard against
    // releasing a lock another process reclaimed after we crashed and
    // restarted with the same PID (rare, but possible on long-running daemons).
    const holder = readHolder(handle.filePath);
    if (holder && holder.pid !== handle.pid) return;
    fs.unlinkSync(handle.filePath);
  } catch {
    // ignored — file may already be gone
  }
}

/**
 * Run `fn` while holding `name`. Releases the lock on success or failure.
 */
export async function withLock<T>(opts: AcquireOptions, fn: () => Promise<T>): Promise<T> {
  const handle = acquireLock(opts);
  try {
    return await fn();
  } finally {
    releaseLock(handle);
  }
}
