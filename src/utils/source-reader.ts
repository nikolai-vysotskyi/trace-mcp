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
function readFileSafe(filePath: string, gitignored?: boolean): string {
  // .env redaction takes priority over gitignore — keys/types are always safe to expose
  if (isEnvFile(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    return redactEnvFile(content);
  }
  if (gitignored) return GITIGNORED_NOTICE;
  return fs.readFileSync(filePath, 'utf-8');
}
