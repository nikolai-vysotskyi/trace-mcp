/**
 * Symbol <-> LSP position mapping.
 * Bridges trace-mcp's symbol model with LSP's URI+Position model.
 */

import { extname, posix as posixPath } from 'node:path';
import type { Store } from '../db/store.js';
import type { FileRow, SymbolRow } from '../db/types.js';
import { toPosixAbsolute } from '../utils/posix-path.js';
import { EXTENSION_TO_LANGUAGE } from './config.js';

export interface LspPosition {
  uri: string;
  line: number; // 0-based
  character: number; // 0-based
}

/**
 * Encode a POSIX-style absolute path (as produced by `toPosixAbsolute`) into
 * a `file://` URI. Deliberately NOT `node:url`'s `pathToFileURL` — that's
 * platform-gated on win32 and requires a drive-letter/UNC path, so it rejects
 * (or mis-encodes) the POSIX-normalized paths this module works with.
 */
function posixPathToFileUrl(absPath: string): string {
  const segments = absPath.split('/');
  const isDriveAbsolute = /^[a-zA-Z]:$/.test(segments[0]);
  const encoded = segments
    .map((seg, i) => (i === 0 && isDriveAbsolute ? seg : encodeURIComponent(seg)))
    .join('/');
  return isDriveAbsolute ? `file:///${encoded}` : `file://${encoded}`;
}

/**
 * Parse a `file://` URI into the POSIX-style absolute path format
 * `posixPathToFileUrl` produces (drive-letter paths keep the form `D:/...`,
 * no leading slash). Returns null for anything that isn't a well-formed
 * `file:` URI. Deliberately NOT `node:url`'s `fileURLToPath` — its win32
 * implementation throws on a URI with no drive letter, which breaks parsing
 * the POSIX-shaped URIs this module (and its tests) use for a normalized
 * rootPath.
 */
function fileUrlToPosixPath(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  let pathname = decodeURIComponent(url.pathname);
  // Windows drive-letter form is encoded as "/D:/Users/..." — strip the
  // leading slash so it matches posixPathToFileUrl's "D:/Users/..." input form.
  if (/^\/[a-zA-Z]:\//.test(pathname)) {
    pathname = pathname.slice(1);
  }
  return pathname;
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
  const absPath = posixPath.join(toPosixAbsolute(rootPath), file.path);
  return {
    uri: posixPathToFileUrl(absPath),
    line: (symbol.line_start ?? 1) - 1, // trace-mcp is 1-based, LSP is 0-based
    character: 0,
  };
}

/**
 * Convert an LSP URI to a relative file path.
 */
export function lspUriToRelPath(uri: string, rootPath: string): string | null {
  const absPath = fileUrlToPosixPath(uri);
  if (absPath === null) return null;
  // path.posix.relative is platform-independent (no OS gating, unlike
  // node:path's default export) and the symbol store keys file paths with
  // POSIX separators regardless of host OS.
  const rel = posixPath.relative(toPosixAbsolute(rootPath), absPath);
  // Reject paths outside rootPath
  if (rel.startsWith('..') || rel.startsWith('/')) return null;
  return rel;
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
