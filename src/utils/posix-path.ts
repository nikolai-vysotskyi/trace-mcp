/**
 * Cross-platform "already absolute" path normalization (TRA-73).
 *
 * `path.resolve('/foo/bar')` on win32 treats a leading `/` as drive-relative
 * and rewrites it onto `process.cwd()`'s current drive (`D:\foo\bar`) instead
 * of leaving it alone. That corrupts anything that's already absolute in
 * POSIX form: values stored/compared across machines (topology.db
 * `repo_root`, project-hash inputs), test fixtures using `/...` literals, and
 * Git-Bash-style CLI args on Windows. The bug reproduces identically whenever
 * plain `path.resolve()` is used to "canonicalize" a path that's already
 * absolute — see subproject/resolve.ts, lsp/mappers.ts, cli/prune.ts,
 * cli/remove.ts for call sites bitten by this on Windows CI.
 *
 * `toPosixAbsolute` only routes a genuinely *relative* path through
 * `path.resolve()` (against `process.cwd()`); an already-absolute path (POSIX
 * `/...` or Windows `C:\...`) is just separator-normalized.
 */
import path from 'node:path';

export function toPosixAbsolute(p: string): string {
  const slashified = p.replace(/\\/g, '/');
  const isAbsolute = path.posix.isAbsolute(slashified) || /^[a-zA-Z]:\//.test(slashified);
  return isAbsolute ? path.posix.normalize(slashified) : path.resolve(p).replace(/\\/g, '/');
}
