/**
 * Atomic-write helpers for state files (config, canaries, ledgers, registries).
 *
 * Pattern: write payload to a per-process tmp file, fsync, rename onto target.
 * A crash mid-write leaves the target intact (untouched original or absent),
 * never a half-written file. The tmp suffix includes pid + random bits so two
 * writers racing on the same target don't clobber each other's tmps.
 *
 * Also rejects symlinks at the target before writing — without this, a writer
 * with broader fs perms could be tricked into overwriting an arbitrary file
 * via a symlink planted at the target path (TOCTOU). Mirrors mempalace
 * #1156 / #1405.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AtomicWriteOptions {
  /**
   * Octal mode for the destination file (e.g. 0o600 for secrets). Applied to
   * the tmp before rename so the target is never visible with looser perms.
   * Default: 0o644.
   */
  mode?: number;
  /**
   * Pretty-print indent for JSON. Defaults to 2; pass 0 for a single line.
   * Only used by atomicWriteJson.
   */
  indent?: number;
  /**
   * Append a trailing newline. Default: true.
   */
  trailingNewline?: boolean;
  /**
   * Reject the write if `targetPath` is currently a symlink. Default: true.
   * Disable only when you know the target is intentionally symlinked and
   * the link target is trusted.
   */
  rejectSymlinks?: boolean;
}

/**
 * Atomically write a string to disk. The directory of `targetPath` must
 * already exist; this function does not mkdir.
 */
export function atomicWriteString(
  targetPath: string,
  payload: string,
  opts: AtomicWriteOptions = {},
): void {
  const trailingNewline = opts.trailingNewline ?? true;
  const body = trailingNewline && !payload.endsWith('\n') ? `${payload}\n` : payload;
  atomicWriteBuffer(targetPath, Buffer.from(body, 'utf-8'), opts);
}

/**
 * Atomically write raw bytes to disk — same tmp + O_EXCL + fsync + rename and
 * the same symlink rejection as {@link atomicWriteString}, minus the UTF-8
 * round-trip. Use this for anything that is not text: SQLite databases and
 * their WAL/SHM sidecars, binaries, archives. Passing such content through
 * `atomicWriteString` replaces every non-UTF-8 byte with U+FFFD, which for a
 * database is silent, unrecoverable corruption (TRA-732).
 *
 * `trailingNewline` is ignored here — bytes are written verbatim.
 */
export function atomicWriteBuffer(
  targetPath: string,
  payload: Buffer,
  opts: AtomicWriteOptions = {},
): void {
  const rejectSymlinks = opts.rejectSymlinks ?? true;

  let linkStat: fs.Stats | null = null;
  try {
    linkStat = fs.lstatSync(targetPath);
  } catch {
    // ENOENT — fine, target doesn't exist yet
  }

  if (rejectSymlinks && linkStat && linkStat.isSymbolicLink()) {
    throw new Error(
      `atomic-write: refusing to overwrite symlink at ${targetPath}. ` +
        'Pass rejectSymlinks:false to allow writing through symlinks.',
    );
  }

  // Preserve existing permissions on rewrite if no explicit mode was requested
  let mode = opts.mode;
  if (mode === undefined) {
    if (linkStat && linkStat.isFile()) {
      mode = linkStat.mode & 0o777;
    } else {
      mode = 0o644;
    }
  }

  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const rand = randomBytes(6).toString('hex');
  const tmp = path.join(dir, `.${base}.tmp.${process.pid}.${rand}`);

  let fd: number | null = null;
  try {
    // O_EXCL prevents accidental clobber of a same-pid+rand collision. mode
    // is applied at create time (before any data is visible at the target).
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    fs.writeFileSync(fd, payload);
    // fsync: ensure data is on disk before the rename publishes it. Best-effort
    // — some filesystems (network, fuse) may not honour this, but POSIX rename
    // is still atomic at the directory entry level.
    try {
      fs.fsyncSync(fd);
    } catch {
      // ignored — rename is still atomic
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, targetPath);
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
      // ignored — tmp may not exist
    }
    throw e;
  }
}

/**
 * Tmp files written by {@link atomicWriteString}: `.<basename>.tmp.<pid>.<rand>`.
 * The trailing hex is what keeps this from matching a user file that merely has
 * ".tmp." in its name.
 */
const ORPHAN_TMP_PATTERN = /^\..+\.tmp\.\d+\.[0-9a-f]{12}$/;

/** Default age before a leftover tmp is assumed orphaned rather than in flight. */
const ORPHAN_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete atomic-write tmp files in `dir` older than `maxAgeMs` (TRA-702).
 *
 * The write path above unlinks its own tmp on error, but a process killed
 * between `open` and `rename` never runs that handler — so every crash leaks
 * one file, forever. Twelve had accumulated in ~/.trace-mcp, the oldest four
 * months old.
 *
 * The age cutoff is the safety margin: a tmp younger than it may belong to a
 * write still in flight in another process, and removing that would turn a
 * healthy write into a spurious failure. Best-effort throughout — a sweep that
 * cannot read the directory is not worth failing a daemon start over.
 */
export function sweepOrphanTmpFiles(dir: string, maxAgeMs = ORPHAN_TMP_MAX_AGE_MS): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no state dir yet, or unreadable — nothing to collect
  }

  const cutoff = Date.now() - maxAgeMs;
  const removed: string[] = [];
  for (const name of names) {
    if (!ORPHAN_TMP_PATTERN.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.mtimeMs > cutoff) continue;
      fs.unlinkSync(full);
      removed.push(full);
    } catch {
      // vanished under us, or not ours to delete — either way, skip it
    }
  }
  return removed;
}

/**
 * Atomically write a JSON-serialisable value to disk with a trailing newline.
 * Convenience wrapper around {@link atomicWriteString}.
 */
export function atomicWriteJson(
  targetPath: string,
  data: unknown,
  opts: AtomicWriteOptions = {},
): void {
  const indent = opts.indent ?? 2;
  const payload = JSON.stringify(data, null, indent);
  atomicWriteString(targetPath, payload, opts);
}
