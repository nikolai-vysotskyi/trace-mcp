/**
 * Shared helper: detect whether a symbol's name is referenced elsewhere in
 * its own file, outside its declaration range.
 *
 * Catches the default-arg / closure-capture / file-local-helper case where
 * the indexer doesn't emit a `calls`/`references` edge but the symbol is
 * clearly used. Example:
 *
 *     export const CANARY_PATH = path.join(...);
 *     export async function checkEmbeddingDrift(opts = {}) {
 *       const file = opts.filePath ?? CANARY_PATH;  // <-- intra-file use
 *     }
 *
 * Used by both `getDeadCodeV2` (multi-signal dead-code detection) and
 * `getDeadExports` (export-keyword vs symbol-life distinction).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Returns true when `name` appears as a word-boundary token anywhere in
 * `fileContent` OUTSIDE the line range `[lineStart, lineEnd]` (the symbol's
 * own declaration). Skips matches inside line-leading comments to avoid
 * counting a JSDoc/docblock mention as a real use.
 */
export function isUsedIntraFile(
  fileContent: string,
  name: string,
  lineStart: number | null,
  lineEnd: number | null,
): boolean {
  if (!name) return false;
  // Word-boundary match. Escape regex metachars in `name` defensively.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  const lines = fileContent.split('\n');
  let match: RegExpExecArray | null;
  const startLine = lineStart ?? -1;
  const endLine = lineEnd ?? -1;
  let lineNo = 1;
  for (const line of lines) {
    if (startLine === -1 || lineNo < startLine || lineNo > endLine) {
      re.lastIndex = 0;
      while ((match = re.exec(line)) !== null) {
        // Skip matches inside a comment that's the very first non-whitespace
        // of the line — common in JSDoc / inline comments mentioning the
        // symbol by name. Cheap heuristic, avoids the "the docblock counts
        // as a use" false-negative-on-deletion.
        const trimmed = line.slice(0, match.index).trimStart();
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*') ||
          trimmed.startsWith('#')
        ) {
          continue;
        }
        return true;
      }
    }
    lineNo++;
  }
  return false;
}

/**
 * Build a per-call file-content reader that caches results across calls.
 * Returns `null` for files outside the project root, unreadable files, or
 * files larger than 2 MB (almost certainly generated; the safer side of a
 * false positive is to skip the intra-file check).
 *
 * When `projectRoot` is undefined the reader always returns `null` — callers
 * fall back to the previous "no intra-file evidence" behaviour, preserving
 * backwards compatibility for embedded usage that lacks a working directory.
 */
export function makeIntraFileReader(
  projectRoot: string | undefined,
): (filePath: string) => string | null {
  const cache = new Map<string, string | null>();
  return (filePath: string): string | null => {
    if (cache.has(filePath)) return cache.get(filePath) ?? null;
    let content: string | null = null;
    if (projectRoot) {
      const root = path.resolve(projectRoot);
      const abs = path.resolve(root, filePath);
      // Enforce the containment this function's docstring already promises.
      // Without it an absolute `filePath` silently escapes `projectRoot`.
      const contained = abs === root || abs.startsWith(root + path.sep);
      let fd: number | undefined;
      try {
        if (!contained) throw new Error('outside project root');
        // Stat and read the same open fd rather than statSync(path) then
        // readFileSync(path) — two path-based calls still race (the file
        // can change between them) even without an explicit existsSync.
        fd = fs.openSync(abs, 'r');
        const stat = fs.fstatSync(fd);
        if (stat.size <= 2 * 1024 * 1024) {
          content = fs.readFileSync(fd, 'utf-8');
        }
      } catch {
        /* missing or unreadable file — fall back to "no intra-file evidence" */
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* already closed or unclosable — nothing more we can do */
          }
        }
      }
    }
    cache.set(filePath, content);
    return content;
  };
}
