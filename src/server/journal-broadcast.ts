/**
 * Journal broadcast helper.
 *
 * Converts SessionJournal entries into the `journal_entry` SSE event shape
 * expected by the Activity tab, and provides a snapshot builder for the
 * GET /api/projects/journal endpoint.
 */

import type { SessionJournal } from '../session/journal.js';

// ── Canonical shape of a journal_entry SSE event ──────────────────────────
export interface JournalEntryEvent {
  type: 'journal_entry';
  /** Absolute project root path */
  project: string;
  /** Unix timestamp (ms) of the tool call */
  ts: number;
  /** MCP tool name (e.g. "search", "get_symbol") */
  tool: string;
  /** Human-readable params summary produced by SessionJournal */
  params_summary: string;
  /** Number of results returned */
  result_count: number;
  /** Estimated token size of the full response */
  result_tokens?: number;
  /** Wall-clock latency of the tool call in milliseconds */
  latency_ms?: number;
  /** Whether the tool call returned an error response */
  is_error: boolean;
  /** MCP session ID that made the call */
  session_id: string;
}

/**
 * Shape passed to the `onJournalEntry` callback in installToolGate.
 * This is the raw data before the `type` discriminant is added.
 */
export interface JournalEntryCallbackData {
  project: string;
  ts: number;
  tool: string;
  params_summary: string;
  result_count: number;
  result_tokens?: number;
  latency_ms?: number;
  is_error: boolean;
  session_id: string;
}

/**
 * Wrap raw callback data into the canonical SSE event shape.
 * Call this inside the `onJournalEntry` handler wired in cli.ts:
 *
 *   onJournalEntry: (data) => broadcastEvent(buildJournalEvent(data))
 */
export function buildJournalEvent(data: JournalEntryCallbackData): JournalEntryEvent {
  return { type: 'journal_entry', ...data };
}

/**
 * Build a snapshot of recent journal entries for the REST endpoint
 * GET /api/projects/journal?project=<root>&limit=200.
 *
 * Reads from `journal.getEntries()` and shapes each entry into
 * JournalEntryEvent (minus the `type` field — callers can add it or
 * return the array as-is; the Activity tab accepts both).
 *
 * @param journal   The SessionJournal instance for the project.
 * @param projectRoot  Absolute path of the project root.
 * @param sessionId    Session ID to attach to each entry (typically the
 *                     HTTP session that owns this journal).
 * @param limit        Maximum number of entries to return (newest first).
 */
export function buildJournalSnapshot(
  journal: SessionJournal,
  projectRoot: string,
  sessionId: string,
  limit: number,
): JournalEntryEvent[] {
  const entries = journal.getEntries();
  // Newest first, capped to limit
  return entries
    .slice(-limit)
    .reverse()
    .map((entry) => ({
      type: 'journal_entry' as const,
      project: projectRoot,
      ts: entry.timestamp,
      tool: entry.tool,
      params_summary: entry.params_summary,
      result_count: entry.result_count,
      result_tokens: entry.result_tokens,
      latency_ms: undefined, // not stored on JournalEntry; available via SSE path only
      is_error: false, // journal stores successful calls; errors are streamed live
      session_id: sessionId,
    }));
}
