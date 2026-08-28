/**
 * Race-free file read/write helpers.
 *
 * `fs.existsSync(p)` followed later by `fs.readFileSync(p)` / `fs.writeFileSync(p)`
 * is a TOCTOU (time-of-check to time-of-use) race: the file can be created,
 * deleted, or swapped between the check and the use. CodeQL flags this shape
 * as `js/file-system-race`.
 *
 * These helpers replace the check-then-use pattern with a single read wrapped
 * in try/catch for ENOENT, which is atomic with respect to the check.
 */
import fs from 'node:fs';

/** True when `err` is a Node.js ENOENT (file/dir does not exist) error. */
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Read `path` as utf-8 text, or `null` if it doesn't exist.
 *
 * Unlike `fs.existsSync(path) ? fs.readFileSync(path, 'utf-8') : null`, this
 * does a single `readFileSync` — there's no window between checking and
 * reading where the file could disappear out from under the check.
 *
 * Non-ENOENT errors (permission denied, EISDIR, etc.) are rethrown.
 *
 * Trust note (CodeQL js/path-injection): this helper does no path validation
 * on purpose — it is a mechanical replacement for an inline `readFileSync`,
 * so `path` carries exactly the trust its caller already had, no more and no
 * less. Call sites pass paths under `~/.trace-mcp` or under the project root
 * the daemon was pointed at; CodeQL traces the latter back to the
 * `X-Trace-Project` hint on the loopback `/mcp` endpoint. Whether that
 * endpoint is a trust boundary is a separate, pre-existing question —
 * see TRA-301. Validating here would only move the check away from the
 * callers that know what a legal path is.
 */
export function readIfExists(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * Write `content` to `path` only if it differs from the file's current
 * content (a missing file counts as "different"). Returns whether it wrote.
 *
 * Uses {@link readIfExists} internally, so the read half of the
 * compare-then-write is race-free too.
 */
export function writeIfChanged(path: string, content: string): boolean {
  const current = readIfExists(path);
  if (current === content) return false;
  fs.writeFileSync(path, content, 'utf-8');
  return true;
}
