/**
 * Tracks which files have been explored via trace-mcp tools (get_outline, get_symbol, etc.).
 * Writes marker files to /tmp so the guard hook can check whether a file was already
 * explored before blocking a Read call.
 *
 * The guard hook and this tracker share a convention:
 * - Directory: /tmp/trace-mcp-explored-<sha256(projectRoot)[0:12]>/
 * - Marker file: <sha256(absoluteFilePath)> containing the absolute path
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface ExploredTracker {
  /** Mark a file as explored via trace-mcp. Guard hook will allow Read on it. */
  markExplored(filePath: string): void;
}

export function createExploredTracker(projectRoot: string): ExploredTracker {
  const hash = crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);
  const markerDir = path.join(os.tmpdir(), `trace-mcp-explored-${hash}`);

  try {
    fs.mkdirSync(markerDir, { recursive: true });
  } catch {
    // If we can't create the dir, markExplored becomes a no-op
  }

  return {
    markExplored(filePath: string): void {
      const absPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(projectRoot, filePath);
      const fileHash = crypto.createHash('sha256').update(absPath).digest('hex');
      try {
        fs.writeFileSync(path.join(markerDir, fileHash), absPath);
      } catch {
        // Non-critical — guard hook falls back to deny/allow toggle
      }
    },
  };
}
