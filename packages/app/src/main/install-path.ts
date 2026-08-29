/**
 * "Is this `.app` an install, or something someone just built?"
 *
 * Mirror of `isPlausibleInstallPath` in `scripts/locate-app.mjs`. The two
 * copies exist because Electron main is compiled with `rootDir: src/main` and
 * cannot import a file from the repo-root `scripts/` directory;
 * `__tests__/install-path.test.ts` runs both over the same fixture table and
 * fails if they diverge.
 *
 * Why it exists: an `electron-builder` output at
 * `<checkout>/packages/app/release/mac-arm64/trace-mcp.app` is a fully
 * packaged bundle with the correct `CFBundleIdentifier`, so every validation
 * we had accepted it. Once such a path landed in `~/.trace-mcp/app-location.json`,
 * every later `npm install -g trace-mcp` staged its update next to a throwaway
 * build and the user's real install stayed frozen — silently, for months
 * (TRA-357).
 */

import fs from 'node:fs';
import path from 'node:path';

/** Keep in sync with `IMPLAUSIBLE_SEGMENTS` in `scripts/locate-app.mjs`. */
export const IMPLAUSIBLE_SEGMENTS = [
  'node_modules',
  'release',
  'dist',
  'out',
  'build',
  'target',
  'packages',
  'src',
  'workdir',
  'DerivedData',
  '.git',
];

export function isPlausibleInstallPath(appPath: string | null | undefined): boolean {
  if (!appPath || !path.isAbsolute(appPath)) return false;
  const parent = path.dirname(appPath);
  const denied = new Set(IMPLAUSIBLE_SEGMENTS);
  for (const segment of parent.split(path.sep)) {
    if (denied.has(segment)) return false;
  }
  let dir = parent;
  for (let i = 0; i < 6 && dir && dir !== path.dirname(dir); i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return false;
    } catch {
      /* unreadable ancestor — treat as plausible, validation continues */
    }
    dir = path.dirname(dir);
  }
  return true;
}
