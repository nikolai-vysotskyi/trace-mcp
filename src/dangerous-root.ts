/**
 * Shared "is this root obviously wrong" guard.
 *
 * Lives in its own dependency-free module (node:os + node:path only) so both
 * the project registration pipeline (`project-setup.ts`) and the topology
 * subproject store (`topology/topology-subprojects.ts`) can use the SAME rule
 * without the store pulling in the whole detector/config stack.
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Reject obviously-wrong project roots: filesystem root, user home, top-level
 * system directories. An MCP client spawned with cwd=/ would otherwise cause
 * trace-mcp to index the entire filesystem and crash on SIP-protected paths
 * like /Library/Bluetooth.
 *
 * Returns null if the path is acceptable, or a human-readable reason if it
 * should be rejected.
 */
export function isDangerousProjectRoot(absRoot: string): string | null {
  const parsed = path.parse(absRoot);

  // Filesystem root: "/" on POSIX, "C:\" on Windows
  if (absRoot === parsed.root) return 'filesystem root';

  // User home directory
  if (absRoot === os.homedir()) return 'home directory';

  // The OS scratch dir itself (%TEMP% / %LOCALAPPDATA%\Temp on Windows,
  // /var/folders/... on macOS). Covers the per-user temp roots we cannot
  // enumerate as literals. Subdirectories under it stay allowed.
  if (absRoot === os.tmpdir()) return 'system directory';

  // Top-level system/user-container directories (POSIX + macOS).
  // Deliberately checked on every platform, not just POSIX: these strings can
  // never be a real Windows path, so matching them there costs nothing, and a
  // platform gate would only make the rule harder to test. The reverse is NOT
  // true — '/tmp' is meaningless on Windows, so the Windows dirs below are a
  // separate set rather than additions to this one.
  const SYSTEM_DIRS = new Set([
    '/Users',
    '/home',
    '/root',
    '/System',
    '/Library',
    '/private',
    '/tmp',
    // macOS resolves the /tmp symlink to /private/tmp; some MCP clients hand
    // trace-mcp the already-resolved cwd, which bypassed the '/tmp' check above.
    '/private/tmp',
    '/var',
    '/etc',
    '/bin',
    '/sbin',
    '/usr',
    '/opt',
    '/dev',
    '/Volumes',
    '/Applications',
    '/Network',
    '/cores',
    '/proc',
    '/sys',
  ]);
  if (SYSTEM_DIRS.has(absRoot)) return 'system directory';

  // Windows system directories. Matched on the path *below* the drive root so
  // the rule is drive-letter-agnostic (a user may be on D:), case-insensitive,
  // and separator-agnostic. Keyed off the shape of the string rather than
  // process.platform: 'C:\Windows' is never a legitimate POSIX path either, and
  // a platform gate would make these untestable off Windows.
  const driveRelative = /^[a-zA-Z]:[\\/](.*)$/.exec(absRoot);
  if (driveRelative) {
    const tail = driveRelative[1].replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    if (tail === '') return 'filesystem root';
    if (WINDOWS_SYSTEM_DIRS.has(tail)) return 'system directory';
  }

  return null;
}

const WINDOWS_SYSTEM_DIRS = new Set([
  'windows',
  'windows\\system32',
  'windows\\temp',
  'users',
  'program files',
  'program files (x86)',
  'programdata',
]);
