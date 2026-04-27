/**
 * Symbol <-> LSP position mapping.
 * Bridges trace-mcp's symbol model with LSP's URI+Position model.
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import { relative, resolve, extname } from 'node:path';
import type { Store } from '../db/store.js';
import type { SymbolRow, FileRow } from '../db/types.js';
import { EXTENSION_TO_LANGUAGE } from './config.js';

export interface LspPosition {
  uri: string;
  line: number; // 0-based
  character: number; // 0-based
}

/**
 * Convert a trace-mcp symbol + file to an LSP position.
 * Uses the start of the symbol's definition line.
 */
export function symbolToLspPosition(
  symbol: SymbolRow,
  file: FileRow,
  rootPath: string,
): LspPosition {
  const absPath = resolve(rootPath, file.path);
  return {
    uri: pathToFileURL(absPath).href,
    line: (symbol.line_start ?? 1) - 1, // trace-mcp is 1-based, LSP is 0-based
    character: 0,
  };
}

/**
 * Convert an LSP URI to a relative file path.
 */
export function lspUriToRelPath(uri: string, rootPath: string): string | null {
  try {
    const absPath = fileURLToPath(uri);
    const rel = relative(rootPath, absPath);
    // Reject paths outside rootPath
    if (rel.startsWith('..') || rel.startsWith('/')) return null;
    return rel;
  } catch {
    return null;
  }
}

/**
 * Find the trace-mcp symbol that best matches an LSP position.
 * Prefers the narrowest (most specific) symbol containing the position.
 */
export function findSymbolAtPosition(
  store: Store,
  rootPath: string,
  uri: string,
  line: number, // 0-based LSP line
): { symbol: SymbolRow; file: FileRow } | null {
  const relPath = lspUriToRelPath(uri, rootPath);
  if (!relPath) return null;

  const file = store.getFile(relPath);
  if (!file) return null;

  const symbols = store.getSymbolsByFile(file.id);
  if (symbols.length === 0) return null;

  const traceLine = line + 1; // Convert to 1-based

  // Find symbols whose line range contains the position
  let bestMatch: SymbolRow | null = null;
  let bestSpan = Infinity;

  for (const sym of symbols) {
    const start = sym.line_start ?? 0;
    const end = sym.line_end ?? start;
    if (traceLine >= start && traceLine <= end) {
      const span = end - start;
      if (span < bestSpan) {
        bestSpan = span;
        bestMatch = sym;
      }
    }
  }

  if (!bestMatch) return null;
  return { symbol: bestMatch, file };
}

/**
 * Get the LSP language ID for a file path.
 */
export function getLanguageId(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}
