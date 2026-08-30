/**
 * Which model the local client mostly drove in the last 24h, for the daily
 * ping's `model` dimension.
 *
 * Reads the analytics DB the session tools already maintain — read-only, and
 * only if it exists. Telemetry must never be the reason that file gets
 * created, so `fileMustExist` is set rather than going through
 * {@link AnalyticsStore}, whose constructor creates and migrates the schema.
 *
 * A model name (`claude-opus-4-6`) is a fact about the tool in use, not about
 * the person using it — nothing else is read from the DB.
 */
import path from 'node:path';
import Database from 'better-sqlite3';
import { TRACE_MCP_HOME } from '../global.js';
import { logger } from '../logger.js';

const ANALYTICS_DB_PATH = path.join(TRACE_MCP_HOME, 'analytics.db');

export function topModelLastDay(dbPath: string = ANALYTICS_DB_PATH): string | undefined {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const row = db
      .prepare(
        `SELECT model FROM sessions
          WHERE model IS NOT NULL AND model != '' AND started_at >= ?
          GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1`,
      )
      .get(since) as { model?: string } | undefined;
    return row?.model || undefined;
  } catch (err) {
    logger.debug({ err }, 'telemetry.top_model_unavailable');
    return undefined;
  } finally {
    db?.close();
  }
}
