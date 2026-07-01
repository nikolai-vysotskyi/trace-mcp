/**
 * Regression tests for 3x CWE-78 (command injection) in install-app.ts.
 *
 * All sites built shell command strings via template interpolation and ran
 * them through `execSync` (which spawns `/bin/sh -c "..."` or `cmd.exe /c
 * "..."` under the hood):
 *
 *  1. `pinToDock()` — `defaults write ... -array-add '${entry}'`, where
 *     `entry` embeds `appPath` inside a single-quoted shell string.
 *  2. `unzipMac()` (extracted from installGuiApp's macOS branch) —
 *     `unzip -q -o "${archivePath}" -d "${INSTALL_DIR}"`, where `archivePath`
 *     is built from `asset.name`, a value read from the GitHub Releases API
 *     response (attacker-influenced if the release feed or the
 *     `TRACE_MCP_APP_DIST_REPO` override is ever compromised).
 *  3. `expandArchiveWindows()` / `runNsisInstaller()` (extracted from
 *     installGuiApp's Windows branch) — PowerShell `Expand-Archive` and the
 *     NSIS installer invocation, same archivePath provenance — plus
 *     `createStartMenuShortcut()`'s PowerShell `New-Object -ComObject
 *     WScript.Shell` script.
 *
 * The fix switches every one of these to `execFileSync(cmd, [...argv])` — no
 * shell is spawned, so values containing shell metacharacters (quotes,
 * semicolons, backticks, `$(...)`) can never break out of their argv slot.
 * `unzipMac`, `runNsisInstaller`, `expandArchiveWindows`, `pinToDock`, and
 * `createStartMenuShortcut` are exported specifically so this can be
 * asserted directly, without mocking the network/download layer.
 */
import { execFileSync, execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStartMenuShortcut,
  expandArchiveWindows,
  pinToDock,
  runNsisInstaller,
  unzipMac,
} from '../../src/cli/install-app.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);

describe('install-app.ts — command injection hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue(Buffer.from(''));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('pinToDock', () => {
    it('never calls execSync (no shell string interpolation for the plist entry)', () => {
      // A path containing a single quote — would have broken out of the
      // `-array-add '${entry}'` shell string under the old execSync call.
      pinToDock(`/Users/x/Applications/it's-here.app`);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('passes the plist entry as a discrete execFileSync argv element', () => {
      const maliciousPath = `/tmp/x'; touch /tmp/pwned; echo '`;
      pinToDock(maliciousPath);

      const writeCall = mockExecFileSync.mock.calls.find(
        (c) => c[0] === 'defaults' && (c[1] as string[])?.includes('write'),
      );
      expect(writeCall).toBeDefined();
      const [, args] = writeCall as [string, string[]];
      // The plist XML (embedding maliciousPath) must arrive as ONE argv
      // element, never concatenated into a shell command string.
      expect(args.some((a) => a.includes(maliciousPath))).toBe(true);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('reads dock state via execFileSync, not a shell string', () => {
      pinToDock('/Applications/trace-mcp.app');
      const readCall = mockExecFileSync.mock.calls.find(
        (c) => c[0] === 'defaults' && (c[1] as string[])?.[0] === 'read',
      );
      expect(readCall).toBeDefined();
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe('unzipMac', () => {
    it('never calls execSync (archivePath from release asset name)', () => {
      const maliciousArchivePath = '/tmp/trace-mcp-1.0.0"; touch /tmp/pwned; echo "-mac.zip';
      unzipMac(maliciousArchivePath, '/Users/x/Applications');
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('passes archivePath and destDir as discrete execFileSync argv elements', () => {
      const maliciousArchivePath = '/tmp/x"; rm -rf /; echo "-mac.zip';
      unzipMac(maliciousArchivePath, '/Users/x/Applications');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'unzip',
        ['-q', '-o', maliciousArchivePath, '-d', '/Users/x/Applications'],
        expect.any(Object),
      );
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe('runNsisInstaller', () => {
    it('never calls execSync and passes archivePath as the discrete argv0', () => {
      const maliciousArchivePath = 'C:\\x & del /f /q C:\\Windows & echo ';
      runNsisInstaller(maliciousArchivePath, 'C:\\Program Files\\trace-mcp');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        maliciousArchivePath,
        ['/S', '/D=C:\\Program Files\\trace-mcp'],
        expect.any(Object),
      );
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe('expandArchiveWindows', () => {
    it('never calls execSync for the PowerShell Expand-Archive invocation', () => {
      const maliciousArchivePath = "C:\\x'; Remove-Item -Recurse C:\\; '";
      expandArchiveWindows(maliciousArchivePath, 'C:\\Program Files\\trace-mcp');
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('passes archivePath/destDir as discrete execFileSync argv elements to powershell', () => {
      const maliciousArchivePath = "C:\\x'; Remove-Item -Recurse C:\\; '";
      expandArchiveWindows(maliciousArchivePath, 'C:\\Program Files\\trace-mcp');

      const psCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'powershell');
      expect(psCall).toBeDefined();
      const [, args] = psCall as [string, string[]];
      expect(args).toContain(maliciousArchivePath);
      expect(args).toContain('C:\\Program Files\\trace-mcp');
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe('createStartMenuShortcut', () => {
    it('never calls execSync for the PowerShell shortcut script', () => {
      createStartMenuShortcut(`C:\\Program Files\\it's\\trace-mcp.exe`);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('invokes powershell via execFileSync with the script as a discrete argv element', () => {
      createStartMenuShortcut(`C:\\evil"; Remove-Item -Recurse C:\\; "`);

      const psCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'powershell');
      expect(psCall).toBeDefined();
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });
});
