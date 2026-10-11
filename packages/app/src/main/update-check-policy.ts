/**
 * Update-check retry policy (TRA-2104).
 *
 * Pure helpers with no Electron imports, so they are unit-testable without
 * booting the main process. The wiring lives in `index.ts`.
 *
 * Background: update checks are renderer-driven (a 10-minute poll in
 * `renderer/update-check.ts`), so a tray with no open window performs zero
 * checks — `update.log` goes silent for as long as the window stays closed,
 * and a transient `latest-mac.yml` 404 (the release tag is `latest` minutes
 * before the build jobs finish uploading the feed) is never retried until the
 * user opens the window again. The main-process safety net below rechecks
 * whenever no check has happened recently, whatever the reason.
 */

/**
 * How long since the last check (from any path — renderer IPC or the
 * background net) before the background net runs one itself. Longer than the
 * renderer's 10-minute cadence on purpose: while a window is open the renderer
 * owns polling and this stays idle; it only fires for a tray with no window,
 * or when every recent check threw before recording itself.
 */
export const BACKGROUND_UPDATE_CHECK_AFTER_MS = 30 * 60 * 1000;

/** How often the background net wakes up to ask the question above. */
export const BACKGROUND_UPDATE_CHECK_TICK_MS = 15 * 60 * 1000;

/**
 * True when a background check is due: never checked, or the last check is
 * older than the safety-net interval. `lastCheckAt` 0/undefined both mean
 * "no check on record".
 */
export function shouldBackgroundRecheck(
  lastCheckAt: number | undefined,
  now: number = Date.now(),
  afterMs: number = BACKGROUND_UPDATE_CHECK_AFTER_MS,
): boolean {
  if (!lastCheckAt) return true;
  return now - lastCheckAt >= afterMs;
}

/**
 * Whether an update-check failure is worth retrying rather than treating as a
 * settled state. Transient: the feed 404 while release assets are still
 * uploading, flaky HTTP/2 streams, timeouts, offline, 5xx. Settled: signature
 * verification, malformed feeds, auth — retrying those on a timer just burns
 * log lines and requests.
 *
 * Diagnostic only: the retry cadence does not change either way (the renderer
 * poll plus the background net above), but the flag in `update.log` is what
 * lets the next investigation tell "caught the release mid-publish" apart from
 * "broken in a way retry will never fix".
 */
const TRANSIENT_PATTERNS = [
  /\b404\b/,
  /ERR_HTTP2/i,
  /refused stream/i,
  /timeout/i,
  /\boffline\b/i,
  /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/i,
  /\b5\d\d\b/,
  /socket hang up/i,
  /service unavailable/i,
  // The feed file itself is only transient evidence together with a fetch
  // failure ("Cannot find latest-mac.yml…", "…failed … latest-mac.yml"). A
  // bare mention ("latest-mac.yml has invalid signature") is settled.
  /(cannot find|failed|fetch|download|missing|not found).*latest(-mac)?\.yml/i,
  /latest(-mac)?\.yml.*(cannot|failed|missing|not found|\b404\b)/i,
];

export function isTransientUpdateError(message: string): boolean {
  if (!message) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(message));
}
