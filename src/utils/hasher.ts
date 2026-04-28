import crypto from 'node:crypto';
import fs from 'node:fs';

/** Hash file content for change detection. MD5 for speed. */
export function hashContent(content: Buffer): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/** Convenience: read file and hash in one call. */
function _hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return hashContent(content);
}
