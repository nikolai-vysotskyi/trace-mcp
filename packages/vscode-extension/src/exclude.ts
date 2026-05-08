/**
 * Glob-based exclude check. Pulled out so unit tests don't have to import
 * vscode types just to verify the matching semantics. Uses picomatch
 * (already in the workspace via fast-glob) — no new runtime dep.
 */

// @ts-expect-error — picomatch ships no bundled types
import picomatch from 'picomatch';

export function shouldExclude(relativePath: string, globs: readonly string[]): boolean {
  // Normalize to forward slashes — picomatch is forward-slash native and
  // VS Code surfaces paths with native sep on Windows for `Uri.fsPath`.
  const norm = relativePath.replace(/\\/g, '/');
  for (const pattern of globs) {
    if (!pattern || typeof pattern !== 'string') continue;
    try {
      const isMatch = picomatch(pattern, { dot: true });
      if (isMatch(norm)) return true;
    } catch {
      // Invalid pattern in user config — skip rather than break the save handler.
      continue;
    }
  }
  return false;
}
