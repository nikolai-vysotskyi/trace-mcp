import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkVersionDrift,
  computeVersionDrift,
  readStampedVersion,
  versionDriftMessage,
  writeStampedVersion,
} from '../../src/init/version-stamp.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('writeStampedVersion / readStampedVersion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('version-stamp-');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('writes then reads back the same version', () => {
    const stamp = path.join(tmpDir, 'last_init_version.txt');
    expect(writeStampedVersion('1.42.0', stamp)).toBe(true);
    expect(readStampedVersion(stamp)).toBe('1.42.0');
  });

  it('creates the parent directory if it does not exist', () => {
    const stamp = path.join(tmpDir, 'nested', 'sub', 'last_init_version.txt');
    expect(writeStampedVersion('2.0.0', stamp)).toBe(true);
    expect(fs.existsSync(stamp)).toBe(true);
    expect(readStampedVersion(stamp)).toBe('2.0.0');
  });

  it('overwrites existing stamp on subsequent writes', () => {
    const stamp = path.join(tmpDir, 'last_init_version.txt');
    writeStampedVersion('1.0.0', stamp);
    writeStampedVersion('2.0.0', stamp);
    expect(readStampedVersion(stamp)).toBe('2.0.0');
  });

  it('strips surrounding whitespace before storing', () => {
    const stamp = path.join(tmpDir, 'last_init_version.txt');
    writeStampedVersion('  3.1.4-beta  \n', stamp);
    expect(readStampedVersion(stamp)).toBe('3.1.4-beta');
  });

  it('returns null when reading a missing file', () => {
    expect(readStampedVersion(path.join(tmpDir, 'does-not-exist.txt'))).toBeNull();
  });

  it('returns null when the stamp file is empty', () => {
    const stamp = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(stamp, '');
    expect(readStampedVersion(stamp)).toBeNull();
  });

  it('returns false when version is empty/invalid (write does nothing)', () => {
    const stamp = path.join(tmpDir, 'last_init_version.txt');
    expect(writeStampedVersion('', stamp)).toBe(false);
    expect(fs.existsSync(stamp)).toBe(false);
  });

  it("writes a trailing newline so editors don't corrupt the file", () => {
    const stamp = path.join(tmpDir, 'last_init_version.txt');
    writeStampedVersion('1.2.3', stamp);
    const raw = fs.readFileSync(stamp, 'utf-8');
    expect(raw).toBe('1.2.3\n');
  });
});

describe('computeVersionDrift', () => {
  it('reports no drift when stamp is null', () => {
    const r = computeVersionDrift('1.0.0', null);
    expect(r.drift).toBe(false);
    expect(r.stamped).toBeNull();
    expect(r.installed).toBe('1.0.0');
  });

  it('reports no drift when stamp matches installed', () => {
    const r = computeVersionDrift('1.0.0', '1.0.0');
    expect(r.drift).toBe(false);
  });

  it('reports drift when stamp diverges from installed', () => {
    const r = computeVersionDrift('2.0.0', '1.0.0');
    expect(r.drift).toBe(true);
    expect(r.stamped).toBe('1.0.0');
    expect(r.installed).toBe('2.0.0');
  });

  it('treats stamp differing only in pre-release suffix as drift', () => {
    expect(computeVersionDrift('1.0.0', '1.0.0-rc.1').drift).toBe(true);
  });
});

describe('versionDriftMessage', () => {
  it('returns empty string when no drift', () => {
    expect(versionDriftMessage({ drift: false, installed: '1.0.0', stamped: null })).toBe('');
  });

  it('mentions both versions and points at `trace-mcp init` as the remedy', () => {
    const msg = versionDriftMessage({ drift: true, installed: '2.0.0', stamped: '1.0.0' });
    expect(msg).toContain('1.0.0');
    expect(msg).toContain('2.0.0');
    expect(msg).toContain('trace-mcp init');
    expect(msg.startsWith('[trace-mcp]')).toBe(true);
  });
});

describe('checkVersionDrift (integration)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = createTmpDir('check-drift-');
  });
  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('returns no-drift when stamp file does not yet exist', () => {
    const stamp = path.join(tmpDir, 'last_init_version.txt');
    expect(checkVersionDrift('1.0.0', stamp).drift).toBe(false);
  });

  it('round-trips: write 1.0.0, check at 2.0.0 → drift', () => {
    const stamp = path.join(tmpDir, 'last_init_version.txt');
    writeStampedVersion('1.0.0', stamp);
    const r = checkVersionDrift('2.0.0', stamp);
    expect(r.drift).toBe(true);
    expect(r.stamped).toBe('1.0.0');
    expect(r.installed).toBe('2.0.0');
  });
});
