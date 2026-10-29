import fs from 'node:fs';
import path from 'node:path';

const GITIGNORED_NOTICE = '[content hidden — file is gitignored]';

/**
 * Read source code using the UTF-16 offsets stored by the indexer.
 * When `gitignored` is true, returns a redaction notice instead of source.
 * .env files are exempt — their redacted content is always safe to serve.
 */
export function readByteRange(
  filePath: string,
  byteStart: number,
  byteEnd: number,
  gitignored?: boolean,
): string {
  if (gitignored && !isEnvFile(filePath)) return GITIGNORED_NOTICE;
  if (byteEnd <= byteStart || byteStart < 0) return '';
  return fs.readFileSync(filePath, 'utf8').slice(byteStart, byteEnd);
}

// Modifiers that may sit on the same line BEFORE a declaration's recorded
// byte range. Tree-sitter records the inner `function_declaration` / `class_declaration`
// range, which excludes the wrapping `export_statement` and standalone keywords
// like `async` / `default` / visibility modifiers. We extend the slice back to
// capture them so the returned `source` matches what the developer wrote.
//
// Only single-keyword alternatives — a compound alternative like
// `export\s+async\s+` alongside its parts `export\s+` and `async\s+` is
// ambiguous under `+` repetition (matchable as one rep or two), which is
// exactly the shape that causes catastrophic backtracking (CodeQL js/redos).
// The `+` loop already accepts any keyword sequence, so compounds are redundant.
const MODIFIER_WORD =
  'export|default|async|public|private|protected|static|abstract|readonly|declare';
const LEADING_MODIFIER_RE = new RegExp(`^(?:${MODIFIER_WORD})(?:\\s+(?:${MODIFIER_WORD}))*\\s+$`);

/**
 * Read source for a symbol, extending the UTF-16 range backward on the same line
 * to include leading modifiers (export / export default / async / public / …)
 * that tree-sitter excludes from the symbol's own range.
 *
 * Fixes the get_symbol off-by-N bug where exported functions returned a body
 * starting at "t function foo(" instead of "export function foo(".
 */
export function readSymbolSource(
  filePath: string,
  byteStart: number,
  byteEnd: number,
  gitignored?: boolean,
): string {
  if (gitignored && !isEnvFile(filePath)) return GITIGNORED_NOTICE;
  if (byteEnd <= byteStart || byteStart < 0) return '';

  return sliceSymbolSource(fs.readFileSync(filePath, 'utf8'), byteStart, byteEnd);
}

/** Apply the same modifier extension to disk and Git HEAD source. */
export function sliceSymbolSource(content: string, byteStart: number, byteEnd: number): string {
  if (byteEnd <= byteStart || byteStart < 0) return '';

  // Read up to 64 UTF-16 code units preceding the symbol, then scan back to
  // the start of the line and see whether it's whitespace + recognised
  // modifiers only. If so, extend the slice to include them.
  const PREFIX_PEEK = 64;
  const peekStart = Math.max(0, byteStart - PREFIX_PEEK);
  const peekLen = byteStart - peekStart;

  let extendedStart = byteStart;
  if (peekLen > 0) {
    const peekStr = content.slice(peekStart, byteStart);
    // Find last newline → start of the current line within the peek window.
    const lastNl = peekStr.lastIndexOf('\n');
    const lineHeadInPeek = lastNl >= 0 ? lastNl + 1 : 0;
    const lineHead = peekStr.slice(lineHeadInPeek);
    const stripped = lineHead.replace(/^[ \t]+/, '');
    if (stripped.length > 0 && LEADING_MODIFIER_RE.test(stripped)) {
      // Extend start back to the beginning of the leading whitespace so the
      // returned source is line-aligned and includes the export prefix.
      extendedStart = peekStart + lineHeadInPeek;
    }
  }
  return content.slice(extendedStart, byteEnd);
}

const ENV_BASENAME_RE = /^\.env(\..+)?$/;

/**
 * Check if a file path is a secret-holding env file.
 * Covers `.env`, `.env.*` (e.g. `.env.local`) and `*.env` (e.g. `prod.env`).
 *
 * Raw-text paths (search_text, rename non-code scan) must never read these —
 * key discovery stays available via get_env_vars (keys + type hints only).
 */
export function isEnvFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return ENV_BASENAME_RE.test(base) || base.endsWith('.env');
}
