import fs from 'node:fs';
import path from 'node:path';
import { redactEnvFile } from './env-parser.js';

const GITIGNORED_NOTICE = '[content hidden — file is gitignored]';

/**
 * Read source code from a file using byte offsets. O(1) retrieval.
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
  const fd = fs.openSync(filePath, 'r');
  try {
    const length = byteEnd - byteStart;
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, byteStart);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Modifiers that may sit on the same line BEFORE a declaration's recorded
// byte range. Tree-sitter records the inner `function_declaration` / `class_declaration`
// range, which excludes the wrapping `export_statement` and standalone keywords
// like `async` / `default` / visibility modifiers. We extend the slice back to
// capture them so the returned `source` matches what the developer wrote.
const LEADING_MODIFIER_RE =
  /^(?:export\s+default\s+async\s+|export\s+default\s+|export\s+async\s+|export\s+|default\s+async\s+|default\s+|async\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|readonly\s+|declare\s+)+$/;

/**
 * Read source for a symbol, extending the byte range backward on the same line
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

  // Read up to 64 bytes of context preceding the symbol, then scan back to
  // the start of the line and see whether it's whitespace + recognised
  // modifiers only. If so, extend the slice to include them.
  const PREFIX_PEEK = 64;
  const peekStart = Math.max(0, byteStart - PREFIX_PEEK);
  const peekLen = byteStart - peekStart;

  const fd = fs.openSync(filePath, 'r');
  try {
    let extendedStart = byteStart;
    if (peekLen > 0) {
      const peekBuf = Buffer.alloc(peekLen);
      fs.readSync(fd, peekBuf, 0, peekLen, peekStart);
      const peekStr = peekBuf.toString('utf8');
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

    const length = byteEnd - extendedStart;
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, extendedStart);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const ENV_BASENAME_RE = /^\.env(\..+)?$/;

/** Check if a file path is a .env file. */
function isEnvFile(filePath: string): boolean {
  return ENV_BASENAME_RE.test(path.basename(filePath));
}

/**
 * Read a file safely:
 * - .env files → redact values, return keys + type hints (even if gitignored)
 * - gitignored files → return notice instead of source
 * - all other files → return content as-is
 */
function _readFileSafe(filePath: string, gitignored?: boolean): string {
  // .env redaction takes priority over gitignore — keys/types are always safe to expose
  if (isEnvFile(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    return redactEnvFile(content);
  }
  if (gitignored) return GITIGNORED_NOTICE;
  return fs.readFileSync(filePath, 'utf-8');
}
