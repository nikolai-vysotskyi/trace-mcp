/**
 * Serialize an unknown caught value into a log-safe plain object.
 *
 * Why this exists: pino's default `err` serializer only fires when the log
 * payload key is literally `err`. Many call sites in this codebase use `error:`,
 * and a raw `Error` passed under any non-`err` key gets JSON.stringify'd. Error's
 * `message` and `stack` are non-enumerable, so the emitted record collapses to
 * `{"code":"SQLITE_ERROR"}` and the actual SQLite message ("database disk image
 * is malformed", "no such table: foo", etc.) is lost — making operator triage
 * effectively impossible from the daemon log.
 *
 * This helper extracts the fields we actually want — name, message, stack, code,
 * codeName (better-sqlite3 extended result codes like SQLITE_CORRUPT_VTAB) — and
 * returns a plain object that survives JSON.stringify intact.
 */
export interface SerializedError {
  name?: string;
  message?: string;
  stack?: string;
  code?: string;
  codeName?: string;
}

export function serializeError(err: unknown): SerializedError | string {
  if (err === null || err === undefined) return { message: String(err) };
  if (err instanceof Error) {
    const out: SerializedError = {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
    // better-sqlite3 / Node errno errors attach `.code` (e.g. SQLITE_ERROR).
    const maybeCode = (err as { code?: unknown }).code;
    if (typeof maybeCode === 'string') out.code = maybeCode;
    // better-sqlite3 exposes the extended result code via `.codeName`
    // (e.g. SQLITE_CORRUPT_VTAB distinguishes from generic SQLITE_CORRUPT).
    const maybeCodeName = (err as { codeName?: unknown }).codeName;
    if (typeof maybeCodeName === 'string') out.codeName = maybeCodeName;
    return out;
  }
  if (typeof err === 'object') {
    // Already-reshaped object (e.g. neverthrow Result.error). Copy the
    // diagnostic-relevant fields rather than relying on enumeration alone.
    const e = err as Record<string, unknown>;
    const out: SerializedError = {};
    if (typeof e.name === 'string') out.name = e.name;
    if (typeof e.message === 'string') out.message = e.message;
    if (typeof e.stack === 'string') out.stack = e.stack;
    if (typeof e.code === 'string') out.code = e.code;
    if (typeof e.codeName === 'string') out.codeName = e.codeName;
    // If none of the standard fields survived, fall back to stringifying the
    // whole thing so the operator at least sees what shape arrived.
    if (Object.keys(out).length === 0) return { message: JSON.stringify(err) };
    return out;
  }
  return { message: String(err) };
}
