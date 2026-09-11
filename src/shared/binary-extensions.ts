/**
 * Centralised binary and non-code asset file extensions.
 * Used by refactoring tools (filtering candidate files) and
 * analytics rules (avoiding false outline/symbol recommendations on assets).
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.svg',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wav',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.o',
  '.a',
  '.wasm',
  '.pyc',
  '.class',
]);

import path from 'node:path';

export function isBinaryFile(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}
