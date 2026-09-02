import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(__dirname, '..', '..', 'scripts', 'verify-win-update.mjs');

const { readFeed, isNewer, auditUpdateLog } = (await import(MODULE_PATH)) as {
  readFeed: (text: string) => { version: string; file: string };
  isNewer: (a: string, b: string) => boolean;
  auditUpdateLog: (text: string) => { events: string[]; problems: string[] };
};

/** What the app writes when the electron-updater branch runs (index.ts). */
const GOOD_LOG = [
  '{"ts":"2026-09-02T16:00:00.000Z","event":"apply-update:downloaded","version":"3.13.0"}',
  '',
].join('\n');

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
  it('reads the version and installer name the app will be offered', () => {
    expect(readFeed(FEED)).toEqual({
      version: '3.11.0',
      file: 'trace-mcp.Setup.3.11.0.exe',
    });
  });

  // The indented `files:` entry repeats `url`/`sha512`. Anchoring at column 0
  // is what keeps the top-level `path` from being shadowed by them.
  it('rejects a feed missing a field rather than proceeding with undefined', () => {
    expect(() => readFeed('version: 3.11.0\n')).toThrow(/path/);
    expect(() => readFeed(FEED.replace(/^path: .*$/m, ''))).toThrow(/path/);
  });

  describe('auditUpdateLog', () => {
    it('accepts a log where only the electron-updater branch ran', () => {
      expect(auditUpdateLog(GOOD_LOG).problems).toEqual([]);
    });

    // The whole point of the acceptance criterion: the npm install branch must
    // never be reached on Windows. Any apply-update event outside the
    // electron-updater pair means the channel guard picked wrong — including
    // ones nobody thought to enumerate.
    it.each([
      'apply-update:no-npm',
      'apply-update:start',
      'apply-update:attempt-1',
      'apply-update:enotempty-recovery',
      'apply-update:some-future-npm-event',
    ])('rejects a log carrying %s', (event) => {
      const log = `${GOOD_LOG}{"ts":"x","event":"${event}"}\n`;
      expect(auditUpdateLog(log).problems.join()).toMatch(event);
    });

    // `resolve-npm:*` comes from check-for-update's stale-global-root report,
    // which runs on every platform and says nothing about the update channel.
    // TRA-368's text asked for its absence; a real passing run contains it.
    it('accepts resolve-npm events, which are not update-path events', () => {
      const log = `${GOOD_LOG}{"ts":"x","event":"resolve-npm:not-found","scanned":[]}\n`;
      expect(auditUpdateLog(log).problems).toEqual([]);
    });

    it('rejects a log where the download never completed', () => {
      const failed = '{"ts":"x","event":"apply-update:failed","summary":"boom"}\n';
      expect(auditUpdateLog(failed).problems.join()).toMatch(/apply-update:downloaded/);
    });

    it('survives a truncated trailing line rather than throwing', () => {
      expect(auditUpdateLog(`${GOOD_LOG}{"ts":"x","eve`).problems).toEqual([]);
    });
  });

  it('compares versions numerically, not as strings', () => {
    expect(isNewer('3.11.0', '3.9.0')).toBe(true); // '3.11.0' < '3.9.0' lexically
    expect(isNewer('3.9.0', '3.11.0')).toBe(false);
    expect(isNewer('3.11.0', '3.11.0')).toBe(false);
    expect(isNewer('3.11.1', '3.11.0')).toBe(true);
    expect(isNewer('4.0.0', '3.11.0')).toBe(true);
  });
});
