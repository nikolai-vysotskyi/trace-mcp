import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(__dirname, '..', '..', 'scripts', 'verify-win-update.mjs');

const { readFeed, isNewer } = (await import(MODULE_PATH)) as {
  readFeed: (text: string) => { version: string; file: string; sha512: string };
  isNewer: (a: string, b: string) => boolean;
};

/** electron-builder's real output, as published on v3.11.0. */
const FEED = `version: 3.11.0
files:
  - url: trace-mcp.Setup.3.11.0.exe
    sha512: aaa==
    size: 118523392
path: trace-mcp.Setup.3.11.0.exe
sha512: bbb==
releaseDate: '2026-09-01T18:36:13.000Z'
`;

describe('verify-win-update', () => {
  it('reads the three fields electron-updater acts on', () => {
    expect(readFeed(FEED)).toEqual({
      version: '3.11.0',
      file: 'trace-mcp.Setup.3.11.0.exe',
      sha512: 'bbb==',
    });
  });

  // The indented `files:` entry carries its own sha512. Picking that one up
  // instead of the top-level field would compare the installer against a hash
  // of something else and fail every release for no reason.
  it('takes the top-level sha512, not the one nested under files', () => {
    expect(readFeed(FEED).sha512).not.toBe('aaa==');
  });

  it('rejects a feed missing a field rather than proceeding with undefined', () => {
    expect(() => readFeed('version: 3.11.0\n')).toThrow(/path/);
    expect(() => readFeed(FEED.replace(/^sha512: bbb==$/m, ''))).toThrow(/sha512/);
  });

  it('compares versions numerically, not as strings', () => {
    expect(isNewer('3.11.0', '3.9.0')).toBe(true); // '3.11.0' < '3.9.0' lexically
    expect(isNewer('3.9.0', '3.11.0')).toBe(false);
    expect(isNewer('3.11.0', '3.11.0')).toBe(false);
    expect(isNewer('3.11.1', '3.11.0')).toBe(true);
    expect(isNewer('4.0.0', '3.11.0')).toBe(true);
  });
});
