/**
 * Maps byte/line positions in preprocessed SQL back to the original file text.
 */

export interface SqlPositionMap {
  readonly original: string;
  readonly preprocessed: string;
  origByteAt(preIndex: number): number;
  origLineStart(preLine: number): number;
  origLineEnd(preLine: number): number;
}

export function lineAt(source: string, byteOffset: number): number {
  if (byteOffset <= 0) return 1;
  const clamped = Math.min(byteOffset, source.length);
  return source.slice(0, clamped).split('\n').length;
}

export class SqlSourceMapBuilder {
  text: string;
  private readonly original: string;
  private toOrig: number[];

  constructor(original: string) {
    this.original = original;
    this.text = original;
    this.toOrig = Array.from({ length: original.length }, (_, i) => i);
  }

  splice(start: number, end: number, insert: string, origSpanStart: number): void {
    const anchor = Math.max(0, Math.min(origSpanStart, this.original.length - 1));
    const insertOrig = Array.from({ length: insert.length }, () => anchor);
    this.toOrig = [...this.toOrig.slice(0, start), ...insertOrig, ...this.toOrig.slice(end)];
    this.text = this.text.slice(0, start) + insert + this.text.slice(end);
  }

  replaceAll(
    re: RegExp,
    replacer: (match: string, ...groups: string[]) => string,
    origSpanStart: (matchStart: number) => number,
  ): void {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const globalRe = new RegExp(re.source, flags);
    const matches: Array<{ start: number; end: number; match: string; groups: string[] }> = [];
    for (const m of this.text.matchAll(globalRe)) {
      if (m.index == null) continue;
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        match: m[0],
        groups: m.slice(1) as string[],
      });
    }
    for (let i = matches.length - 1; i >= 0; i--) {
      const { start, end, match, groups } = matches[i]!;
      const insert = replacer(match, ...groups);
      this.splice(start, end, insert, origSpanStart(start));
    }
  }

  finish(): SqlPositionMap {
    const original = this.original;
    const preprocessed = this.text;
    const toOrig = this.toOrig;
    return {
      original,
      preprocessed,
      origByteAt(preIndex: number): number {
        if (toOrig.length === 0) return 0;
        if (preIndex < 0) return toOrig[0] ?? 0;
        if (preIndex >= toOrig.length) return toOrig[toOrig.length - 1] ?? 0;
        return toOrig[preIndex] ?? 0;
      },
      origLineStart(preLine: number): number {
        return lineAt(original, byteAtPreLine(preprocessed, preLine));
      },
      origLineEnd(preLine: number): number {
        return lineAt(original, byteAtPreLineEnd(preprocessed, preLine));
      },
    };
  }
}

function byteAtPreLine(preprocessed: string, preLine: number): number {
  if (preLine <= 1) return 0;
  let line = 1;
  for (let i = 0; i < preprocessed.length; i++) {
    if (line === preLine) return i;
    if (preprocessed[i] === '\n') line++;
  }
  return preprocessed.length;
}

function byteAtPreLineEnd(preprocessed: string, preLine: number): number {
  if (preLine < 1) return 0;
  let line = 1;
  for (let i = 0; i < preprocessed.length; i++) {
    if (preprocessed[i] === '\n') {
      if (line === preLine) return i;
      line++;
    }
  }
  return preprocessed.length;
}

export function mapPreprocessedSpan(
  map: SqlPositionMap,
  preByteStart: number,
  preByteEnd: number,
): { byteStart: number; byteEnd: number; lineStart: number; lineEnd: number } {
  const orig = map.original;
  const byteStart = map.origByteAt(preByteStart);
  const lastPre = Math.max(preByteStart, preByteEnd - 1);
  const byteEnd =
    preByteEnd <= preByteStart
      ? byteStart
      : map.origByteAt(Math.min(lastPre, map.preprocessed.length - 1)) + 1;
  return {
    byteStart,
    byteEnd,
    lineStart: lineAt(orig, byteStart),
    lineEnd: lineAt(orig, Math.max(byteStart, byteEnd - 1)),
  };
}

export function mapPreprocessedLine(map: SqlPositionMap, preLine: number): number {
  return map.origLineStart(preLine);
}
