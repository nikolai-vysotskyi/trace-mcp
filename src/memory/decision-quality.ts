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

/**
 * Strip inline code spans (backtick-delimited runs) from a string. Mined
 * decision titles routinely embed identifiers — `atomicWriteJson(path, data)` —
 * whose ASCII bytes inflate the "Latin share" used by the non-English ratio
 * heuristic. A truncated Cyrillic tail glued onto a big code span therefore
 * slips past a purely ratio-based `isPredominantlyNonLatin` check.
 *
 * We remove ALL backtick spans first — balanced `code`, and a trailing
 * *unbalanced* ``` `path``` (a cut span) up to the end of the string — so the
 * language check runs only on prose. This is used exclusively for the
 * non-English gate; the raw text is still what gets stored / repaired.
 */
function stripCodeSpans(s: string): string {
  // Balanced spans: `...`
  let out = s.replace(/`[^`]*`/g, ' ');
  // A remaining single backtick marks an unbalanced (cut) span — drop from the
  // backtick to end of string so its ASCII contents can't mask a foreign tail
  // that sits BEFORE it, and so its own contents don't count as prose.
  const tick = out.indexOf('`');
  if (tick !== -1) out = out.slice(0, tick);
  return out;
}

/**
 * True when a string carries any Cyrillic / Greek / CJK / other non-Latin
 * *letter* after code spans are stripped. Unlike the ratio-based
 * {@link isPredominantlyNonLatin}, this is a hard tripwire: the mined-decision
 * contract (issue #231) is that stored decisions are English, so a Russian
 * tail on a mostly-code title ("`atomicWriteJson(path, data)` — пишет в `path")
 * must be rejected regardless of how much surrounding code dilutes the ratio.
 */
function hasNonLatinLetter(s: string): boolean {
  const prose = stripCodeSpans(s);
  for (const ch of prose) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (
      // Cyrillic + Cyrillic Supplement
      (cp >= 0x0400 && cp <= 0x04ff) ||
      (cp >= 0x0500 && cp <= 0x052f) ||
      // Greek + Greek Extended
      (cp >= 0x0370 && cp <= 0x03ff) ||
      (cp >= 0x1f00 && cp <= 0x1fff) ||
      // Hebrew + Arabic (incl. supplement)
      (cp >= 0x0590 && cp <= 0x05ff) ||
      (cp >= 0x0600 && cp <= 0x06ff) ||
      (cp >= 0x0750 && cp <= 0x077f) ||
      // CJK Unified Ideographs
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      // Hiragana + Katakana
      (cp >= 0x3040 && cp <= 0x30ff) ||
      // Hangul
      (cp >= 0xac00 && cp <= 0xd7af) ||
      // Devanagari / Thai / Bengali
      (cp >= 0x0900 && cp <= 0x097f) ||
      (cp >= 0x0e00 && cp <= 0x0e7f) ||
      (cp >= 0x0980 && cp <= 0x09ff)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when a string carries a structural marker that is left UNBALANCED —
 * evidence the miner's fixed-length slice cut through a code span, a
 * parenthetical, or a bold run. A cut leaves an odd number of backticks, an
 * unmatched `(`/`)`, or an odd number of `**` bold delimiters.
 *
 *   "`applyCodemod` — sync regex over many files. Make it"    → balanced (ok on this axis)
 *   "`atomicWriteJson(path, data)` — пишет в `path"           → odd backticks
 *   "15. **Snapshot graph diff over time** (урок v2.3.2"      → unmatched "("
 *   "Ship it (see the plan"                                   → unmatched "("
 *
 * We count `**` as bold markers first (removing them) so the leftover single
 * `*` characters — bullets, globs, math — never trip the check.
 */
function hasUnbalancedMarkers(s: string): boolean {
  // Backticks: any odd count is an open code span.
  const backticks = (s.match(/`/g) ?? []).length;
  if (backticks % 2 !== 0) return true;

  // Bold `**` runs: odd count means a bold span was cut.
  const bold = (s.match(/\*\*/g) ?? []).length;
  if (bold % 2 !== 0) return true;

  // Parentheses / brackets: track nesting; unmatched open or close is a cut.
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  const stack: string[] = [];
  for (const ch of s) {
    if (opens.has(ch)) {
      stack.push(ch);
    } else if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) return true; // unmatched close
    }
  }
  return stack.length > 0; // leftover unmatched open
}

/**
 * Trailing tokens that mark a fragment cut off mid-clause at the END — the
 * mirror of {@link MID_CLAUSE_OPENERS}. A title/summary that ENDS on one of
 * these is a dangling imperative / auxiliary / preposition / conjunction with
 * its object sliced away: "…Make it", "…switch to", "…integrate with",
 * "…and", "…because".
 *
 * This set is BROADER than the opener set: at the end, prepositions and
 * infinitival "to" ARE truncation signals ("migrate to", "wrap with"),
 * whereas at the start they legitimately open an object capture. Auxiliaries
 * and bare imperatives ("make", "add", "use") dangle only at the end.
 */
const DANGLING_TAIL_TOKENS = new Set([
  // Coordinating / subordinating conjunctions.
  'and',
  'or',
  'but',
  'nor',
  'so',
  'yet',
  'because',
  'since',
  'while',
  'if',
  'when',
  'that',
  'than',
  'then',
  // Prepositions (object cut away).
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'from',
  'into',
  'onto',
  'over',
  'under',
  'via',
  'as',
  'per',
  // Auxiliaries / modals (verb cut away).
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'will',
  'would',
  'should',
  'could',
  'can',
  'may',
  'might',
  'must',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
  // Dangling articles / determiners.
  'the',
  'a',
  'an',
  'this',
  'these',
  'those',
  'its',
  'their',
  'our',
  'your',
  // Bare imperative openers that dangle only when nothing follows.
  'make',
  'add',
  'use',
  'set',
  'let',
  'keep',
  'move',
  'drop',
  'ship',
  'switch',
  'ensure',
  'prefer',
  'avoid',
  'wrap',
  'defer',
  'apply',
]);

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
 * True when a string ENDS mid-clause: after dropping trailing sentence
 * punctuation, its last word is a dangling conjunction / preposition /
 * auxiliary / bare imperative from {@link DANGLING_TAIL_TOKENS} — the object
 * or verb the miner should have captured was sliced away.
 *
 *   "`applyCodemod` — sync regex over many files. Make it"  → ends "it" after "Make" → dangling
 *   "Migrate the store to"                                  → ends "to"
 *   "Wrap all writes with"                                  → ends "with"
 *
 * A trailing bare pronoun after an imperative ("Make it", "Do it", "Ship it")
 * is itself a truncation tell, so we look one token back: if the final token is
 * a bare object pronoun AND the preceding token is a dangling imperative, it is
 * flagged. Otherwise a lone trailing content word is fine.
 */
export function endsMidClause(s: string): boolean {
  // Strip trailing whitespace and terminal punctuation that a real sentence
  // could legitimately carry, but keep it if it ends the clause cleanly.
  const trimmed = s.trimEnd().replace(/[)\]}"'`]+$/, '');
  if (!trimmed) return false;
  // A clean terminator means the clause closed — not truncated.
  if (/[.!?:;]$/.test(trimmed)) return false;
  const words = trimmed.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu);
  if (!words || words.length === 0) return false;
  const last = words[words.length - 1].toLowerCase();
  if (DANGLING_TAIL_TOKENS.has(last)) return true;
  // "Make it" / "Do it" — bare pronoun object after a dangling imperative.
  const BARE_PRONOUNS = new Set(['it', 'them', 'this', 'that']);
  if (words.length >= 2 && BARE_PRONOUNS.has(last)) {
    const prev = words[words.length - 2].toLowerCase();
    if (DANGLING_TAIL_TOKENS.has(prev)) return true;
  }
  return false;
}

/**
 * True when a title carries orphan markdown table-cell remnants — the miner
 * sliced a single row out of a table and glued its pipe-delimited cells onto a
 * decision. Signals: two pipe groups with an empty cell between them (`| |`),
 * or a short trailing cell fragment after a pipe (`… | P1`, `… | P0 |`).
 *
 *   "`diff_graph_snapshots` — graph evolution over time | | P1"  → "| |"
 *   "Do the thing | P0 | later"                                  → orphan cells
 *
 * A single pipe inside otherwise-normal prose (e.g. a shell `a | b` example)
 * is NOT flagged — only doubled pipes or trailing short priority-cell tails.
 */
export function hasTableRemnant(s: string): boolean {
  // Empty cell between two pipes → unmistakable table remnant.
  if (/\|\s*\|/.test(s)) return true;
  // Two or more pipes anywhere → multiple cell separators, i.e. a row slice.
  if ((s.match(/\|/g) ?? []).length >= 2) return true;
  // A single trailing priority/label cell like "| P1", "| P0", "| T2" — a
  // chopped row tail. Deliberately narrow (letter+digits, ≤ 4 chars, at the
  // very end) so a lone shell/code pipe inside prose is never flagged.
  if (/\|\s*[A-Za-z]\d{1,3}\s*$/.test(s)) return true;
  return false;
}

/**
 * Core predicate: does this mined title+content pair look like a truncated
 * mid-sentence fragment that should never enter the decision store?
 *
 * Rejection reasons (any one is fatal):
 *   - `non_english`      — non-Latin letters in title or content. Checked both
 *                          as a hard tripwire (any Cyrillic/CJK letter after
 *                          code spans are stripped) AND via the ratio heuristic.
 *   - `title_too_short`  — title under MIN_TITLE_CHARS after trim.
 *   - `title_mid_clause` — title opens on a mid-sentence continuation token.
 *   - `title_truncated`  — title ends mid-clause on a dangling token, carries an
 *                          unbalanced code/paren/bold marker, or shows table-row
 *                          remnants ("| |", "| P1").
 *   - `content_truncated`— content ends mid-clause or carries an unbalanced marker.
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

  // English-only gate. Two layers: a hard tripwire that rejects ANY non-Latin
  // letter after code spans are stripped (so a foreign tail glued onto a big
  // code span can't hide behind the code's ASCII bytes), plus the original
  // ratio heuristic on the raw text as a backstop.
  if (hasNonLatinLetter(t) || hasNonLatinLetter(c)) return 'non_english';
  if (isPredominantlyNonLatin(t)) return 'non_english';
  if (c && isPredominantlyNonLatin(c)) return 'non_english';

  // Title must not be a dangling continuation of an earlier clause.
  if (startsMidClause(t)) return 'title_mid_clause';

  // Title truncation: cut on a dangling tail token, an unbalanced structural
  // marker (open code span / paren / bold), or an orphan table-row remnant.
  if (endsMidClause(t) || hasUnbalancedMarkers(t) || hasTableRemnant(t)) {
    return 'title_truncated';
  }

  // Content must carry enough real words to be a usable summary.
  if (c.length < MIN_CONTENT_CHARS) return 'content_too_short';
  if (countWords(c) < MIN_CONTENT_WORDS) return 'content_too_short';

  // Content truncation: same dangling-tail / unbalanced-marker signals. Table
  // remnants are a title-only shape (the content window is prose), so we skip
  // that check on content to keep false positives near zero.
  if (endsMidClause(c) || hasUnbalancedMarkers(c)) return 'content_truncated';

  return null;
}

/** Convenience boolean wrapper over {@link minedDecisionRejectReason}. */
export function isValidMinedDecision(title: string, content: string): boolean {
  return minedDecisionRejectReason(title, content) === null;
}
