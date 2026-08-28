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

  // Top-level system/user-container directories (POSIX + macOS)
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

  return null;
}
