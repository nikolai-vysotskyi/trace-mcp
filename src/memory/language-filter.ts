/**
 * Language filter — drops decision candidates that are predominantly
 * non-English (Russian, Chinese, Arabic, etc.).
 *
 * The project's "English only in code and content" rule (see CLAUDE.md)
 * applies to anything that lands in the persistent knowledge graph.
 * Mined sessions frequently include user prose in other languages — that
 * prose should not silently leak into decision titles or content.
 *
 * Heuristic: count code points in well-known non-Latin Unicode ranges.
 * If the share of non-Latin "letter-like" chars exceeds the threshold,
 * reject the string. Whitespace, punctuation, digits, ASCII symbols, and
 * code-like tokens (backticks, braces, brackets) are not counted on
 * either side so short identifier-heavy snippets pass.
 */

/** Default rejection threshold — strings with more than this share of
 *  non-Latin letters are considered non-English. */
export const NON_LATIN_REJECT_RATIO = 0.3;

/**
 * Return the share (0..1) of non-Latin letter-like code points in `s`,
 * relative to the total number of letter-like code points. Returns 0 for
 * strings with no letters at all (digit-only, symbol-only).
 */
export function nonLatinShare(s: string): number {
  if (!s) return 0;
  let latin = 0;
  let nonLatin = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    // ASCII letters
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      latin++;
      continue;
    }
    // Latin-1 Supplement letters + Latin Extended (À-ɏ excluding symbols)
    if (cp >= 0x00c0 && cp <= 0x024f) {
      latin++;
      continue;
    }
    // Cyrillic + Cyrillic Supplement
    if ((cp >= 0x0400 && cp <= 0x04ff) || (cp >= 0x0500 && cp <= 0x052f)) {
      nonLatin++;
      continue;
    }
    // Greek + Greek Extended
    if ((cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x1f00 && cp <= 0x1fff)) {
      nonLatin++;
      continue;
    }
    // Arabic (incl. supplement) + Hebrew
    if (
      (cp >= 0x0590 && cp <= 0x05ff) ||
      (cp >= 0x0600 && cp <= 0x06ff) ||
      (cp >= 0x0750 && cp <= 0x077f)
    ) {
      nonLatin++;
      continue;
    }
    // CJK Unified Ideographs (Chinese / Japanese kanji)
    if (cp >= 0x4e00 && cp <= 0x9fff) {
      nonLatin++;
      continue;
    }
    // Hiragana + Katakana
    if (cp >= 0x3040 && cp <= 0x30ff) {
      nonLatin++;
      continue;
    }
    // Hangul (Korean)
    if (
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x1100 && cp <= 0x11ff) ||
      (cp >= 0x3130 && cp <= 0x318f)
    ) {
      nonLatin++;
      continue;
    }
    // Devanagari, Thai, etc.
    if (
      (cp >= 0x0900 && cp <= 0x097f) ||
      (cp >= 0x0e00 && cp <= 0x0e7f) ||
      (cp >= 0x0980 && cp <= 0x09ff)
    ) {
      nonLatin++;
      continue;
    }
    // Punctuation, digits, whitespace, code symbols — ignored.
  }
  const total = latin + nonLatin;
  if (total === 0) return 0;
  return nonLatin / total;
}

/**
 * True when the share of non-Latin letters in `s` exceeds `ratio`.
 * Default threshold: 30%. Strings with no letters at all return false.
 */
export function isPredominantlyNonLatin(s: string, ratio = NON_LATIN_REJECT_RATIO): boolean {
  return nonLatinShare(s) > ratio;
}
