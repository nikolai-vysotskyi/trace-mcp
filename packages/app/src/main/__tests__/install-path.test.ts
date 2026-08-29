/**
 * `isPlausibleInstallPath` exists twice — here in Electron main and in
 * `scripts/locate-app.mjs`, because main is compiled with `rootDir: src/main`
 * and cannot import the repo-root script. This suite pins the behaviour and
 * asserts the two copies still agree, so a fix applied to one but not the
 * other fails CI instead of silently re-opening TRA-357.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPlausibleInstallPath } from '../install-path';

let mjs: { isPlausibleInstallPath: (p: string) => boolean };
let home: string;

beforeAll(async () => {
  // vitest runs this suite from packages/app; the shared helper lives at the
  // repo root. existsSync so a moved file fails here, not as a silent skip.
  const scriptPath = path.resolve(process.cwd(), '../../scripts/locate-app.mjs');
  expect(fs.existsSync(scriptPath)).toBe(true);
  mjs = (await import(pathToFileURL(scriptPath).href)) as typeof mjs;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-install-path-'));
  fs.mkdirSync(path.join(home, 'checkout', '.git'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('isPlausibleInstallPath', () => {
  it('accepts the conventional install locations', () => {
    for (const p of [
      '/Applications/trace-mcp.app',
      `${os.homedir()}/Applications/trace-mcp.app`,
      '/Applications/Utilities/trace-mcp.app',
    ]) {
      expect(isPlausibleInstallPath(p)).toBe(true);
    }
  });

  it('rejects an electron-builder output — the TRA-357 bundle', () => {
    expect(
      isPlausibleInstallPath(
        '/Users/x/workspaces/tra-257/workdir/trace-mcp/packages/app/release/mac-arm64/trace-mcp.app',
      ),
    ).toBe(false);
  });

  it('rejects build/dependency trees and relative paths', () => {
    for (const p of [
      '/Users/x/proj/dist/trace-mcp.app',
      '/Users/x/proj/build/trace-mcp.app',
      '/Users/x/proj/out/trace-mcp.app',
      '/Users/x/node_modules/trace-mcp/trace-mcp.app',
      'Applications/trace-mcp.app',
      '',
    ]) {
      expect(isPlausibleInstallPath(p)).toBe(false);
    }
  });

  it('rejects a bundle sitting inside a git checkout', () => {
    expect(isPlausibleInstallPath(path.join(home, 'checkout', 'app', 'trace-mcp.app'))).toBe(false);
  });

  it('agrees with the scripts/locate-app.mjs copy on every case', () => {
    const cases = [
      '/Applications/trace-mcp.app',
      '/Applications/Utilities/trace-mcp.app',
      '/Users/x/Applications/trace-mcp.app',
      '/Users/x/proj/packages/app/release/mac-arm64/trace-mcp.app',
      '/Users/x/proj/dist/trace-mcp.app',
      '/Users/x/node_modules/trace-mcp/trace-mcp.app',
      path.join(home, 'checkout', 'app', 'trace-mcp.app'),
      path.join(home, 'trace-mcp.app'),
      'relative/trace-mcp.app',
    ];
    for (const c of cases) {
      expect([c, mjs.isPlausibleInstallPath(c)]).toEqual([c, isPlausibleInstallPath(c)]);
    }
  });
});
