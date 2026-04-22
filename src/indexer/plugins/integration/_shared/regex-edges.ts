/**
 * Shared helpers for regex-based plugins that emit symbol-level edges
 * by locating the enclosing symbol for each regex match.
 */

export interface FileSymbol {
  id: number;
  symbolId: string;
  name: string;
  kind: string;
  lineStart?: number | null;
  lineEnd?: number | null;
}

/** 1-based line number for a byte index in source. */
export function lineOfIndex(source: string, idx: number): number {
  let line = 1;
  const max = Math.min(idx, source.length);
  for (let i = 0; i < max; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Find the innermost (smallest line-range) symbol that contains `line`.
 * Useful to attribute a regex match to its enclosing function/variable.
 */
export function findEnclosingSymbol(
  symbols: FileSymbol[],
  line: number,
): FileSymbol | undefined {
  let best: FileSymbol | undefined;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const s of symbols) {
    if (s.lineStart == null || s.lineEnd == null) continue;
    if (line < s.lineStart || line > s.lineEnd) continue;
    const size = s.lineEnd - s.lineStart;
    if (size < bestSize) {
      bestSize = size;
      best = s;
    }
  }
  return best;
}
