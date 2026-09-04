/**
 * Startup-block growth watch (TRA-865 — the fourth leg of TRA-759: measure,
 * suggest, apply, watch).
 *
 * `get_startup_context_audit` (startup-context.ts) is a report nobody opens
 * twice in a row — which is exactly why a block that crept back up after
 * being trimmed goes unnoticed for months. This module takes one cheap
 * sample per session (the latest session's already-measured startup size,
 * not a fresh corpus scan) and compares it against a small local history, so
 * a session-start hook can print a one-line notice instead of the user
 * having to remember to re-run the audit.
 *
 * Deliberately NOT what `analyzeStartupContext` does:
 *  - Scoped to one project by default. The audit's log scan is machine-wide
 *    on purpose (a 30-day median needs volume); this tracks one project's
 *    trend, and mixing in a second project's differently-sized CLAUDE.md
 *    would read as "grew" on nothing but a `cd`.
 *  - No cost, no recommendations, no text compression — just one number.
 *
 * Nothing here is sent anywhere. The history file lives next to the rest of
 * trace-mcp's local state (STARTUP_WATCH_PATH, under TRACE_MCP_HOME) and is
 * read, compared, and rewritten — never uploaded.
 */
import fs from 'node:fs';
import { STARTUP_WATCH_PATH } from '../shared/paths.js';
import { atomicWriteJson } from '../utils/atomic-write.js';
import { listAllSessions } from './log-parser.js';
import { MIN_SESSION_BYTES, scanSessionFile } from './startup-context.js';

/** Recent sessions are almost always fresh; this just bounds the pathological case. */
const MAX_FILES_TO_SCAN = 20;

/** Snapshots kept per project. At a few sessions/day this covers months. */
const MAX_HISTORY_PER_PROJECT = 60;

/**
 * How far back a baseline may be. "Did it grow" compares the latest sample
 * to the oldest snapshot still inside this window, not to the immediately
 * preceding one — a CLAUDE.md that doubles over many small edits across a
 * month should still trip this, even though no single session-to-session
 * delta looks large.
 */
const LOOKBACK_DAYS = 14;

/**
 * Growth below this is noise, not signal: chars/4 token estimation, and
 * session-to-session variance in what SessionStart hooks happen to print
 * (e.g. how many recent decisions there are to list). The issue this module
 * implements names the failure mode explicitly — a notice firing on +200
 * tokens gets muted within a week. 2,000 tokens is roughly what one small
 * MCP server's tool schemas cost, which is the smallest change worth a
 * human's attention.
 */
const GROWTH_ABS_FLOOR_TOKENS = 2000;

/** ...or a smaller absolute jump if it's still a big relative move for a small block. */
const GROWTH_REL_FLOOR = 0.1;

export interface StartupSample {
  /** ISO timestamp of the sampled session (its log file's mtime). */
  takenAt: string;
  startupTokens: number;
  projectPath: string;
}

export interface StartupWatchEntry {
  takenAt: string;
  startupTokens: number;
}

interface StartupWatchState {
  version: 1;
  /** Project root (or 'global' when unscoped) → history, oldest first. */
  perProject: Record<string, StartupWatchEntry[]>;
}

export interface StartupWatchNotice {
  deltaTokens: number;
  previousTokens: number;
  currentTokens: number;
  sinceDays: number;
  /** One number, one action — nothing else. Meant to be printed as-is. */
  message: string;
}

export interface StartupWatchOptions {
  projectRoot?: string;
  /** Injectable for tests; same seam analyzeStartupContext uses. */
  listSessions?: typeof listAllSessions;
  statePath?: string;
}

/**
 * The latest session with a measured startup block, scoped to `projectRoot`
 * when given (falls back to machine-wide otherwise). Scans newest-first and
 * stops at the first hit, so this costs one small file read in the common
 * case — safe to call on every session start.
 */
export async function sampleLatestStartup(
  opts: StartupWatchOptions = {},
): Promise<StartupSample | null> {
  const list = opts.listSessions ?? listAllSessions;
  const files = list(opts.projectRoot)
    .filter((f) => {
      try {
        return fs.statSync(f.filePath).size >= MIN_SESSION_BYTES;
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES_TO_SCAN);

  for (const file of files) {
    let scan: Awaited<ReturnType<typeof scanSessionFile>>;
    try {
      scan = await scanSessionFile(file.filePath, file.projectPath);
    } catch {
      continue;
    }
    if (scan.fresh) {
      return {
        takenAt: new Date(file.mtime).toISOString(),
        startupTokens: scan.fresh.startupTokens,
        projectPath: file.projectPath,
      };
    }
  }
  return null;
}

function loadState(statePath: string): StartupWatchState {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (raw?.version === 1 && raw.perProject && typeof raw.perProject === 'object') {
      return raw as StartupWatchState;
    }
  } catch {
    /* missing or corrupt — start fresh */
  }
  return { version: 1, perProject: {} };
}

function saveState(statePath: string, state: StartupWatchState): void {
  atomicWriteJson(statePath, state);
}

/**
 * Pure comparison — no I/O, so this is the part unit tests exercise directly
 * without touching disk or session logs.
 *
 * Returns null when there is nothing to say: no baseline inside the lookback
 * window (first-ever sample, or a gap wider than the window), or growth
 * under threshold. Never fires on shrinkage.
 */
export function evaluateStartupGrowth(
  history: StartupWatchEntry[],
  sample: StartupSample,
  nowMs: number = Date.parse(sample.takenAt),
): StartupWatchNotice | null {
  const cutoffMs = nowMs - LOOKBACK_DAYS * 86_400_000;
  const baseline = history.find((e) => Date.parse(e.takenAt) >= cutoffMs);
  if (!baseline) return null;

  const delta = sample.startupTokens - baseline.startupTokens;
  const threshold = Math.max(GROWTH_ABS_FLOOR_TOKENS, baseline.startupTokens * GROWTH_REL_FLOOR);
  if (delta < threshold) return null;

  const sinceDays = Math.max(
    1,
    Math.round((Date.parse(sample.takenAt) - Date.parse(baseline.takenAt)) / 86_400_000),
  );
  return {
    deltaTokens: delta,
    previousTokens: baseline.startupTokens,
    currentTokens: sample.startupTokens,
    sinceDays,
    message: `trace-mcp: startup block grew by +${delta.toLocaleString()} tokens. Run get_startup_context_audit for details.`,
  };
}

/**
 * Sample, compare against history, record the sample, return a notice or
 * null. Safe to call once per session start — recording is deduped by
 * `takenAt` so re-invoking against the same underlying session never grows
 * the history file.
 *
 * The notice itself is NOT deduped the same way: as long as the block that
 * grew stays inside the `LOOKBACK_DAYS` window, every session start repeats
 * the same notice. That is deliberate — "shown once" would need its own
 * acknowledged-state to track, and a real regression should keep surfacing
 * until either the user acts on it or it ages out of the window on its own
 * (at which point it stops on its own, with nothing to clean up).
 */
export async function checkStartupWatch(
  opts: StartupWatchOptions = {},
): Promise<StartupWatchNotice | null> {
  const sample = await sampleLatestStartup(opts);
  if (!sample) return null;

  const statePath = opts.statePath ?? STARTUP_WATCH_PATH;
  const key = opts.projectRoot ?? 'global';
  const state = loadState(statePath);
  const history = state.perProject[key] ?? [];

  const notice = evaluateStartupGrowth(history, sample);

  const last = history[history.length - 1];
  if (!last || last.takenAt !== sample.takenAt) {
    history.push({ takenAt: sample.takenAt, startupTokens: sample.startupTokens });
    if (history.length > MAX_HISTORY_PER_PROJECT) {
      history.splice(0, history.length - MAX_HISTORY_PER_PROJECT);
    }
    state.perProject[key] = history;
    saveState(statePath, state);
  }

  return notice;
}
