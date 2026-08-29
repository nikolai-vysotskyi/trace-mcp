import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureTmpDirSync, writeTmpFileSync } from '../safe-fs.js';

// TRA-337: `os.tmpdir()` is shared and our sentinel/marker names are predictable
// by design (hooks locate them by project hash), so a symlink planted under one
// of those names must not be followed (CodeQL js/insecure-temporary-file).

describe('safe-fs tmp helpers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tmp-safe-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeTmpFileSync', () => {
    it('writes a new file owner-only', () => {
      const p = path.join(tmpDir, 'sentinel');
      writeTmpFileSync(p, 'hello');
      expect(fs.readFileSync(p, 'utf-8')).toBe('hello');
      if (process.platform !== 'win32') {
        expect(fs.statSync(p).mode & 0o777).toBe(0o600);
      }
    });

    it('truncates an existing regular file', () => {
      const p = path.join(tmpDir, 'sentinel');
      fs.writeFileSync(p, 'a much longer previous value');
      writeTmpFileSync(p, 'x');
      expect(fs.readFileSync(p, 'utf-8')).toBe('x');
    });

    it.skipIf(process.platform === 'win32')(
      'refuses to write through a symlink and leaves the target intact',
      () => {
        const victim = path.join(tmpDir, 'victim');
        const link = path.join(tmpDir, 'sentinel');
        fs.writeFileSync(victim, 'precious');
        fs.symlinkSync(victim, link);

        expect(() => writeTmpFileSync(link, 'clobbered')).toThrow();
        expect(fs.readFileSync(victim, 'utf-8')).toBe('precious');
      },
    );
  });

  describe('ensureTmpDirSync', () => {
    it('creates the directory owner-only and reports it usable', () => {
      const dir = path.join(tmpDir, 'markers');
      expect(ensureTmpDirSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      }
    });

    it('is idempotent for a directory we already own', () => {
      const dir = path.join(tmpDir, 'markers');
      expect(ensureTmpDirSync(dir)).toBe(true);
      expect(ensureTmpDirSync(dir)).toBe(true);
    });

    it.skipIf(process.platform === 'win32')(
      'rejects a symlink squatting on the directory name',
      () => {
        const real = path.join(tmpDir, 'elsewhere');
        const link = path.join(tmpDir, 'markers');
        fs.mkdirSync(real);
        fs.symlinkSync(real, link);

        expect(ensureTmpDirSync(link)).toBe(false);
      },
    );

    it('rejects a name already taken by a regular file', () => {
      const p = path.join(tmpDir, 'markers');
      fs.writeFileSync(p, '');
      expect(ensureTmpDirSync(p)).toBe(false);
    });
  });
});
