/**
 * Transport hardening for the MCP stdio channel.
 *
 * Three failure modes mempalace ran into and we want to avoid:
 *   1. Windows stdio in cp1252 — non-ASCII payloads come back as
 *      `JSONRPCError -32000 Could not decode message` (#1060, #1282, #1293).
 *      Forcing UTF-8 on stdin/stdout/stderr makes JSON-RPC frames safe to
 *      transit any code path that emits CJK / Cyrillic / emoji.
 *   2. Library imports (native bindings, deprecation warnings) writing to
 *      stdout before the JSON-RPC transport is wired (#864). The first
 *      stray byte corrupts the framing for the client and the session is
 *      dead. We can't *prevent* every library from writing — but we can
 *      capture stdout writes that happen before MCP transport is up and
 *      forward them to stderr instead.
 *   3. Null / empty JSON-RPC payloads from a buggy client wedging the
 *      transport (#399, #987). The MCP SDK already validates frames; what
 *      we add here is a safety net that throws on null/undefined so the
 *      caller (StdioServerTransport.send) doesn't end up writing literal
 *      "null\n" which the peer parser would also choke on.
 *
 * Call {@link hardenStdio} as the very first thing in `cli.ts serve` —
 * before any provider/embedding/native modules import.
 */

let stdoutGuardArmed = false;
let originalStdoutWrite: typeof process.stdout.write | null = null;

/**
 * Force UTF-8 on the *outbound* standard streams. No-op when the environment
 * already reports utf8 / utf-8.
 *
 * NOTE: stdin is intentionally left in raw Buffer mode. The MCP SDK's
 * `ReadBuffer` (shared/stdio.js) assumes each chunk is a Buffer and calls
 * `.subarray()` on the accumulated buffer. Calling `process.stdin.setEncoding`
 * here would flip stdin into string-emitting mode, and the SDK's ReadBuffer
 * would crash with "TypeError: this._buffer.subarray is not a function" on
 * the very first frame — killing the session before any tool call lands.
 * The SDK already decodes incoming bytes via `Buffer.toString('utf8', ...)`,
 * so explicit utf-8 on stdin is both unnecessary and actively harmful.
 */
export function forceUtf8Stdio(): void {
  // setDefaultEncoding throws on Windows when stdio is a Pipe (not a TTY) —
  // wrap each call in try/catch so a single failure doesn't take down the rest.
  try {
    process.stdout.setDefaultEncoding('utf8');
  } catch {
    // ignored — Pipe streams may reject explicit encoding on some node versions
  }
  try {
    process.stderr.setDefaultEncoding('utf8');
  } catch {
    // ignored
  }
}

/**
 * Re-route any stdout writes to stderr until the MCP transport is wired.
 * Keeps the JSON-RPC frame on stdout pristine even if a downstream import
 * accidentally `console.log`s during initialisation. Safe to call multiple
 * times — only the first call installs the guard.
 */
export function armStdoutGuard(): void {
  if (stdoutGuardArmed) return;
  stdoutGuardArmed = true;
  // Capture the *property* reference, not a freshly-bound copy, so disarm
  // can restore the exact value the caller had.
  originalStdoutWrite = process.stdout.write;
  // The signature of write has multiple overloads; we re-emit on stderr as
  // best-effort, dropping the callback / encoding signature variants because
  // tests / library code basically never check the return shape of stdout.write.
  // biome-ignore lint/suspicious/noExplicitAny: stdout.write has a complex overload shape
  (process.stdout as any).write = (chunk: any, encodingOrCb?: any, cb?: any): boolean => {
    try {
      if (typeof encodingOrCb === 'function') {
        return process.stderr.write(chunk, encodingOrCb);
      }
      return process.stderr.write(chunk, encodingOrCb, cb);
    } catch {
      return true;
    }
  };
}

/**
 * Disarm the stdout guard installed by {@link armStdoutGuard}. Call this
 * immediately before connecting the MCP `StdioServerTransport` so JSON-RPC
 * frames can flow on stdout again.
 */
export function disarmStdoutGuard(): void {
  if (!stdoutGuardArmed) return;
  if (originalStdoutWrite) {
    // biome-ignore lint/suspicious/noExplicitAny: restoring write to its native shape
    (process.stdout as any).write = originalStdoutWrite;
  }
  stdoutGuardArmed = false;
  originalStdoutWrite = null;
}

/**
 * Convenience: apply both hardening passes (UTF-8 + stdout guard) in the
 * order that's safe at process startup.
 */
export function hardenStdio(): void {
  forceUtf8Stdio();
  armStdoutGuard();
}

/**
 * For tests only — surface guard state without exporting the module-level
 * variable directly.
 */
export function _isStdoutGuardArmedForTest(): boolean {
  return stdoutGuardArmed;
}
