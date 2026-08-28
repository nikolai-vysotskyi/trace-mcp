import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readIfExists, writeIfChanged } from '../safe-fs.js';

// TRA-256: replaces the `fs.existsSync(p)` then `fs.readFileSync(p)` /
// `fs.writeFileSync(p)` TOCTOU pattern CodeQL flagged (js/file-system-race)
// across ~27 call sites. These two helpers do a single safe read instead.

describe('safe-fs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-safe-fs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readIfExists', () => {
    it('returns null when the file does not exist', () => {
      expect(readIfExists(path.join(tmpDir, 'missing.txt'))).toBeNull();
    });

    it('returns the file content as utf-8 when it exists', () => {
      const p = path.join(tmpDir, 'present.txt');
      fs.writeFileSync(p, 'hello world', 'utf-8');
      expect(readIfExists(p)).toBe('hello world');
    });

    it('returns null for a missing nested directory, not just a missing file', () => {
      expect(readIfExists(path.join(tmpDir, 'no-such-dir', 'file.txt'))).toBeNull();
    });

    it('rethrows non-ENOENT errors (e.g. reading a directory as a file)', () => {
      const dirPath = path.join(tmpDir, 'a-directory');
      fs.mkdirSync(dirPath);
      expect(() => readIfExists(dirPath)).toThrow();
    });
  });

  describe('writeIfChanged', () => {
    it('writes and returns true when the file does not exist yet', () => {
      const p = path.join(tmpDir, 'new-file.txt');
      const wrote = writeIfChanged(p, 'content');
      expect(wrote).toBe(true);
      expect(fs.readFileSync(p, 'utf-8')).toBe('content');
    });

    it('writes and returns true when content differs from what is on disk', () => {
      const p = path.join(tmpDir, 'existing.txt');
      fs.writeFileSync(p, 'old content', 'utf-8');
      const wrote = writeIfChanged(p, 'new content');
      expect(wrote).toBe(true);
      expect(fs.readFileSync(p, 'utf-8')).toBe('new content');
    });

    it('does not write and returns false when content is unchanged', () => {
      const p = path.join(tmpDir, 'unchanged.txt');
      fs.writeFileSync(p, 'same content', 'utf-8');
      const mtimeBefore = fs.statSync(p).mtimeMs;
      const wrote = writeIfChanged(p, 'same content');
      expect(wrote).toBe(false);
      expect(fs.statSync(p).mtimeMs).toBe(mtimeBefore);
    });
  });
});
