import fs from 'node:fs';
import path from 'node:path';
import type { FileRow } from '../db/types.js';
import { logger } from '../logger.js';
import { hashContent } from '../utils/hasher.js';

/** Minimal Store surface `detectRenames` needs — kept narrow so this module
 *  doesn't have to import the full `Store` class (which would be a much
 *  heavier dependency edge than the two methods actually used). */
export interface RenameDetectorStore {
  getAllFiles(): FileRow[];
  updateFilePath(fileId: number, newPath: string): void;
}

/**
 * Pre-pass: detect file renames by content hash. When a path on disk has no
 * matching DB row but its content hash matches a DB row whose old path no
 * longer exists on disk, treat it as a rename — atomically update the file
 * row's path and skip extraction. Inspired by graphify v0.7.0's move to
 * content-only cache keys.
 *
 * Returns the count of detected renames. Mutates the DB (via `store`) and
 * the `existingFiles` lookup so the caller can re-load it.
 *
 * Moved out of `IndexingPipeline.detectRenames` verbatim (2026-07 complexity
 * reduction pass) — behavior must stay byte-identical to the original
 * private method; only `this.*` field reads became explicit parameters.
 */
export function detectRenames(
  store: RenameDetectorStore,
  rootPath: string,
  relPaths: string[],
  existingFiles: Map<string, FileRow>,
): number {
  // Files in DB whose path is not in the current scan list — candidates
  // for "old name of a renamed file".
  const onDiskSet = new Set(relPaths);
  const orphans = store.getAllFiles().filter((f) => {
    if (!f.content_hash) return false;
    if (onDiskSet.has(f.path)) return false;
    // Defensive: only consider rows whose old path actually no longer exists
    // on disk. A second snapshot could otherwise mistakenly rename a row
    // whose original file was simply excluded from this batch.
    const abs = path.resolve(rootPath, f.path);
    return !fs.existsSync(abs);
  });
  if (orphans.length === 0) return 0;

  // Index orphans by hash for O(1) lookup. A given hash may appear under
  // multiple orphans (legitimate identical files that were all moved); we
  // keep them in an array and pick the first available match per new path.
  const orphansByHash = new Map<string, FileRow[]>();
  for (const o of orphans) {
    const arr = orphansByHash.get(o.content_hash!) ?? [];
    arr.push(o);
    orphansByHash.set(o.content_hash!, arr);
  }

  let renamed = 0;
  for (const relPath of relPaths) {
    if (existingFiles.has(relPath)) continue; // already known under this path
    const abs = path.resolve(rootPath, relPath);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue; // unreadable file — leave for the normal error path
    }
    const hash = hashContent(buf);
    const candidates = orphansByHash.get(hash);
    if (!candidates || candidates.length === 0) continue;

    const orphan = candidates.shift()!;
    // Carry the existing row over to the new path. All FK references
    // (symbols, edges, nodes) keep their connection because the row id
    // does not change.
    store.updateFilePath(orphan.id, relPath);
    existingFiles.set(relPath, { ...orphan, path: relPath });
    renamed++;
    logger.debug(
      { from: orphan.path, to: relPath, hash: hash.slice(0, 8) },
      'Detected rename — reused existing symbols',
    );
  }
  return renamed;
}
