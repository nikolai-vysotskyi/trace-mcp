/**
 * Title extractor — turns a raw regex-capture string into a clean, bounded,
 * sentence-aware decision title. Replaces the legacy `truncateTitle()` that
 * cut on character length and produced mid-sentence fragments like
 * "против билд-сложности" or "Snapshot graph diff over time** (урок v2.3.2".
 *
 * Rules:
 *   1. Collapse whitespace, strip leading list/markdown markers.
 *   2. If the string contains a sentence terminator within MAX_LEN, cut at
 *      the FIRST terminator. Otherwise cut at the last whitespace ≤ MAX_LEN.
 *   3. Reject the candidate when bracket/quote balance can't be repaired:
 *      `(`, `[`, `{`, backtick, `"` are all counted; trailing unmatched
 *      opens get trimmed back to the last balanced position.
 *   4. Reject when the title is predominantly non-English (see
 *      `language-filter.ts`).
 *
 * Returns `null` when the candidate is rejected; callers should drop the
 * decision entirely (don't fall back to a worse title).
 */

import { isPredominantlyNonLatin } from './language-filter.js';

export const TITLE_MAX_LEN = 150;
const TITLE_SOFT_LEN = 80;

const SENTENCE_TERMINATORS = /[.!?。！？]/;

/**
 * Sentence-boundary trim. Cuts at the FIRST `.`/`!`/`?` (including
 * fullwidth CJK variants) within `maxLen`, regardless of total length —
 * titles should be one sentence. Multi-sentence captures like
 * `"Decision: use X. We chose this because Y"` collapse to the leading
 * clause. Falls back to the last whitespace before `maxLen` when no
 * terminator exists. Returns the bare string when no boundary can be
 * found.
 *
 * The 8-char minimum on terminator position protects against early-stop
 * on initials and abbreviations like "U.S." or "v2." at the very start.
 */
function trimToSentence(s: string, maxLen: number): string {
  const window = s.slice(0, maxLen);
  // Prefer the EARLIEST sentence terminator — keeps the title to one
  // sentence even when the captured fragment is short.
  const m = window.match(SENTENCE_TERMINATORS);
  if (m && m.index !== undefined && m.index >= 8) {
    return window.slice(0, m.index);
  }
  if (s.length <= maxLen) return s;
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace >= 20) return window.slice(0, lastSpace);
  return window;
}

/**
 * Bracket/quote balance. Counts opens vs closes for `()`, `[]`, `{}`,
 * backtick, and straight `"`. Returns the substring trimmed back to the
 * last position where every counter is non-negative AND all opened groups
 * are closed. If even the empty prefix is unbalanced (impossible here but
 * defensive), returns the input unchanged.
 */
function trimToBalanced(s: string): string {
  // Fast path — most candidates are balanced. Quick rejection scan.
  let par = 0;
  let sq = 0;
  let cur = 0;
  let bt = 0;
  let dq = 0;
  for (const ch of s) {
    if (ch === '(') par++;
    else if (ch === ')') par = Math.max(0, par - 1);
    else if (ch === '[') sq++;
    else if (ch === ']') sq = Math.max(0, sq - 1);
    else if (ch === '{') cur++;
    else if (ch === '}') cur = Math.max(0, cur - 1);
    else if (ch === '`') bt = bt === 0 ? 1 : 0;
    else if (ch === '"') dq = dq === 0 ? 1 : 0;
  }
  if (par === 0 && sq === 0 && cur === 0 && bt === 0 && dq === 0) return s;

  // Slow path — walk forward, remember last position where everything is
  // balanced, and cut there.
  par = sq = cur = bt = dq = 0;
  let lastBalanced = 0;
  let i = 0;
  for (const ch of s) {
    if (ch === '(') par++;
    else if (ch === ')') par = Math.max(0, par - 1);
    else if (ch === '[') sq++;
    else if (ch === ']') sq = Math.max(0, sq - 1);
    else if (ch === '{') cur++;
    else if (ch === '}') cur = Math.max(0, cur - 1);
    else if (ch === '`') bt = bt === 0 ? 1 : 0;
    else if (ch === '"') dq = dq === 0 ? 1 : 0;
    i += ch.length;
    if (par === 0 && sq === 0 && cur === 0 && bt === 0 && dq === 0) {
      lastBalanced = i;
    }
  }
  if (lastBalanced === 0) return '';
  return s.slice(0, lastBalanced);
}

/**
 * Strip leading markdown / list noise that the regex captures sometimes
 * include: `## `, `- `, `* `, `1. `, `> `. These come from headings or
 * numbered lists in conversation text and don't belong in a title.
 */
function stripLeadingNoise(s: string): string {
  return s.replace(/^(?:[#>*\-]+\s+|\d+\.\s+)+/, '');
}

/** Strip trailing punctuation noise — dangling commas, semicolons, dashes. */
function stripTrailingNoise(s: string): string {
  return s.replace(/[\s,;:—–\-]+$/, '');
}

/**
 * Sanitize a raw title candidate. Returns the cleaned title, or `null` if
 * the candidate must be rejected (non-English, empty, or irreparably
 * unbalanced).
 */
export function sanitizeTitle(raw: string): string | null {
  if (!raw) return null;
  let s = raw.replace(/\s+/g, ' ').trim();
  s = stripLeadingNoise(s);
  if (!s) return null;

  // Language filter runs FIRST against the full input so a single English
  // clause at the start of a non-English string can't sneak through after
  // the sentence-boundary trim. Example: `"you do." Без советов` would
  // otherwise trim to "you do." and pass the gate.
  if (isPredominantlyNonLatin(s)) return null;

  // Sentence-aware trim.
  s = trimToSentence(s, TITLE_MAX_LEN);

  // Repair brackets/quotes — drops the tail when unbalanced.
  s = trimToBalanced(s);
  s = stripTrailingNoise(s).trim();
  if (!s) return null;

  // Language filter: drop predominantly non-English titles.
  if (isPredominantlyNonLatin(s)) return null;

  // Final length clamp — `trimToBalanced` may have produced something
  // longer than the soft target (we kept the whole balanced prefix).
  if (s.length > TITLE_MAX_LEN) {
    const re = trimToSentence(s, TITLE_MAX_LEN);
    s = stripTrailingNoise(re).trim();
  }
  if (s.length < 3) return null;

  // Compact ellipsis suffix when we clipped below the soft length and the
  // string is on the longer side — informational, never load-bearing.
  if (s.length > TITLE_SOFT_LEN && !/[.!?]$/.test(s)) {
    s = `${s}...`;
  }

  return s;
}

/**
 * Same English-only gate, applied to the longer `content` field. Returns
 * `true` when the content is predominantly non-English and should be
 * dropped along with the title.
 */
export function isContentNonEnglish(content: string): boolean {
  return isPredominantlyNonLatin(content);
}
