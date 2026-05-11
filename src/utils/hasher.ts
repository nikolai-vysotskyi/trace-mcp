import fs from 'node:fs';
import { contentHash } from '../util/hash.js';

/** Hash file content for change detection. xxh64 (~3 GB/s) via xxhash-wasm.
 *  Caller must have awaited initContentHasher() at pipeline startup. */
export function hashContent(content: Buffer): string {
  return contentHash(content);
}

/** Convenience: read file and hash in one call. */
function _hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return hashContent(content);
}
