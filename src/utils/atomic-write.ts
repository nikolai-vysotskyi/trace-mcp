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
  const mode = opts.mode ?? 0o644;
  const trailingNewline = opts.trailingNewline ?? true;
  const rejectSymlinks = opts.rejectSymlinks ?? true;

  if (rejectSymlinks) {
    let linkStat: fs.Stats | null = null;
    try {
      linkStat = fs.lstatSync(targetPath);
    } catch {
      // ENOENT — fine, target doesn't exist yet
    }
    if (linkStat && linkStat.isSymbolicLink()) {
      throw new Error(
        `atomic-write: refusing to overwrite symlink at ${targetPath}. ` +
          'Pass rejectSymlinks:false to allow writing through symlinks.',
      );
    }
  }

  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const rand = randomBytes(6).toString('hex');
  const tmp = path.join(dir, `.${base}.tmp.${process.pid}.${rand}`);

  const body = trailingNewline && !payload.endsWith('\n') ? `${payload}\n` : payload;

  let fd: number | null = null;
  try {
    // O_EXCL prevents accidental clobber of a same-pid+rand collision. mode
    // is applied at create time (before any data is visible at the target).
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    fs.writeFileSync(fd, body);
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
