/**
 * Returns true when `offset` lies inside a Python comment or string literal.
 */

export function isOffsetInPythonCommentOrString(source: string, offset: number): boolean {
  if (offset < 0 || offset >= source.length) return false;
  let i = 0;
  const n = source.length;

  while (i < n) {
    if (i > offset) return false;

    if (source[i] === '#') {
      const lineEnd = source.indexOf('\n', i);
      const end = lineEnd === -1 ? n : lineEnd;
      if (offset >= i && offset < end) return true;
      i = end;
      continue;
    }

    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const start = i;
      const triple = source[i + 1] === ch && source[i + 2] === ch;
      i += triple ? 3 : 1;
      while (i < n) {
        if (source[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (triple) {
          if (source[i] === ch && source[i + 1] === ch && source[i + 2] === ch) {
            i += 3;
            if (offset >= start && offset < i) return true;
            break;
          }
          i++;
          continue;
        }
        if (source[i] === ch) {
          i++;
          if (offset >= start && offset < i) return true;
          break;
        }
        i++;
      }
      continue;
    }

    i++;
  }

  return false;
}
