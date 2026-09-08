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

  // Reject trace-mcp state directory itself or any subpath within it (~/.trace, ~/.trace-mcp).
  // Indexing internal state creates recursive watcher churn and corruption risk.
  if (isTraceStateDirectory(absRoot)) return 'trace state directory';

  // Windows system directories. Matched on the path *below* the drive root so
  // the rule is drive-letter-agnostic (a user may be on D:), case-insensitive,
  // and separator-agnostic. Keyed off the shape of the string rather than
  // process.platform: 'C:\Windows' is never a legitimate POSIX path either, and
  // a platform gate would make these untestable off Windows.
  const driveRelative = /^[a-zA-Z]:[\\/](.*)$/.exec(absRoot);
  if (driveRelative) {
    // Split rather than trim with a quantified regex: '\\+$' backtracks
    // quadratically on a path of many backslashes (js/polynomial-redos), and
    // splitting also collapses duplicate separators for free.
    const tail = driveRelative[1].split(/[\\/]/).filter(Boolean).join('\\').toLowerCase();
    if (tail === '') return 'filesystem root';
    if (WINDOWS_SYSTEM_DIRS.has(tail)) return 'system directory';
    if (/^users\\[^\\]+\\.trace(-mcp)?(\\|$)/i.test(tail)) {
      return 'trace state directory';
    }
  }

  return null;
}

const TRACE_STATE_SUBDIRS = new Set([
  'index',
  'sessions',
  'corpora',
  'bundles',
  'locks',
  'status',
  'startup-backups',
  'perf-fixture',
  'telemetry',
  'decisions',
  'logs',
  'metrics',
  'bin',
  'mirror',
]);

function isTraceStateDirectory(absRoot: string): boolean {
  const homedir = os.homedir();
  if (homedir) {
    // ~/.trace and ~/.trace-mcp: the directory itself AND any subpath within it
    for (const d of [path.join(homedir, '.trace'), path.join(homedir, '.trace-mcp')]) {
      if (isInsideOrEqual(absRoot, d)) return true;
    }
  }

  // TRACE_MCP_DATA_DIR override: reject the data directory itself and known
  // state subdirectories (e.g. <dataDir>/index), while allowing unrelated test
  // fixtures created alongside it in throwaway temp folders.
  const override =
    process.env.TRACE_MCP_DATA_DIR || process.env.TRACE_MCP_HOME || process.env.TRACE_HOME;
  if (override && override.length > 0) {
    const expanded = override.startsWith('~')
      ? path.join(homedir || '', override.slice(1))
      : override;
    const normOverride = path.resolve(expanded);
    if (isSamePath(absRoot, normOverride)) return true;
    for (const sub of TRACE_STATE_SUBDIRS) {
      if (isInsideOrEqual(absRoot, path.join(normOverride, sub))) return true;
    }
  }

  return false;
}

function isSamePath(a: string, b: string): boolean {
  const normA = path.resolve(a);
  const normB = path.resolve(b);
  const check = (x: string, y: string) =>
    process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;

  if (check(normA, normB)) return true;
  const unprivA = normA.startsWith('/private/') ? normA.slice('/private'.length) : null;
  const unprivB = normB.startsWith('/private/') ? normB.slice('/private'.length) : null;
  if (unprivA && check(unprivA, normB)) return true;
  if (unprivB && check(normA, unprivB)) return true;
  if (unprivA && unprivB && check(unprivA, unprivB)) return true;
  return false;
}

function isInsideOrEqual(candidate: string, targetDir: string): boolean {
  const normCandidate = path.resolve(candidate);
  const normTarget = path.resolve(targetDir);

  const check = (c: string, t: string): boolean => {
    if (process.platform === 'win32') {
      const lc = c.toLowerCase();
      const lt = t.toLowerCase();
      return lc === lt || lc.startsWith(lt.endsWith(path.sep) ? lt : lt + path.sep);
    }
    return c === t || c.startsWith(t.endsWith(path.sep) ? t : t + path.sep);
  };

  if (check(normCandidate, normTarget)) return true;

  // macOS /var and /tmp symlink handling (/private prefix)
  const unprivCandidate = normCandidate.startsWith('/private/')
    ? normCandidate.slice('/private'.length)
    : null;
  const unprivTarget = normTarget.startsWith('/private/')
    ? normTarget.slice('/private'.length)
    : null;

  if (unprivCandidate && check(unprivCandidate, normTarget)) return true;
  if (unprivTarget && check(normCandidate, unprivTarget)) return true;
  if (unprivCandidate && unprivTarget && check(unprivCandidate, unprivTarget)) return true;

  return false;
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
