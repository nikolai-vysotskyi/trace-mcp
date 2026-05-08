/**
 * Path relativisation for MCP tool responses.
 *
 * Most trace-mcp tools already return repo-relative paths (the indexer stores
 * them that way). The leakage points are user-supplied inputs that the agent
 * passes through — most notably `file_path` on decisions and similar
 * memory-store entries. When the agent passes an absolute path it gets stored
 * verbatim, then surfaced in `query_decisions` / `get_decision_timeline` /
 * `get_wake_up`. Mirroring that decision into another project (or another
 * machine) then leaks the original `/Users/<name>/...` path.
 *
 * `relativizeUnderRoot` is a one-way transform: if `target` is absolute and
 * lies inside `root`, return the path relative to `root` (POSIX-normalised);
 * otherwise return `target` unchanged. Always normalises Windows separators
 * to forward slashes so stored paths compare equal across OSes.
 *
 * Mirrors mempalace #1325.
 */
import path from 'node:path';

/**
 * Normalise a file path so the trailing comparison can be done with
 * forward-slash form on both POSIX and Windows.
 */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * If `target` is absolute and inside `root`, return a POSIX-normalised
 * relative path. Otherwise return `target` unchanged. Returns `null` /
 * `undefined` unchanged (so it composes with optional fields).
 */
export function relativizeUnderRoot(
  target: string | null | undefined,
  root: string,
): string | null | undefined {
  if (target === null || target === undefined) return target;
  if (!path.isAbsolute(target)) return target;
  const absRoot = path.resolve(root);
  const absTarget = path.resolve(target);
  // Use path.relative; if the result starts with `..` the target is OUTSIDE
  // the root and we leave it alone (e.g. references to ~/.claude/projects/).
  const rel = path.relative(absRoot, absTarget);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return target;
  }
  return toPosix(rel);
}
