import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rotateDaemonLogInPlace } from '../../src/daemon/lifecycle.js';

/**
 * daemon.log is the running daemon's stdout/stderr via an inherited O_APPEND fd
 * (detached spawn) or launchd's StandardOutPath. Rotation must NOT rename the
 * file — that would orphan the live fd. These tests pin the copytruncate
 * behavior that keeps the inode (and therefore the daemon's fd) alive.
 */
describe('rotateDaemonLogInPlace (copytruncate)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelog-'));
    logPath = path.join(dir, 'daemon.log');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('copies to .1 and truncates the live file when oversize', () => {
    const content = 'x'.repeat(1000);
    fs.writeFileSync(logPath, content);

    rotateDaemonLogInPlace(100, logPath); // cap 100 < 1000 bytes

    expect(fs.statSync(logPath).size).toBe(0); // live file truncated in place
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe(content); // backup keeps content
  });

  it('preserves the inode so an inherited append fd keeps writing', () => {
    fs.writeFileSync(logPath, 'y'.repeat(1000));
    const inodeBefore = fs.statSync(logPath).ino;
    // Simulate the daemon's inherited stdout: an append fd opened before rotation.
    const fd = fs.openSync(logPath, 'a');
    try {
      rotateDaemonLogInPlace(100, logPath);
      fs.writeSync(fd, 'after-rotate');
    } finally {
      fs.closeSync(fd);
    }

    expect(fs.statSync(logPath).ino).toBe(inodeBefore); // same inode — fd still valid
    expect(fs.readFileSync(logPath, 'utf8')).toBe('after-rotate'); // appended from offset 0
  });

  it('does nothing when under the size cap', () => {
    fs.writeFileSync(logPath, 'small');

    rotateDaemonLogInPlace(1024 * 1024, logPath);

    expect(fs.readFileSync(logPath, 'utf8')).toBe('small');
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });

  it('is a no-op (does not throw) when the log file is missing', () => {
    expect(() => rotateDaemonLogInPlace(100, path.join(dir, 'absent.log'))).not.toThrow();
  });
});
