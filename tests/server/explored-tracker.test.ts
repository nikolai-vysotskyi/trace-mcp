import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createExploredTracker } from '../../src/server/explored-tracker.js';

const TEST_ROOT = path.join(os.tmpdir(), 'trace-mcp-test-explored-' + process.pid);

function getMarkerDir(): string {
  const hash = crypto.createHash('sha256').update(TEST_ROOT).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `trace-mcp-explored-${hash}`);
}

afterEach(() => {
  const dir = getMarkerDir();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* may not exist */
  }
});

describe('createExploredTracker', () => {
  it('creates marker directory on construction', () => {
    createExploredTracker(TEST_ROOT);
    expect(fs.existsSync(getMarkerDir())).toBe(true);
  });

  it('returns an object with markExplored method', () => {
    const tracker = createExploredTracker(TEST_ROOT);
    expect(typeof tracker.markExplored).toBe('function');
  });

  describe('markExplored', () => {
    it('writes a marker file for relative paths', () => {
      const tracker = createExploredTracker(TEST_ROOT);
      tracker.markExplored('src/server.ts');

      const absPath = path.resolve(TEST_ROOT, 'src/server.ts');
      const fileHash = crypto.createHash('sha256').update(absPath).digest('hex');
      const markerPath = path.join(getMarkerDir(), fileHash);

      expect(fs.existsSync(markerPath)).toBe(true);
      expect(fs.readFileSync(markerPath, 'utf-8')).toBe(absPath);
    });

    it('writes a marker file for absolute paths', () => {
      const tracker = createExploredTracker(TEST_ROOT);
      const absPath = '/absolute/path/to/file.ts';
      tracker.markExplored(absPath);

      const fileHash = crypto.createHash('sha256').update(absPath).digest('hex');
      const markerPath = path.join(getMarkerDir(), fileHash);

      expect(fs.existsSync(markerPath)).toBe(true);
      expect(fs.readFileSync(markerPath, 'utf-8')).toBe(absPath);
    });

    it('creates unique markers for different files', () => {
      const tracker = createExploredTracker(TEST_ROOT);
      tracker.markExplored('src/a.ts');
      tracker.markExplored('src/b.ts');

      const files = fs.readdirSync(getMarkerDir());
      expect(files.length).toBe(2);
    });

    it('overwrites marker on repeated calls for same file', () => {
      const tracker = createExploredTracker(TEST_ROOT);
      tracker.markExplored('src/a.ts');
      tracker.markExplored('src/a.ts');

      const files = fs.readdirSync(getMarkerDir());
      expect(files.length).toBe(1);
    });

    it('uses deterministic hashes', () => {
      const tracker1 = createExploredTracker(TEST_ROOT);
      tracker1.markExplored('src/file.ts');

      const files1 = fs.readdirSync(getMarkerDir());

      // Clean and recreate
      fs.rmSync(getMarkerDir(), { recursive: true, force: true });

      const tracker2 = createExploredTracker(TEST_ROOT);
      tracker2.markExplored('src/file.ts');

      const files2 = fs.readdirSync(getMarkerDir());

      expect(files1).toEqual(files2);
    });
  });
});
