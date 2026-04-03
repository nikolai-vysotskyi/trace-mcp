import fs from 'node:fs';

/**
 * Read source code from a file using byte offsets. O(1) retrieval.
 */
export function readByteRange(
  filePath: string,
  byteStart: number,
  byteEnd: number,
): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const length = byteEnd - byteStart;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, byteStart);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
