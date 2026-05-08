/**
 * Version-drift stamp.
 *
 * `trace-mcp init` writes the version it just configured into a tiny
 * sidecar file under TRACE_MCP_HOME. On startup the server reads it back
 * and compares against the currently-installed version. If they diverge,
 * we emit a one-line warning so the operator knows their hook scripts /
 * settings.json templates are stale and need a re-init.
 *
 * Mirrors jcodemunch v1.81.0 — closes the silent-drift bug where users
 * upgrade the binary but forget to re-run init, and old hook contents
 * keep referencing removed env vars or moved paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import { TRACE_MCP_HOME } from '../global.js';

/** Filename relative to TRACE_MCP_HOME. Matches jcodemunch convention. */
export const STAMP_BASENAME = 'last_init_version.txt';

/** Absolute path of the stamp file. Exported for tests + diagnostics. */
export const STAMP_PATH = path.join(TRACE_MCP_HOME, STAMP_BASENAME);

/**
 * Write the version stamp atomically. Returns true on success, false on
 * any I/O failure — init must never bubble a stamp-write error up to the
 * user, since the stamp is purely advisory.
 */
export function writeStampedVersion(version: string, stampPath: string = STAMP_PATH): boolean {
  if (!version || typeof version !== 'string') return false;
  try {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    // Trailing newline so editors don't mangle the file on save.
    fs.writeFileSync(stampPath, `${version.trim()}\n`, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the stamp. Returns null when the file is missing, unreadable, or
 * empty so the caller can fall through to "no drift to report".
 */
export function readStampedVersion(stampPath: string = STAMP_PATH): string | null {
  try {
    const raw = fs.readFileSync(stampPath, 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export interface VersionDriftReport {
  /** True when stamp exists and disagrees with `installed`. */
  drift: boolean;
  /** Currently-installed version (caller-provided). */
  installed: string;
  /** Stamped version, or null when no stamp file is present. */
  stamped: string | null;
}

/**
 * Compute drift report. Pure function so tests don't need filesystem mocks.
 */
export function computeVersionDrift(installed: string, stamped: string | null): VersionDriftReport {
  if (!stamped) return { drift: false, installed, stamped: null };
  return { drift: stamped !== installed, installed, stamped };
}

/**
 * One-line stderr-friendly diagnostic. Mentions the concrete remedy
 * (`trace-mcp init`) so users don't have to guess what to do.
 */
export function versionDriftMessage(report: VersionDriftReport): string {
  if (!report.drift) return '';
  return (
    `[trace-mcp] installed version ${report.installed} differs from last-init stamp ${report.stamped}. ` +
    'Hook scripts and settings.json templates may be stale — run `trace-mcp init` to refresh.\n'
  );
}

/**
 * Convenience: read the stamp, compute drift, return the report. Caller
 * decides whether/where to log the message (server stderr, init CLI, etc.).
 */
export function checkVersionDrift(
  installed: string,
  stampPath: string = STAMP_PATH,
): VersionDriftReport {
  return computeVersionDrift(installed, readStampedVersion(stampPath));
}
