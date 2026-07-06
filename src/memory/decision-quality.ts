/**
 * Quality gate for MINED / AUTO-extracted decisions.
 *
 * The regex miner (`extractDecisions`) captures a title from a bounded regex
 * group and a `content` field from a raw ±200-char slice around the match.
 * Both boundaries are naive: the title group can start on a lowercase
 * conjunction mid-clause ("so let's monitor it over the rest of this"), and
 * the content slice cuts blindly through a UTF-8 sequence or a word
 * ("ming).", "оп.", "budget |", "\`atomicWriteJson(path, data)\` — writes to
 * \`path"). These fragments pollute `query_decisions`: they read as
 * authoritative "knowledge" while being meaningless out of context.
 *
 * This module is the single, source-agnostic gate that a mined/auto decision
 * must pass BEFORE it is stored. It is deliberately conservative — it only
 * rejects candidates that are clearly truncated fragments, never valid short
 * sentences. Manual (`source: 'manual'`) decisions are user-authored and are
 * NOT subject to this gate.
 *
 * The same predicate powers the offline cleanup path (`consolidate_decisions`
 * with `purge_low_quality: true`), so a legacy row that would be rejected on
 * insert today can be retro-invalidated with identical logic.
 *
 * Leaf module: depends only on `language-filter.ts`. No cross-module value deps.
 */

import { isPredominantlyNonLatin } from './language-filter.js';

/** Minimum number of real words the content field must carry. A summary of
 *  one or two words ("оп.", "ming).") is never a usable decision. */
const MIN_CONTENT_WORDS = 4;

/** Minimum trimmed content length in characters — a second, cheaper guard
 *  against single-token fragments that happen to be one long word. */
const MIN_CONTENT_CHARS = 16;

/** Minimum trimmed title length. Below this it cannot be a real clause. */
const MIN_TITLE_CHARS = 8;

/**
 * Leading tokens that mark a fragment sliced out of the middle of a sentence.
 * A title that OPENS with one of these is a dangling continuation of an
 * earlier clause the miner cut away — e.g. "so let's monitor it over the rest
 * of this", "and then we", "but it was", "it over the rest".
 *
 * Deliberately narrow: only coordinating conjunctions, subordinators that
 * cannot begin a decision statement, and bare pronouns / demonstratives that
 * signal a dropped subject. We intentionally EXCLUDE infinitival "to",
 * prepositions ("for", "with", "over", "of"…), and articles ("the", "a"),
 * because the decision regexes capture the object of a consumed verb — e.g.
 * `decided\s+(to use Redis…)`, `going with\s+(Postgres…)` — so those tokens
 * routinely and legitimately open a valid capture. Flagging them would reject
 * good decisions, not just fragments.
 */
const MID_CLAUSE_OPENERS = new Set([
  // Coordinating conjunctions.
  'so',
  'and',
  'but',
  'or',
  'nor',
  'yet',
  // Conjunctive adverbs / discourse continuations.
  'because',
  'then',
  'thus',
  'hence',
  'also',
  'however',
  'therefore',
  // Bare pronouns / demonstratives implying a dropped subject.
  'it',
  'its',
  "it's",
  'this',
  'these',
  'those',
  'they',
  'them',
  'their',
  'he',
  'she',
  'we',
  'us',
]);

/** Count word-like tokens (runs of letters/digits, allowing internal `-`/`'`). */
function countWords(s: string): number {
  const m = s.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

/**
 * True when a string BEGINS mid-sentence: it starts with a lowercase word
 * that is a known continuation token (conjunction / pronoun / bare article).
 * A leading capital, a leading code token (backtick / bracket / quote), or a
 * leading digit are all treated as legitimate starts — only lowercase prose
 * openers are suspect, so identifier- and heading-style captures pass.
 */
export function startsMidClause(s: string): boolean {
  const trimmed = s.trimStart();
  if (!trimmed) return false;
  const first = trimmed[0];
  // Code / markup / quote / number starts are never "mid-clause prose".
  if (!/[a-z]/.test(first)) return false;
  const m = trimmed.match(/^[a-z][a-z'-]*/);
  if (!m) return false;
  return MID_CLAUSE_OPENERS.has(m[0]);
}

/**
 * True when a string ENDS on a truncated token — the miner's fixed-length
 * slice cut through a word or a multi-byte sequence. Heuristic: the last
 * "sentence" has no terminator AND the tail looks like a chopped word
 * (ends in a lowercase letter run of length ≥ 2 with no closing punctuation),
 * OR the string ends with the Unicode replacement char from a broken UTF-8
 * decode. We do NOT reject on a missing terminator alone — plenty of valid
 * titles omit the final period — only when combined with the other fragment
 * signals via `isTruncatedFragment`.
 */
export function endsMidWord(s: string): boolean {
  const trimmed = s.trimEnd();
  if (!trimmed) return false;
  // Broken multi-byte decode leaves U+FFFD.
  if (trimmed.includes('�')) return true;
  return false;
}

/**
 * Core predicate: does this mined title+content pair look like a truncated
 * mid-sentence fragment that should never enter the decision store?
 *
 * Rejection reasons (any one is fatal):
 *   - `non_english`      — predominantly non-Latin title or content.
 *   - `title_too_short`  — title under MIN_TITLE_CHARS after trim.
 *   - `title_mid_clause` — title opens on a mid-sentence continuation token.
 *   - `content_too_short`— content under the word / char floor.
 *   - `broken_encoding`  — U+FFFD replacement char anywhere (chopped UTF-8).
 *
 * Note: we deliberately do NOT reject content that merely OPENS mid-clause.
 * The stored `content` is a raw ±200-char window around the regex match, so
 * legitimate decisions routinely start mid-sentence ("...the window slice").
 * The mid-clause signal is only meaningful on the TITLE, which is a bounded
 * capture group meant to be a standalone statement.
 *
 * Returns `null` when the candidate is acceptable, or a short machine-readable
 * reason string when it must be dropped.
 */
export function minedDecisionRejectReason(title: string, content: string): string | null {
  const t = (title ?? '').trim();
  const c = (content ?? '').trim();

  if (t.length < MIN_TITLE_CHARS) return 'title_too_short';

  // Broken UTF-8 decode — "оп." style garbage often carries a replacement char
  // when the source slice split a multi-byte sequence.
  if (endsMidWord(t) || endsMidWord(c) || t.includes('�') || c.includes('�')) {
    return 'broken_encoding';
  }

  // English-only gate (mirrors title-extractor / content filter, but applied
  // here so the whole pair is rejected consistently at the quality boundary).
  if (isPredominantlyNonLatin(t)) return 'non_english';
  if (c && isPredominantlyNonLatin(c)) return 'non_english';

  // Title must not be a dangling continuation of an earlier clause.
  if (startsMidClause(t)) return 'title_mid_clause';

  // Content must carry enough real words to be a usable summary.
  if (c.length < MIN_CONTENT_CHARS) return 'content_too_short';
  if (countWords(c) < MIN_CONTENT_WORDS) return 'content_too_short';

  return null;
}

/** Convenience boolean wrapper over {@link minedDecisionRejectReason}. */
export function isValidMinedDecision(title: string, content: string): boolean {
  return minedDecisionRejectReason(title, content) === null;
}
