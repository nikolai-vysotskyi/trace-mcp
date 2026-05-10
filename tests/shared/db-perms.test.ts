import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restrictDbPerms } from '../../src/shared/db-perms.js';

describe('restrictDbPerms', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perms-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('chmods the main DB file to 0600 on POSIX', () => {
    if (process.platform === 'win32') return;
    const dbPath = path.join(tmpDir, 'test.db');
    fs.writeFileSync(dbPath, 'fake content', { mode: 0o644 });
    restrictDbPerms(dbPath);
    const mode = fs.statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('chmods sidecars (-wal, -shm, -journal) when present', () => {
    if (process.platform === 'win32') return;
    const dbPath = path.join(tmpDir, 'test.db');
    fs.writeFileSync(dbPath, 'main', { mode: 0o644 });
    fs.writeFileSync(`${dbPath}-wal`, 'wal', { mode: 0o644 });
    fs.writeFileSync(`${dbPath}-shm`, 'shm', { mode: 0o644 });
    restrictDbPerms(dbPath);
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
  });

  it('does not throw when sidecars are missing', () => {
    if (process.platform === 'win32') return;
    const dbPath = path.join(tmpDir, 'lonely.db');
    fs.writeFileSync(dbPath, 'main', { mode: 0o644 });
    expect(() => restrictDbPerms(dbPath)).not.toThrow();
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it('is a no-op on Windows', () => {
    if (process.platform !== 'win32') return;
    const dbPath = path.join(tmpDir, 'win.db');
    fs.writeFileSync(dbPath, 'x');
    expect(() => restrictDbPerms(dbPath)).not.toThrow();
  });

  it('does not throw when the DB file does not exist', () => {
    expect(() => restrictDbPerms(path.join(tmpDir, 'nope.db'))).not.toThrow();
  });
});
