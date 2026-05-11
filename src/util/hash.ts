// Cheap content-hash gate for the FileExtractor mtime fast-path.
// xxhash-wasm exposes xxh32/xxh64 (not xxh3); we use 64-bit for collision
// safety on multi-million-file repos. The output is hex-encoded so it can be
// stored in the existing TEXT files.content_hash column without a migration.
//
// Lazy WASM init via a module-level cached promise — same idiom as
// src/parser/tree-sitter.ts::ensureInit.

import xxhash, { type XXHashAPI } from 'xxhash-wasm';

let initPromise: Promise<XXHashAPI> | null = null;
let api: XXHashAPI | null = null;

export function initContentHasher(): Promise<void> {
  if (!initPromise) {
    initPromise = xxhash().then((mod) => {
      api = mod;
      return mod;
    });
  }
  return initPromise.then(() => undefined);
}

export function contentHash(buf: Buffer): string {
  if (!api) {
    throw new Error('contentHash called before initContentHasher() resolved');
  }
  // Buffer is a Uint8Array subclass — h64Raw accepts it directly. Re-wrap
  // when the buffer is a slice of a larger ArrayBuffer so we don't hash
  // the underlying pool tail.
  const view =
    buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
      ? (buf as unknown as Uint8Array)
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return api.h64Raw(view).toString(16).padStart(16, '0');
}

export function isContentHasherReady(): boolean {
  return api !== null;
}
