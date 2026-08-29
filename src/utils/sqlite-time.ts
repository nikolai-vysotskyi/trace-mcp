/**
 * SQLite's `datetime('now')` writes `"2026-08-29 09:23:45"` — UTC, but with a
 * space separator and no zone marker. `new Date()` in V8 reads that shape as
 * LOCAL time, so a value handed straight to the renderer renders offset by the
 * user's UTC offset (TRA-371: "4 hours ago · Aug 29, 9:23 AM" for a project
 * indexed seconds earlier at 13:23 local).
 *
 * Anything crossing the API boundary goes through here first, so the wire
 * contract is one shape everywhere: ISO-8601 UTC, same as the registry's
 * `lastIndexed` (`new Date().toISOString()`).
 */
export function sqliteUtcToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  // Already zoned (registry values, `+00:00` offsets) — parse as-is.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
