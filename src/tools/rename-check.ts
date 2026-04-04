/**
 * Rename safety check — pre-rename collision detection.
 *
 * Before renaming a symbol, checks the symbol's own file and all files that
 * import it for existing symbols with the same target name.
 * Reports conflicts with file, existing symbol, and line number.
 */

import type { Store } from '../db/store.js';

export interface RenameConflict {
  file: string;
  existing_symbol_id: string;
  existing_name: string;
  kind: string;
  line: number | null;
  reason: 'same_file' | 'importing_file';
}

export interface RenameCheckResult {
  symbol_id: string;
  current_name: string;
  target_name: string;
  safe: boolean;
  conflicts: RenameConflict[];
}

export function checkRenameSafe(
  store: Store,
  symbolId: string,
  targetName: string,
): RenameCheckResult {
  const symbol = store.getSymbolBySymbolId(symbolId);
  if (!symbol) {
    return {
      symbol_id: symbolId,
      current_name: '',
      target_name: targetName,
      safe: false,
      conflicts: [],
    };
  }

  const conflicts: RenameConflict[] = [];

  // 1. Check the symbol's own file for name collisions
  const sameFileSymbols = store.getSymbolsByFile(symbol.file_id);
  for (const s of sameFileSymbols) {
    if (s.id === symbol.id) continue;
    if (s.name.toLowerCase() === targetName.toLowerCase()) {
      const file = store.getFileById(symbol.file_id);
      conflicts.push({
        file: file?.path ?? `[file:${symbol.file_id}]`,
        existing_symbol_id: s.symbol_id,
        existing_name: s.name,
        kind: s.kind,
        line: s.line_start,
        reason: 'same_file',
      });
    }
  }

  // 2. Check all files that import this symbol's file
  const fileNodeId = store.getNodeId('file', symbol.file_id);
  if (fileNodeId !== undefined) {
    const incomingEdges = store.getIncomingEdges(fileNodeId);

    // Collect importing file IDs
    const importingFileIds = new Set<number>();
    for (const edge of incomingEdges) {
      const ref = store.getNodeRef(edge.source_node_id);
      if (!ref) continue;
      if (ref.nodeType === 'file') {
        importingFileIds.add(ref.refId);
      } else if (ref.nodeType === 'symbol') {
        // Get the file for this symbol
        const symRow = store.db
          .prepare('SELECT file_id FROM symbols WHERE id = ?')
          .get(ref.refId) as { file_id: number } | undefined;
        if (symRow) importingFileIds.add(symRow.file_id);
      }
    }

    // Check each importing file for name collisions
    for (const importingFileId of importingFileIds) {
      if (importingFileId === symbol.file_id) continue;
      const importFileSymbols = store.getSymbolsByFile(importingFileId);
      for (const s of importFileSymbols) {
        if (s.name.toLowerCase() === targetName.toLowerCase()) {
          const file = store.getFileById(importingFileId);
          conflicts.push({
            file: file?.path ?? `[file:${importingFileId}]`,
            existing_symbol_id: s.symbol_id,
            existing_name: s.name,
            kind: s.kind,
            line: s.line_start,
            reason: 'importing_file',
          });
        }
      }
    }
  }

  return {
    symbol_id: symbolId,
    current_name: symbol.name,
    target_name: targetName,
    safe: conflicts.length === 0,
    conflicts,
  };
}
