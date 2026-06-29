/**
 * Progressive disclosure of decisions (Task 12).
 *
 * A "decision index" tier returns a compact entry — id + title + a ~1-line
 * summary + code anchors — WITHOUT the full `content`. The agent picks the
 * relevant ids from the cheap index, then pulls full `content` on demand via
 * `get_decision`. Pure token-saving: same rows, far fewer tokens per row.
 */
import type { DecisionRow } from './decision-types.js';

/** Max length of the derived one-line summary (chars). */
const SUMMARY_MAX = 160;

export interface DecisionIndexEntry {
  id: number;
  title: string;
  type: string;
  /** ~1-line summary derived from the first sentence of `content`. */
  summary: string;
  symbol_id?: string;
  file_path?: string;
  service_name?: string;
  tags?: string[];
  review_status?: 'pending' | 'approved' | 'rejected';
  valid_from?: string;
  /** Carried through from staleness verification when present (Task 3). */
  verification?: string;
  stale?: boolean;
}

/** Parse the JSON tags column into a string array; empty array on null/garbage. */
function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Derive a short, single-line summary from a decision's content.
 * Takes the first sentence (up to the first ., !, ?, or newline), collapses
 * whitespace, and truncates to SUMMARY_MAX with an ellipsis.
 */
export function summarizeContent(content: string | null | undefined): string {
  if (!content) return '';
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  // First sentence — split on sentence-ending punctuation followed by space/EOL.
  const match = flat.match(/^.*?[.!?](\s|$)/);
  let summary = (match ? match[0] : flat).trim();
  if (summary.length > SUMMARY_MAX) {
    summary = `${summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
  }
  return summary;
}

/**
 * Project a full decision row down to its index entry (no `content`).
 * Optional fields are omitted when null/empty to keep the payload tight.
 * Verification annotations (Task 3) are carried through when present.
 */
export function toDecisionIndexEntry(
  row: DecisionRow & { verification?: string; stale?: boolean; cluster_ids?: number[] },
): DecisionIndexEntry {
  const entry: DecisionIndexEntry = {
    id: row.id,
    title: row.title,
    type: row.type,
    summary: summarizeContent(row.content),
  };
  if (row.symbol_id) entry.symbol_id = row.symbol_id;
  if (row.file_path) entry.file_path = row.file_path;
  if (row.service_name) entry.service_name = row.service_name;
  const tags = parseTags(row.tags);
  if (tags.length > 0) entry.tags = tags;
  if (row.review_status) entry.review_status = row.review_status;
  if (row.valid_from) entry.valid_from = row.valid_from;
  if (row.verification) entry.verification = row.verification;
  if (row.stale) entry.stale = true;
  return entry;
}
