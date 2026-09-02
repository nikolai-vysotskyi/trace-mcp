import { logger } from '../logger.js';
import type { AnalyticsStore } from './analytics-store.js';
import { listAllSessions, parseSessionFile } from './log-parser.js';

/**
 * Warning to attach when a tool found zero session data both in the
 * discoverable log files AND in its aggregated result — the "unreachable
 * data source" case from TRA-76, distinct from "checked, genuinely nothing
 * to report" (which happens when logs exist but the requested period/session
 * has no matches).
 */
export function buildNoSessionDataWarning(projectPath: string | undefined): string[] {
  const scope = projectPath ? `project path "${projectPath}"` : 'any registered project';
  return [
    `No session log files found for ${scope} under ~/.claude/projects or <project>/.claw/sessions. ` +
      'These analytics tools are scoped to session logs produced on this machine — this is expected ' +
      'when running from a fresh checkout, a remote/cloud sandbox, or CI that never ran a local ' +
      'Claude Code / Claw Code session here, not necessarily "nothing to report."',
  ];
}

/**
 * Attach a `_warnings` entry to `report` only when BOTH the aggregated
 * result is empty AND no session log files were discoverable on disk —
 * i.e. "the data source is unreachable", not "checked, nothing to report
 * for this period". Pure decision function so it's unit-testable without
 * mocking the filesystem; callers do the (cheap) `listAllSessions(...)`
 * lookup themselves. See TRA-76.
 */
export function attachNoSessionDataWarning<T extends { _warnings?: string[] }>(
  report: T,
  aggregationIsEmpty: boolean,
  noFilesOnDisk: boolean,
  projectPath: string | undefined,
): T {
  if (aggregationIsEmpty && noFilesOnDisk) {
    report._warnings = buildNoSessionDataWarning(projectPath);
  }
  return report;
}

export interface SyncResult {
  files_scanned: number;
  files_parsed: number;
  files_skipped: number;
  sessions_stored: number;
  tool_calls_stored: number;
  errors: number;
  duration_ms: number;
  /** mtime (epoch ms) of the newest session log seen on disk, null when none. */
  newest_log_mtime: number | null;
}

/**
 * Ingestion freshness of the analytics DB, reported alongside every number
 * derived from it. A stale reading that announces itself is usable; a stale
 * reading that doesn't is a trap — see TRA-695, where the DB silently served
 * a seven-day-old snapshot as if it were current.
 */
export interface IngestionStatus {
  /** `max(sync_state.parsed_at)` — when the last log file was absorbed. */
  ingested_through: string | null;
  files_tracked: number;
  /** mtime of the newest session log on disk, ISO-8601. */
  newest_session_log_at: string | null;
  /** True when a session log on disk is newer than the ingestion watermark. */
  stale: boolean;
  /** How far the watermark trails the newest log, in hours (null when fresh). */
  behind_hours: number | null;
}

/**
 * Derive ingestion freshness from a just-completed sync plus the store's
 * watermark. Takes the sync result rather than re-listing the filesystem so
 * this costs nothing beyond one SELECT.
 */
export function buildIngestionStatus(
  watermark: { parsed_at: string | null; files_tracked: number },
  newestLogMtime: number | null,
): IngestionStatus {
  const parsedAtMs = watermark.parsed_at ? Date.parse(watermark.parsed_at) : NaN;
  const stale =
    newestLogMtime !== null && (Number.isNaN(parsedAtMs) || newestLogMtime > parsedAtMs);
  return {
    ingested_through: watermark.parsed_at,
    files_tracked: watermark.files_tracked,
    newest_session_log_at: newestLogMtime === null ? null : new Date(newestLogMtime).toISOString(),
    stale,
    behind_hours:
      stale && !Number.isNaN(parsedAtMs)
        ? Math.round((((newestLogMtime as number) - parsedAtMs) / 3_600_000) * 10) / 10
        : null,
  };
}

/**
 * Attach `_ingestion` to a report and, when the DB trails the logs on disk,
 * add a `_warnings` line so the staleness is stated rather than inferable.
 */
export function attachIngestionStatus<T extends { _warnings?: string[] }>(
  report: T & { _ingestion?: IngestionStatus },
  store: { getIngestionWatermark(): { parsed_at: string | null; files_tracked: number } },
  sync: SyncResult,
): T & { _ingestion?: IngestionStatus } {
  const status = buildIngestionStatus(store.getIngestionWatermark(), sync.newest_log_mtime);
  report._ingestion = status;
  if (status.stale) {
    const behind = status.behind_hours === null ? 'unknown' : `${status.behind_hours}h`;
    report._warnings = [
      ...(report._warnings ?? []),
      `Analytics DB is STALE: last ingested ${status.ingested_through ?? 'never'}, ` +
        `newest session log on disk is ${status.newest_session_log_at} (${behind} newer). ` +
        'These numbers do not cover the most recent sessions — run `trace-mcp analytics sync`.',
    ];
  }
  return report;
}

function newestMtime(sessions: { mtime: number }[]): number | null {
  let newest: number | null = null;
  for (const s of sessions) {
    if (newest === null || s.mtime > newest) newest = s.mtime;
  }
  return newest;
}

/** Sync all session logs (Claude Code + Claw Code) into analytics DB */
export function syncAnalytics(store: AnalyticsStore, opts: { full?: boolean } = {}): SyncResult {
  const start = Date.now();
  const sessions = listAllSessions();
  let parsed = 0;
  let skipped = 0;
  let stored = 0;
  let toolCallsCount = 0;
  let errors = 0;

  for (const { filePath, projectPath, mtime } of sessions) {
    if (!opts.full && !store.needsSync(filePath, mtime)) {
      skipped++;
      continue;
    }

    try {
      const result = parseSessionFile(filePath, projectPath);
      if (result) {
        store.storeSession(result);
        toolCallsCount += result.toolCalls.length;
        stored++;
      }
      store.markSynced(filePath, mtime);
      parsed++;
    } catch (e) {
      logger.warn({ error: e, file: filePath }, 'Failed to sync session');
      errors++;
    }
  }

  return {
    files_scanned: sessions.length,
    files_parsed: parsed,
    files_skipped: skipped,
    sessions_stored: stored,
    tool_calls_stored: toolCallsCount,
    errors,
    duration_ms: Date.now() - start,
    newest_log_mtime: newestMtime(sessions),
  };
}

/** Sync only sessions for a specific project path */
export function syncProjectAnalytics(
  store: AnalyticsStore,
  projectPath: string,
  opts: { full?: boolean } = {},
): SyncResult {
  const start = Date.now();
  const allSessions = listAllSessions();
  const sessions = allSessions.filter(
    (s) => s.projectPath === projectPath || s.projectPath.endsWith(projectPath),
  );
  let parsed = 0;
  let skipped = 0;
  let stored = 0;
  let toolCallsCount = 0;
  let errors = 0;

  for (const { filePath, projectPath: pp, mtime } of sessions) {
    if (!opts.full && !store.needsSync(filePath, mtime)) {
      skipped++;
      continue;
    }

    try {
      const result = parseSessionFile(filePath, pp);
      if (result) {
        store.storeSession(result);
        toolCallsCount += result.toolCalls.length;
        stored++;
      }
      store.markSynced(filePath, mtime);
      parsed++;
    } catch (e) {
      logger.warn({ error: e, file: filePath }, 'Failed to sync session');
      errors++;
    }
  }

  return {
    files_scanned: sessions.length,
    files_parsed: parsed,
    files_skipped: skipped,
    sessions_stored: stored,
    tool_calls_stored: toolCallsCount,
    errors,
    duration_ms: Date.now() - start,
    newest_log_mtime: newestMtime(sessions),
  };
}
