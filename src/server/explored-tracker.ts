/**
 * Tracks which files have been explored via trace-mcp tools (get_outline, get_symbol, etc.).
 * Writes marker files to /tmp so the guard hook can check whether a file was already
 * explored before blocking a Read call.
 *
 * The guard hook and this tracker share a convention:
 * - Directory: /tmp/trace-mcp-explored-<sha256(projectRoot)[0:12]>/
 * - Marker file: <sha256(absoluteFilePath)> containing the absolute path
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ensureTmpDirSync, writeTmpFileSync } from '../utils/safe-fs.js';

interface ExploredTracker {
  /** Mark a file as explored via trace-mcp. Guard hook will allow Read on it. */
  markExplored(filePath: string): void;
}

export function createExploredTracker(projectRoot: string): ExploredTracker {
  const hash = crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);
  const markerDir = path.join(os.tmpdir(), `trace-mcp-explored-${hash}`);

  // If we can't create the dir — or someone else owns that name — markExplored
  // becomes a no-op.
  const dirUsable = ensureTmpDirSync(markerDir);

  return {
    markExplored(filePath: string): void {
      if (!dirUsable) return;
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
      const fileHash = crypto.createHash('sha256').update(absPath).digest('hex');
      try {
        writeTmpFileSync(path.join(markerDir, fileHash), absPath);
      } catch {
        // Non-critical — guard hook falls back to deny/allow toggle
      }
    },
  };
}
