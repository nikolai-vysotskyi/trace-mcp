import fs from 'node:fs';
import path from 'node:path';
import type { FileRow } from '../db/types.js';
import { logger } from '../logger.js';
import { yieldToEventLoopFair } from '../utils/event-loop.js';
import { hashContent } from '../utils/hasher.js';

/** Minimal Store surface `detectRenames` needs — kept narrow so this module
 *  doesn't have to import the full `Store` class (which would be a much
 *  heavier dependency edge than the two methods actually used). */
export interface RenameDetectorStore {
  getAllFiles(): FileRow[];
  updateFilePath(fileId: number, newPath: string): void;
}

export interface DetectedRename {
  /** DB row path that no longer exists on disk. */
  from: string;
  /** Current on-disk path the row was carried over to. */
  to: string;
}

export interface DetectRenamesResult {
  renamed: number;
  /** Old → new path pairs, in detection order (TRA-1577: tree-cache moves). */
  pairs: DetectedRename[];
}

/**
 * Pre-pass: detect file renames by content hash. When a path on disk has no
 * matching DB row but its content hash matches a DB row whose old path no
 * longer exists on disk, treat it as a rename — atomically update the file
 * row's path and skip extraction. Inspired by graphify v0.7.0's move to
 * content-only cache keys.
 *
 * Returns the count of detected renames plus the old → new pairs. Mutates
 * the DB (via `store`) and the `existingFiles` lookup so the caller can
 * re-load it.
 *
 * Moved out of `IndexingPipeline.detectRenames` verbatim (2026-07 complexity
 * reduction pass) — behavior must stay byte-identical to the original
 * private method; only `this.*` field reads became explicit parameters.
 * TRA-1577 widened the return from a bare count to `{ renamed, pairs }` so
 * callers can move per-file caches along the rename; the detection itself is
 * untouched.
 */
export function detectRenames(
  store: RenameDetectorStore,
  rootPath: string,
  relPaths: string[],
  existingFiles: Map<string, FileRow>,
): DetectRenamesResult {
  // Fast path (TRA-2282): if all candidate paths already exist in the DB,
  // none of them can be the target of a rename. Exit immediately to avoid
  // scanning all files in the DB with fs.existsSync on every incremental save.
  const hasNewFiles = relPaths.some((p) => !existingFiles.has(p));
  if (!hasNewFiles) return { renamed: 0, pairs: [] };

  // Fast path: if the store has no files at all (initial indexing),
  // there are no existing rows to rename.
  const allStored = store.getAllFiles();
  if (allStored.length === 0) return { renamed: 0, pairs: [] };

  // Read and hash only new candidate paths on disk first (TRA-2380).
  // Without this, every incremental creation (e.g. 1 new file in a 15k-file repo)
  // ran fs.existsSync across every non-batch file in the database synchronously,
  // causing multi-second event loop stalls.
  const newCandidates: Array<{ relPath: string; hash: string }> = [];
  const targetHashes = new Set<string>();
  for (const relPath of relPaths) {
    if (existingFiles.has(relPath)) continue;
    const abs = path.resolve(rootPath, relPath);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    const hash = hashContent(buf);
    newCandidates.push({ relPath, hash });
    targetHashes.add(hash);
  }
  if (newCandidates.length === 0 || targetHashes.size === 0) {
    return { renamed: 0, pairs: [] };
  }

  // Filter DB rows by hash match FIRST before any fs.existsSync stat calls.
  const onDiskSet = new Set(relPaths);
  const orphans = allStored.filter((f) => {
    if (!f.content_hash || !targetHashes.has(f.content_hash)) return false;
    if (onDiskSet.has(f.path)) return false;
    // Defensive: only consider rows whose old path actually no longer exists
    // on disk. A second snapshot could otherwise mistakenly rename a row
    // whose original file was simply excluded from this batch.
    const abs = path.resolve(rootPath, f.path);
    return !fs.existsSync(abs);
  });
  if (orphans.length === 0) return { renamed: 0, pairs: [] };

  // Index orphans by hash for O(1) lookup.
  const orphansByHash = new Map<string, FileRow[]>();
  for (const o of orphans) {
    const arr = orphansByHash.get(o.content_hash!) ?? [];
    arr.push(o);
    orphansByHash.set(o.content_hash!, arr);
  }

  let renamed = 0;
  const pairs: DetectedRename[] = [];
  for (const { relPath, hash } of newCandidates) {
    const candidates = orphansByHash.get(hash);
    if (!candidates || candidates.length === 0) continue;

    const orphan = candidates.shift()!;
    // Carry the existing row over to the new path. All FK references
    // (symbols, edges, nodes) keep their connection because the row id
    // does not change.
    store.updateFilePath(orphan.id, relPath);
    existingFiles.set(relPath, { ...orphan, path: relPath });
    renamed++;
    pairs.push({ from: orphan.path, to: relPath });
    logger.debug(
      { from: orphan.path, to: relPath, hash: hash.slice(0, 8) },
      'Detected rename — reused existing symbols',
    );
  }
  return { renamed, pairs };
}

/**
 * TRA-2524: Asynchronous variant of `detectRenames` that yields to the
 * event loop periodically while reading and hashing new candidate files.
 */
export async function detectRenamesAsync(
  store: RenameDetectorStore,
  rootPath: string,
  relPaths: string[],
  existingFiles: Map<string, FileRow>,
): Promise<DetectRenamesResult> {
  const hasNewFiles = relPaths.some((p) => !existingFiles.has(p));
  if (!hasNewFiles) return { renamed: 0, pairs: [] };

  const allStored = store.getAllFiles();
  if (allStored.length === 0) return { renamed: 0, pairs: [] };

  const newCandidates: Array<{ relPath: string; hash: string }> = [];
  const targetHashes = new Set<string>();
  let hashedCount = 0;
  for (const relPath of relPaths) {
    if (existingFiles.has(relPath)) continue;
    if (hashedCount > 0 && hashedCount % 32 === 0) {
      await yieldToEventLoopFair();
    }
    const abs = path.resolve(rootPath, relPath);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    hashedCount++;
    const hash = hashContent(buf);
    newCandidates.push({ relPath, hash });
    targetHashes.add(hash);
  }
  if (newCandidates.length === 0 || targetHashes.size === 0) {
    return { renamed: 0, pairs: [] };
  }

  const onDiskSet = new Set(relPaths);
  const orphans = allStored.filter((f) => {
    if (!f.content_hash || !targetHashes.has(f.content_hash)) return false;
    if (onDiskSet.has(f.path)) return false;
    const abs = path.resolve(rootPath, f.path);
    return !fs.existsSync(abs);
  });
  if (orphans.length === 0) return { renamed: 0, pairs: [] };

  const orphansByHash = new Map<string, FileRow[]>();
  for (const o of orphans) {
    const arr = orphansByHash.get(o.content_hash!) ?? [];
    arr.push(o);
    orphansByHash.set(o.content_hash!, arr);
  }

  let renamed = 0;
  const pairs: DetectedRename[] = [];
  for (const { relPath, hash } of newCandidates) {
    const candidates = orphansByHash.get(hash);
    if (!candidates || candidates.length === 0) continue;

    const orphan = candidates.shift()!;
    store.updateFilePath(orphan.id, relPath);
    existingFiles.set(relPath, { ...orphan, path: relPath });
    renamed++;
    pairs.push({ from: orphan.path, to: relPath });
    logger.debug(
      { from: orphan.path, to: relPath, hash: hash.slice(0, 8) },
      'Detected rename — reused existing symbols',
    );
  }
  return { renamed, pairs };
}
