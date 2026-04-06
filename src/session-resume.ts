/**
 * Session resume — persists session summaries and provides cross-session context carryover.
 *
 * Stores a rolling log of recent sessions (tool usage, files touched, tasks performed)
 * so that `get_session_resume` can return a compact orientation when starting a new session.
 */

import fs from 'node:fs';
import path from 'node:path';
import { TRACE_MCP_HOME, ensureGlobalDirs, projectHash } from './global.js';
import { logger } from './logger.js';

const SESSIONS_DIR = path.join(TRACE_MCP_HOME, 'sessions');

/** Max number of session summaries to keep per project */
const MAX_SESSIONS = 20;

interface SessionSummary {
  session_id: string;
  project_root: string;
  started_at: string;
  ended_at: string;
  /** Total tool calls made */
  total_calls: number;
  /** Files that were read/explored (via get_symbol, get_outline) */
  files_touched: string[];
  /** Top tools used: tool → count */
  top_tools: Record<string, number>;
  /** Zero-result searches (patterns that don't exist) */
  dead_ends: string[];
  /** Dedup tokens saved */
  dedup_saved_tokens: number;
  /** Files frequently requested as follow-ups after get_task_context */
  prefetch_boosts?: Array<{ file: string; frequency: number }>;
}

interface SessionResumeResult {
  project: string;
  sessions_available: number;
  recent_sessions: Array<{
    session_id: string;
    when: string;
    duration_min: number;
    calls: number;
    files_touched: string[];
    top_tools: Record<string, number>;
    dead_ends: string[];
  }>;
  /** Files most frequently explored across recent sessions */
  hot_files: Array<{ file: string; sessions: number }>;
  /** Patterns confirmed to not exist (zero-result across multiple sessions) */
  persistent_dead_ends: string[];
  /** Files that are frequently requested as follow-ups after get_task_context (cross-session) */
  prefetch_candidates: Array<{ file: string; total_frequency: number }>;
}

function getSessionsPath(projectRoot: string): string {
  return path.join(SESSIONS_DIR, `${projectHash(projectRoot)}.json`);
}

function loadSessions(projectRoot: string): SessionSummary[] {
  try {
    const filePath = getSessionsPath(projectRoot);
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSessions(projectRoot: string, sessions: SessionSummary[]): void {
  try {
    ensureGlobalDirs();
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const filePath = getSessionsPath(projectRoot);
    // Keep only the most recent sessions
    const trimmed = sessions.slice(-MAX_SESSIONS);
    fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    logger.warn({ error: e }, 'Failed to save session summary');
  }
}

/**
 * Persist current session summary to disk. Call on session end (SIGINT/SIGTERM/exit).
 */
export function flushSessionSummary(opts: {
  projectRoot: string;
  startedAt: string;
  totalCalls: number;
  filesTouched: string[];
  topTools: Record<string, number>;
  deadEnds: string[];
  dedupSavedTokens: number;
  prefetchBoosts?: Array<{ file: string; frequency: number }>;
}): void {
  if (opts.totalCalls === 0) return; // Don't save empty sessions

  const summary: SessionSummary = {
    session_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    project_root: opts.projectRoot,
    started_at: opts.startedAt,
    ended_at: new Date().toISOString(),
    total_calls: opts.totalCalls,
    files_touched: opts.filesTouched.slice(0, 50), // Cap to avoid bloat
    top_tools: opts.topTools,
    dead_ends: opts.deadEnds.slice(0, 20),
    dedup_saved_tokens: opts.dedupSavedTokens,
    prefetch_boosts: opts.prefetchBoosts?.slice(0, 10),
  };

  const existing = loadSessions(opts.projectRoot);
  existing.push(summary);
  saveSessions(opts.projectRoot, existing);

  logger.debug({ calls: opts.totalCalls, files: opts.filesTouched.length }, 'Session summary saved');
}

/**
 * Build a compact session resume for the current project.
 * Returns a summary of recent sessions to orient the agent.
 */
export function getSessionResume(projectRoot: string, maxSessions = 5): SessionResumeResult {
  const allSessions = loadSessions(projectRoot);

  if (allSessions.length === 0) {
    return {
      project: path.basename(projectRoot),
      sessions_available: 0,
      recent_sessions: [],
      hot_files: [],
      persistent_dead_ends: [],
      prefetch_candidates: [],
    };
  }

  const recent = allSessions.slice(-maxSessions);

  // Compute hot files (files touched in multiple sessions)
  const fileCounts = new Map<string, number>();
  for (const session of allSessions.slice(-10)) {
    for (const file of session.files_touched) {
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }
  }
  const hotFiles = [...fileCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, sessions]) => ({ file, sessions }));

  // Find persistent dead ends (zero-result patterns in 2+ sessions)
  const deadEndCounts = new Map<string, number>();
  for (const session of allSessions.slice(-10)) {
    for (const de of session.dead_ends) {
      deadEndCounts.set(de, (deadEndCounts.get(de) ?? 0) + 1);
    }
  }
  const persistentDeadEnds = [...deadEndCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([pattern]) => pattern);

  // Aggregate prefetch boosts across sessions
  const prefetchCounts = new Map<string, number>();
  for (const session of allSessions.slice(-10)) {
    for (const boost of session.prefetch_boosts ?? []) {
      prefetchCounts.set(boost.file, (prefetchCounts.get(boost.file) ?? 0) + boost.frequency);
    }
  }
  const prefetchCandidates = [...prefetchCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, total_frequency]) => ({ file, total_frequency }));

  return {
    project: path.basename(projectRoot),
    sessions_available: allSessions.length,
    recent_sessions: recent.map(s => {
      const start = new Date(s.started_at).getTime();
      const end = new Date(s.ended_at).getTime();
      return {
        session_id: s.session_id,
        when: s.started_at,
        duration_min: Math.round((end - start) / 60000),
        calls: s.total_calls,
        files_touched: s.files_touched.slice(0, 15),
        top_tools: s.top_tools,
        dead_ends: s.dead_ends,
      };
    }),
    hot_files: hotFiles,
    persistent_dead_ends: persistentDeadEnds,
    prefetch_candidates: prefetchCandidates,
  };
}
