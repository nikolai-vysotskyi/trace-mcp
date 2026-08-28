import os from 'node:os';
import { describe, expect, test } from 'vitest';
import { isDangerousProjectRoot } from '../../src/project-setup.js';

/**
 * TRA-185: '/private/tmp' — the real directory /tmp symlinks to on macOS —
 * was registered as a persistent trace-mcp project because isDangerousProjectRoot
 * only rejected the literal string '/tmp', not its resolved form. Some MCP
 * clients hand trace-mcp an already-resolved cwd, bypassing that check.
 */
describe('isDangerousProjectRoot', () => {
  test('rejects /tmp', () => {
    expect(isDangerousProjectRoot('/tmp')).toBe('system directory');
  });

  test('rejects /private/tmp (resolved form of /tmp on macOS)', () => {
    expect(isDangerousProjectRoot('/private/tmp')).toBe('system directory');
  });

  test('does not reject a real project nested under /tmp', () => {
    expect(isDangerousProjectRoot('/tmp/some-checkout')).toBeNull();
  });

  test('does not reject a real project nested under /private/tmp', () => {
    expect(isDangerousProjectRoot('/private/tmp/some-checkout')).toBeNull();
  });

  test('rejects the OS temp dir', () => {
    expect(isDangerousProjectRoot(os.tmpdir())).toBe('system directory');
  });

  /**
   * TRA-236: SYSTEM_DIRS was POSIX-only, so a Windows client handing trace-mcp
   * a cwd of C:\Windows or C:\Users got no guard at all. The Windows rule keys
   * off the shape of the path, not process.platform, so these run everywhere.
   */
  describe('Windows system directories (TRA-236)', () => {
    for (const dir of [
      'C:\\Windows',
      'C:\\Windows\\System32',
      'C:\\Windows\\Temp',
      'C:\\Users',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
    ]) {
      test(`rejects ${dir}`, () => {
        expect(isDangerousProjectRoot(dir)).toBe('system directory');
      });
    }

    test('is case-insensitive', () => {
      expect(isDangerousProjectRoot('c:\\PROGRAM FILES')).toBe('system directory');
    });

    test('is drive-letter-agnostic', () => {
      expect(isDangerousProjectRoot('D:\\Windows')).toBe('system directory');
    });

    test('accepts forward slashes', () => {
      expect(isDangerousProjectRoot('C:/ProgramData')).toBe('system directory');
    });

    test('rejects a drive root', () => {
      expect(isDangerousProjectRoot('C:\\')).toBe('filesystem root');
    });

    test('does not reject a real project nested under a system dir', () => {
      expect(isDangerousProjectRoot('C:\\Users\\alice\\code\\app')).toBeNull();
      expect(isDangerousProjectRoot('C:\\Program Files\\MyApp\\src')).toBeNull();
    });

    test('does not reject an ordinary Windows path', () => {
      expect(isDangerousProjectRoot('C:\\code\\trace-mcp')).toBeNull();
    });
  });
});
