/**
 * Session directory sweeper (TRA-1218).
 *
 * Reclaims disk space and inodes in `~/.trace-mcp/sessions/` (`SESSIONS_DIR`).
 * Without this, every ephemeral task or project run leaks:
 *  - `<hash>-snapshot.json` (transient context for PreCompact hook)
 *  - `<hash>-end.log` (session-end exit marker)
 *  - `<hash>.json` (rolling session summaries for `get_session_resume`)
 * indefinitely, eventually accumulating thousands of orphaned files.
 *
 * Retention policy:
 *  1. Snapshots: max age 24 hours (active session only; dead once session exits).
 *  2. End logs: max age 7 days (or immediately if project root is confirmed gone).
 *  3. Resumes:
 *     - If project root is ephemeral (e.g. Multica workdir / Claude scratchpad)
 *       and the directory no longer exists on disk: delete immediately.
 *     - If project root is non-ephemeral but missing: delete after 7-day grace period.
 *     - If all recorded sessions in the file are older than 30 days: delete.
 *  4. Atomic-write tmp files (`.tmp.*`): delete if older than 1 hour.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isEphemeralProjectRoot, SESSIONS_DIR } from '../global.js';
import { logger } from '../logger.js';

export interface SessionSweepOptions {
  /** Directory where session files live (default: SESSIONS_DIR) */
  sessionsDir?: string;
  /** Max age in hours for *-snapshot.json files (default: 24) */
  snapshotMaxAgeHours?: number;
  /** Max age in hours for *-end.log files (default: 168 = 7 days) */
  endLogMaxAgeHours?: number;
  /** Max age in hours for session resume summary *.json files (default: 720 = 30 days) */
  resumeMaxAgeHours?: number;
  /** Grace period in days for non-ephemeral project roots that are missing (default: 7) */
  missingRootGraceDays?: number;
  /** If true, return candidates that would be deleted without actually unlinking them */
  dryRun?: boolean;
}

export interface SessionSweepSummary {
  deleted: string[];
  freedBytes: number;
}

interface StoredSessionSummary {
  session_id?: string;
  project_root?: string;
  started_at?: string;
  ended_at?: string;
}

/**
 * Sweep stale and orphaned files in the sessions directory.
 */
export function sweepSessionFiles(options?: SessionSweepOptions): SessionSweepSummary {
  const dir = options?.sessionsDir ?? SESSIONS_DIR;
  if (!fs.existsSync(dir)) {
    return { deleted: [], freedBytes: 0 };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    logger.warn({ err, dir }, 'Failed to read sessions directory for sweep');
    return { deleted: [], freedBytes: 0 };
  }

  const now = Date.now();
  const snapshotMaxAgeMs = (options?.snapshotMaxAgeHours ?? 24) * 3600 * 1000;
  const endLogMaxAgeMs = (options?.endLogMaxAgeHours ?? 168) * 3600 * 1000;
  const resumeMaxAgeMs = (options?.resumeMaxAgeHours ?? 720) * 3600 * 1000;
  const missingRootGraceMs = (options?.missingRootGraceDays ?? 7) * 24 * 3600 * 1000;
  const dryRun = !!options?.dryRun;

  const deadHashes = new Set<string>();
  const candidatesToDelete = new Set<string>();

  // Pass 1: analyze resume files (`<hash>.json`) to discover dead project roots
  for (const filename of entries) {
    if (
      !filename.endsWith('.json') ||
      filename.endsWith('-snapshot.json') ||
      filename.includes('.tmp.')
    ) {
      continue;
    }
    const hash = filename.slice(0, -'.json'.length);
    const fullPath = path.join(dir, filename);

    let st: fs.Stats;
    try {
      st = fs.statSync(fullPath);
    } catch {
      continue;
    }

    let shouldDelete = false;
    try {
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data) || data.length === 0) {
        shouldDelete = true;
      } else {
        const summaries = data as StoredSessionSummary[];
        const root = summaries[0]?.project_root;

        let latestSessionTime = 0;
        for (const s of summaries) {
          const t = Date.parse(s.ended_at || s.started_at || '') || 0;
          if (t > latestSessionTime) latestSessionTime = t;
        }

        const fileAgeMs = now - st.mtimeMs;
        const sessionAgeMs = latestSessionTime > 0 ? now - latestSessionTime : fileAgeMs;

        if (!root || typeof root !== 'string') {
          shouldDelete = true;
        } else if (!fs.existsSync(root)) {
          if (isEphemeralProjectRoot(root)) {
            // Ephemeral roots never come back once deleted.
            shouldDelete = true;
            deadHashes.add(hash);
          } else if (fileAgeMs > missingRootGraceMs && sessionAgeMs > missingRootGraceMs) {
            // Missing non-ephemeral root past grace period.
            shouldDelete = true;
            deadHashes.add(hash);
          }
        } else if (fileAgeMs > resumeMaxAgeMs && sessionAgeMs > resumeMaxAgeMs) {
          // Inactive past retention limit.
          shouldDelete = true;
        }
      }
    } catch {
      // Unparseable / corrupted JSON.
      shouldDelete = true;
    }

    if (shouldDelete) {
      candidatesToDelete.add(filename);
    }
  }

  // Pass 2: snapshots, end logs, and orphan tmp files
  for (const filename of entries) {
    if (candidatesToDelete.has(filename)) continue;

    const fullPath = path.join(dir, filename);
    let st: fs.Stats;
    try {
      st = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (filename.endsWith('-snapshot.json')) {
      const hash = filename.slice(0, -'-snapshot.json'.length);
      if (deadHashes.has(hash) || now - st.mtimeMs > snapshotMaxAgeMs) {
        candidatesToDelete.add(filename);
      }
    } else if (filename.endsWith('-end.log')) {
      const hash = filename.slice(0, -'-end.log'.length);
      if (deadHashes.has(hash) || now - st.mtimeMs > endLogMaxAgeMs) {
        candidatesToDelete.add(filename);
      }
    } else if (filename.includes('.tmp.')) {
      if (now - st.mtimeMs > 3600 * 1000) {
        candidatesToDelete.add(filename);
      }
    }
  }

  const deleted: string[] = [];
  let freedBytes = 0;

  for (const filename of candidatesToDelete) {
    const fullPath = path.join(dir, filename);
    try {
      const st = fs.statSync(fullPath);
      freedBytes += st.size;
      if (!dryRun) {
        fs.unlinkSync(fullPath);
      }
      deleted.push(filename);
    } catch (err) {
      logger.debug({ err, filename }, 'Failed to unlink session file during sweep');
    }
  }

  return { deleted, freedBytes };
}
