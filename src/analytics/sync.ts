import { AnalyticsStore } from './analytics-store.js';
import { parseSessionFile, listAllSessions } from './log-parser.js';
import { logger } from '../logger.js';

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
  let parsed = 0, skipped = 0, stored = 0, toolCallsCount = 0, errors = 0;

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
export function syncProjectAnalytics(store: AnalyticsStore, projectPath: string, opts: { full?: boolean } = {}): SyncResult {
  const start = Date.now();
  const allSessions = listAllSessions();
  const sessions = allSessions.filter(s => s.projectPath === projectPath || s.projectPath.endsWith(projectPath));
  let parsed = 0, skipped = 0, stored = 0, toolCallsCount = 0, errors = 0;

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
