import fs from 'node:fs';
import path from 'node:path';
import { redactEnvFile } from './env-parser.js';

/**
 * Read source code from a file using byte offsets. O(1) retrieval.
 */
export function readByteRange(
  filePath: string,
  byteStart: number,
  byteEnd: number,
): string {
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
export function isEnvFile(filePath: string): boolean {
  return ENV_BASENAME_RE.test(path.basename(filePath));
}

/**
 * Read a file safely — if it's a .env file, redact values and return only
 * keys with type hints. For all other files, return content as-is.
 */
export function readFileSafe(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (isEnvFile(filePath)) {
    return redactEnvFile(content);
  }
  return content;
}
