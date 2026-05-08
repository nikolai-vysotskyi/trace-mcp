/**
 * Handshake watchdog for the stdio MCP transport.
 *
 * If the MCP client never sends its first JSON-RPC frame within the
 * configured budget, write a one-line diagnostic to stderr listing the
 * common failure modes (stdout-corruption from npm/pnpm/uvx output,
 * wrong binary path). Best-effort — server keeps running. Mirrors
 * jcodemunch v1.82.1.
 *
 * Extracted from StdioSession so the timer + diagnostic content can be
 * unit-tested in isolation without spinning up a real stdio transport.
 */

export interface HandshakeWatchdogOptions {
  /** Wall-clock budget. <=0 disables the watchdog (no-op). */
  timeoutMs: number;
  /**
   * Diagnostic sink. Real production uses `process.stderr.write`;
   * tests inject a fake. Must NEVER be process.stdout.write — that
   * would itself corrupt the JSON-RPC frame this code is debugging.
   */
  write: (line: string) => void;
}

export interface HandshakeWatchdog {
  /** Mark the handshake as observed; cancels the pending timer. */
  observe(): void;
  /** Cancel the pending timer without marking observed (for shutdown). */
  cancel(): void;
}

/**
 * Default budget. Read from env so operators can tune without rebuilding.
 * Mirrors jcodemunch's `JCODEMUNCH_HANDSHAKE_TIMEOUT` semantics:
 * `0` disables, anything else is interpreted as ms.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

export function resolveHandshakeTimeout(
  optsValue: number | undefined,
  envValue: string | undefined,
  fallback: number = DEFAULT_HANDSHAKE_TIMEOUT_MS,
): number {
  if (typeof optsValue === 'number' && Number.isFinite(optsValue) && optsValue >= 0) {
    return Math.floor(optsValue);
  }
  const parsed = parseEnvInt(envValue);
  if (parsed !== undefined) return parsed;
  return fallback;
}

function parseEnvInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}

/**
 * Build the diagnostic line printed when the watchdog fires. Pure function
 * so it's testable. Wording deliberately mentions concrete escape hatches
 * (env vars, absolute path) rather than just "investigate".
 */
export function handshakeDiagnosticLine(timeoutMs: number): string {
  return (
    `[trace-mcp] no MCP handshake within ${timeoutMs}ms. Common causes:\n` +
    '  1. stdout corruption from a wrapper (npm/pnpm/npx/uvx progress, postinstall scripts)\n' +
    '     → install the binary directly and point your MCP client at the absolute path,\n' +
    '       or set NPM_CONFIG_PROGRESS=false / UV_NO_PROGRESS=1 in the spawn env.\n' +
    '  2. wrong command path in your MCP client config (binary not found, started but never wired up)\n' +
    '  3. genuinely slow client — set TRACE_MCP_HANDSHAKE_TIMEOUT=15000 (or =0 to disable).\n'
  );
}

/**
 * Arm a one-shot timer. Returns a `HandshakeWatchdog` whose `observe()`
 * cancels the timer (called on first inbound JSON-RPC frame), and whose
 * `cancel()` cancels without firing (called on shutdown).
 *
 * If `timeoutMs <= 0`, returns a no-op watchdog.
 */
export function createHandshakeWatchdog(opts: HandshakeWatchdogOptions): HandshakeWatchdog {
  if (opts.timeoutMs <= 0) {
    return { observe: () => {}, cancel: () => {} };
  }

  let fired = false;
  let observed = false;

  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    if (observed) return;
    fired = true;
    try {
      opts.write(handshakeDiagnosticLine(opts.timeoutMs));
    } catch {
      /* sink errors must not surface to the JSON-RPC stream */
    }
  }, opts.timeoutMs);

  // Don't keep the event loop alive on the watchdog alone.
  timer.unref?.();

  return {
    observe(): void {
      if (observed || fired) return;
      observed = true;
      clearTimeout(timer);
    },
    cancel(): void {
      if (observed || fired) return;
      observed = true; // treat as observed to suppress later fire
      clearTimeout(timer);
    },
  };
}
