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

interface SyncResult {
  files_scanned: number;
  files_parsed: number;
  files_skipped: number;
  sessions_stored: number;
  tool_calls_stored: number;
  errors: number;
  duration_ms: number;
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
  };
}
