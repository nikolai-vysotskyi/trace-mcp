import fs from 'node:fs';
import { resolveRegisteredAncestor } from '../registry.js';

/** The index that actually covers a service, including a multi-root parent. */
export function resolveExistingServiceIndexPath(repoRoot: string): string | null {
  const dbPath = resolveRegisteredAncestor(repoRoot)?.dbPath;
  return dbPath && fs.existsSync(dbPath) ? dbPath : null;
}
