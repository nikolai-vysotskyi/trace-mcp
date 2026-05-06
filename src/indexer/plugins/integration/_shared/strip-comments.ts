/**
 * Remove `//` line comments and `/* ... *​/` block comments from a JS/TS
 * source string. String literals are preserved — they are part of the
 * program's data and are routinely required by callers (e.g. extracting
 * `'jwt'` out of `AuthGuard('jwt')`).
 *
 * The implementation is single-pass and string-literal-aware: a `//` or `/*`
 * sequence inside a quoted string is left intact.
 */
export function stripJsComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    // Line comment
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2);
      if (nl === -1) break;
      i = nl;
      continue;
    }

    // Block comment
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }

    // String literal — copy verbatim, skipping over escapes so we don't
    // mis-detect comment sequences that happen to live inside strings.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = source[i];
        out += c;
        i++;
        if (c === '\\') {
          // copy escaped char literally
          if (i < n) {
            out += source[i];
            i++;
          }
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}
