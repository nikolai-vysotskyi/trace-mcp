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

  // Reject test fixture paths on a live daemon (TRA-2946).
  // Ad-hoc QA and test scripts targeting temporary fixture paths like /tmp/trace-mcp-tra2941-isolated
  // must never be indexed by a live daemon. Doing so starts file watchers on temporary trees,
  // causing event-loop stalls, memory pressure, and thousands of ENOENT errors when the temporary
  // fixture is unlinked. Test fixtures are only permitted when running in an isolated test daemon
  // (TRACE_MCP_MANAGED_BY === 'test') or under an active test runner.
  if (!isTestContext() && isTestFixturePath(absRoot)) {
    return 'test fixture path on live daemon';
  }

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
  const candidateHomes = new Set<string>();
  const homedir = os.homedir();
  if (homedir) candidateHomes.add(homedir);
  try {
    const userHomedir = os.userInfo?.()?.homedir;
    if (userHomedir) candidateHomes.add(userHomedir);
  } catch {
    /* ignore if userInfo unavailable */
  }

  // ~/.trace and ~/.trace-mcp across candidate homes: the directory itself AND any subpath within it
  for (const home of candidateHomes) {
    for (const d of [path.join(home, '.trace'), path.join(home, '.trace-mcp')]) {
      if (isInsideOrEqual(absRoot, d)) return true;
    }
  }

  // POSIX user container matching (/Users/<user>/.trace, /home/<user>/.trace, /root/.trace),
  // mirroring the Windows check in isDangerousProjectRoot. Needed when running with an isolated HOME
  // (e.g. HOME=/Users/name/.agy/5 in test/agent runners) where os.homedir() does not match
  // the real user home containing the state directory.
  if (/^\/(Users|home|root)\/[^/]+\/\.trace(-mcp)?(\/|$)/i.test(absRoot)) {
    return true;
  }

  // Reject any path that contains .trace or .trace-mcp as a path component
  const normalized = path.resolve(absRoot);
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  if (segments.includes('.trace') || segments.includes('.trace-mcp')) {
    return true;
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

/**
 * Check if a path is located inside an OS or environment temporary directory.
 * Boundary-checked so that permanent repositories outside temporary storage
 * are never classified as temporary fixtures (TRA-2946).
 */
export function isUnderTempDirectory(absPath: string): boolean {
  const norm = path.resolve(absPath);
  const tempCandidates = new Set<string>();

  tempCandidates.add('/tmp');
  tempCandidates.add('/private/tmp');
  tempCandidates.add('/var/tmp');
  tempCandidates.add('/private/var/tmp');

  const osTmp = os.tmpdir();
  if (osTmp) {
    tempCandidates.add(path.resolve(osTmp));
  }

  for (const envVar of [process.env.TMPDIR, process.env.TEMP, process.env.TMP]) {
    if (envVar && envVar.length > 0) {
      tempCandidates.add(path.resolve(envVar));
    }
  }

  for (const candidate of tempCandidates) {
    if (isInsideOrEqual(norm, candidate)) {
      return true;
    }
  }

  // macOS /var/folders per-user temp directories check (cross-platform compatible)
  if (/^(?:[a-zA-Z]:)?[\\/](?:private[\\/])?var[\\/]folders[\\/]/i.test(norm)) {
    return true;
  }

  // Windows temp directories check (e.g. C:\Windows\Temp or \AppData\Local\Temp)
  if (process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(norm)) {
    if (/[\\/]temp(\\|$)/i.test(norm) || /[\\/]AppData[\\/]Local[\\/]Temp(\\|$)/i.test(norm)) {
      return true;
    }
  }

  return false;
}

/**
 * Detect test fixture paths commonly generated during automated and manual QA.
 * These directories must never be indexed by a live daemon (TRA-2946).
 * Restricted to paths physically located in temporary storage.
 */
export function isTestFixturePath(absRoot: string): boolean {
  const norm = path.resolve(absRoot);

  // Must be located in a genuine temporary directory.
  // Permanent user workspaces (e.g. /Users/alice/trace-test-app) are NEVER rejected.
  if (!isUnderTempDirectory(norm)) {
    return false;
  }

  const base = path.basename(norm);

  // Match fixture naming conventions commonly used in trace-mcp tests & QA
  if (/^trace-mcp-tra\d+/i.test(base)) return true;
  if (/^trace-(?:mcp-)?test-/i.test(base)) return true;
  if (/^trace-(?:packaged|restart)-/i.test(base)) return true;
  if (/^tmcp-packaged-/i.test(base)) return true;
  if (/^truncation-boundary-/i.test(base)) return true;
  if (base.endsWith('-isolated') && base.includes('trace')) return true;

  if (/(?:^|[\\/])trace-mcp-[a-z0-9_-]+(?:isolated|fixture|test)/i.test(norm)) return true;

  return false;
}

/**
 * Returns true if the current process is running in a designated test/QA context
 * where indexing local test fixtures is expected and isolated.
 */
export function isTestContext(): boolean {
  return (
    process.env.TRACE_MCP_MANAGED_BY === 'test' ||
    Boolean(process.env.VITEST) ||
    process.env.NODE_ENV === 'test' ||
    process.env.TRACE_MCP_ALLOW_TEST_ROOTS === '1'
  );
}
