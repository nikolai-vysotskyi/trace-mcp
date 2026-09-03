/**
 * Stable launcher shim that MCP clients invoke instead of the version-specific
 * `trace-mcp` binary path. The shim resolves node + dist/cli.js at runtime
 * from a config file written here, with a probe fallback — so node upgrades
 * (nvm/Herd/Volta/fnm) don't break MCP registration.
 *
 * Layout under $TRACE_MCP_HOME (default ~/.trace):
 *   bin/trace         — bash shim, copied from hooks/trace-mcp-launcher.sh
 *   launcher.env      — KV config (TRACE_MCP_NODE, TRACE_MCP_CLI, TRACE_MCP_VERSION)
 *   launcher.log      — rolling resolution diagnostics written by the shim
 *
 * A pre-TRA-611 install also gets `~/.trace-mcp/bin/trace-mcp` preserved as a
 * symlink to the above — see installLegacyBinCompat().
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withPs1Bom } from './ps1-bom.js';
import { atomicWriteString } from '../utils/atomic-write.js';
import { isSymlink } from '../utils/path-migration.js';
import { readIfExists } from '../utils/safe-fs.js';
import { LEGACY_MIGRATION_MARKER, TRACE_MCP_HOME } from '../global.js';
import type { InitStepResult } from './types.js';
import { LAUNCHER_VERSION } from './types.js';

const IS_WINDOWS = process.platform === 'win32';

/** Upper bound on remembered package roots — keeps the shim's probe O(small). */
const MAX_PKG_ROOTS = 10;

// Artifacts shipped from hooks/ and installed under $TRACE_MCP_HOME/bin/.
// On Unix a single shim file carries the resolution logic; on Windows a
// .cmd shim is what MCP clients spawn, but the actual logic lives in a
// sibling .ps1 so we can parse JSON/config without bat-script pain.
interface LauncherArtifact {
  src: string; // basename inside hooks/
  dest: string; // basename inside $TRACE_MCP_HOME/bin/
  mode: number;
  isPrimaryShim: boolean; // the file MCP clients invoke
}

const ARTIFACTS: LauncherArtifact[] = IS_WINDOWS
  ? [
      { src: 'trace-mcp-launcher.cmd', dest: 'trace.cmd', mode: 0o755, isPrimaryShim: true },
      {
        src: 'trace-mcp-launcher.ps1',
        dest: 'trace-mcp-launcher.ps1',
        mode: 0o755,
        isPrimaryShim: false,
      },
    ]
  : [{ src: 'trace-mcp-launcher.sh', dest: 'trace', mode: 0o755, isPrimaryShim: true }];

// Legacy (pre-TRA-611) destination basenames, kept only to install the
// `~/.trace-mcp/bin/`-legacy compat symlinks — see installLegacyBinCompat().
const LEGACY_PRIMARY_DEST = IS_WINDOWS ? 'trace-mcp.cmd' : 'trace-mcp';

export function getLauncherDir(): string {
  // Distinct from TRACE_MCP_DATA_DIR (src/global.ts) — the Electron main
  // process resolves the same directory via this env var; keep it as-is.
  const envDir = process.env.TRACE_MCP_HOME?.trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), '.trace');
}

export function getLauncherPath(): string {
  const primary = ARTIFACTS.find((a) => a.isPrimaryShim);
  if (!primary) throw new Error('No primary launcher artifact defined');
  return path.join(getLauncherDir(), 'bin', primary.dest);
}

export function getLauncherConfigPath(): string {
  return path.join(getLauncherDir(), 'launcher.env');
}

function findLauncherSource(basename: string): string {
  const base = import.meta.dirname ?? '.';
  const candidates = [
    path.resolve(base, '..', '..', 'hooks', basename), // dev: src/init → ../../hooks
    path.resolve(base, '..', 'hooks', basename), // bundled: dist/ → ../hooks
    path.resolve(process.cwd(), 'hooks', basename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Could not find hooks/${basename} — trace-mcp installation may be corrupted.`);
}

/**
 * Read the version from the installed launcher's header comment.
 * Scans all installed artifacts; returns the lowest version found so an
 * out-of-sync helper (e.g. .ps1 newer than .cmd) still triggers reinstall.
 * Returns null if no artifact is installed or none carries a version marker.
 */
export function readInstalledLauncherVersion(): string | null {
  const dir = path.join(getLauncherDir(), 'bin');
  const versions: string[] = [];
  for (const a of ARTIFACTS) {
    const p = path.join(dir, a.dest);
    if (!fs.existsSync(p)) return null; // any missing artifact = "not installed"
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(256);
        fs.readSync(fd, buf, 0, 256, 0);
        const head = buf.toString('utf-8');
        const match = head.match(/trace-mcp-launcher v([0-9]+\.[0-9]+\.[0-9]+)/);
        if (match) versions.push(match[1]);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }
  if (versions.length === 0) return null;
  // If any helper lacks a version marker, treat the install as outdated.
  if (versions.length < ARTIFACTS.length) return null;
  // Return the minimum by semver-lexical sort — safe since versions share format.
  return versions.sort()[0];
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    if (!IS_WINDOWS) {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Escape a path for embedding in the launcher.env KV file. The shim strips
 * exactly one pair of surrounding double-quotes and performs no expansion,
 * so we double-quote and reject values containing literal double-quotes
 * (which would break parsing). Paths on real systems never contain `"`.
 */
function quoteEnvValue(v: string): string {
  if (v.includes('"')) {
    throw new Error(`launcher config value contains unsupported character ": ${v}`);
  }
  return `"${v}"`;
}

export interface LauncherConfig {
  node: string;
  cli: string;
  version: string;
}

/**
 * Overwrite launcher.env atomically. Safe to call concurrently with the
 * shim reading it — the shim either sees the old file or the new one.
 */
export function writeLauncherConfig(cfg: LauncherConfig): void {
  const lines = [
    '# Managed by `trace-mcp init` — do not edit by hand.',
    '# Regenerated each time init runs; only whitelisted keys are honored.',
    `TRACE_MCP_NODE=${quoteEnvValue(cfg.node)}`,
    `TRACE_MCP_CLI=${quoteEnvValue(cfg.cli)}`,
    `TRACE_MCP_VERSION=${quoteEnvValue(cfg.version)}`,
    '',
  ];
  atomicWriteString(getLauncherConfigPath(), lines.join('\n'), {
    mode: 0o600,
    rejectSymlinks: true,
  });
}

/**
 * Parse the installed launcher.env using the same rules the shim does
 * (whitelist keys, strip one layer of quotes, ignore comments and blanks).
 */
export function readLauncherConfig(): Partial<LauncherConfig> {
  const p = getLauncherConfigPath();
  const content = readIfExists(p);
  if (content === null) return {};
  const result: Partial<LauncherConfig> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trimStart();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (key === 'TRACE_MCP_NODE') result.node = value;
    else if (key === 'TRACE_MCP_CLI') result.cli = value;
    else if (key === 'TRACE_MCP_VERSION') result.version = value;
  }
  return result;
}

export function getPkgRootsPath(): string {
  return path.join(getLauncherDir(), 'pkg-roots');
}

/**
 * Record the global `node_modules` root this build was installed into, so the
 * shim can find `dist/cli.js` there later even when launcher.env has gone
 * stale. Prefixes we cannot enumerate — bundled runtimes, corporate
 * `npm config set prefix` — only become findable this way, and the shim is not
 * allowed to ask npm at runtime (it inherits the MCP client's PATH, which in a
 * project directory can carry a repo-controlled `node_modules/.bin`).
 *
 * Append-only, deduplicated, capped: an entry costs one `-d` test per start.
 */
export function recordPkgRoot(cliPath: string): void {
  // <root>/trace-mcp/dist/cli.js → <root>
  const root = path.resolve(path.dirname(cliPath), '..', '..');
  if (path.basename(root) !== 'node_modules') return;
  const file = getPkgRootsPath();
  try {
    const existing = (readIfExists(file) ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (existing.includes(root)) return;
    const next = [...existing, root].slice(-MAX_PKG_ROOTS);
    ensureDir(path.dirname(file));
    atomicWriteString(file, `${next.join('\n')}\n`, { mode: 0o600, rejectSymlinks: true });
  } catch {
    /* best-effort — a missed record only costs the shim a probe */
  }
}

export interface InstallLauncherOpts {
  dryRun?: boolean;
  force?: boolean;
}

/** Header line every shim we ship carries — `# trace-mcp-launcher v0.4.0`. */
const LAUNCHER_HEADER_RE = /trace-mcp-launcher v[0-9]+\.[0-9]+\.[0-9]+/;

/** True only for a shim this project wrote, so we never clobber a user's file. */
function isOwnedShim(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256);
      fs.readSync(fd, buf, 0, 256, 0);
      return LAUNCHER_HEADER_RE.test(buf.toString('utf-8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Keep `~/.trace-mcp/bin/trace-mcp` (`trace-mcp.cmd` on Windows) pointing at the
 * current `~/.trace/bin/trace` shim, so a client still registered at the
 * pre-TRA-611 absolute path keeps working after the rename.
 *
 * The legacy path must be a *symlink*, not a copy. A pre-rename install left a
 * real shim file there, and `installLauncher` only ever writes into the current
 * launcher dir — so a client spawning the legacy path stayed frozen on whatever
 * launcher version happened to be on disk at migration time, and no later
 * launcher fix could reach it (TRA-716). Replacing that stale file with a
 * symlink is what makes the legacy path track every future upgrade.
 *
 * Acts when either signal says a legacy path may still be registered:
 * LEGACY_MIGRATION_MARKER (a durable file left in the new home the moment the
 * rename succeeds — durable rather than the one-shot TRACE_MCP_HOME_MIGRATED
 * flag, so a failure here gets retried by every later `trace init`), or a
 * surviving `~/.trace-mcp/bin` directory, which only a pre-rename install has.
 * Without either we create nothing: a fresh install has no legacy path to
 * preserve, and inventing one would just be litter.
 */
function installLegacyBinCompat(): void {
  const legacyDir = path.join(os.homedir(), '.trace-mcp', 'bin');
  const legacyPath = path.join(legacyDir, LEGACY_PRIMARY_DEST);
  // When the legacy home *is* the launcher home, the real shim already lives at
  // this path; symlinking it would point it at itself.
  if (path.resolve(legacyPath) === path.resolve(getLauncherPath())) return;
  try {
    if (isSymlink(legacyPath)) return; // already delegating to the current shim
    const exists = fs.existsSync(legacyPath);
    if (
      !exists &&
      !fs.existsSync(legacyDir) &&
      !fs.existsSync(path.join(TRACE_MCP_HOME, LEGACY_MIGRATION_MARKER))
    ) {
      return;
    }
    if (exists) {
      if (!isOwnedShim(legacyPath)) return;
      fs.unlinkSync(legacyPath);
    }
    ensureDir(legacyDir);
    fs.symlinkSync(getLauncherPath(), legacyPath);
  } catch {
    /* best-effort — the durable signals mean the next `trace init` retries */
  }
}

/**
 * Install the shim script at $TRACE_MCP_HOME/bin/trace-mcp, skipping if the
 * installed version matches the shipped one (unless force=true).
 * Does NOT write launcher.env — call writeLauncherConfig() separately with
 * the current process's node + cli paths.
 */
export function installLauncher(opts: InstallLauncherOpts): InitStepResult {
  const dest = getLauncherPath();
  const dryRun = !!opts.dryRun;

  const installedVersion = readInstalledLauncherVersion();
  const isCurrent = installedVersion === LAUNCHER_VERSION;

  if (isCurrent && !opts.force) {
    return {
      target: dest,
      action: 'already_configured',
      detail: `launcher v${LAUNCHER_VERSION}`,
    };
  }

  if (dryRun) {
    return {
      target: dest,
      action: installedVersion ? 'updated' : 'created',
      detail: installedVersion
        ? `Would upgrade launcher v${installedVersion} → v${LAUNCHER_VERSION}`
        : `Would install launcher v${LAUNCHER_VERSION}`,
    };
  }

  const binDir = path.dirname(dest);
  ensureDir(binDir);
  // Install every artifact (on Windows: .cmd shim + .ps1 helper) atomically.
  for (const a of ARTIFACTS) {
    const src = findLauncherSource(a.src);
    const artifactDest = path.join(binDir, a.dest);
    // Prepend a UTF-8 BOM for .ps1 artifacts so Windows PowerShell 5.1 decodes
    // them as UTF-8 regardless of the machine's system codepage (cp1251 etc.).
    const content = withPs1Bom(artifactDest, fs.readFileSync(src));
    atomicWriteString(artifactDest, content.toString('utf-8'), {
      mode: a.mode,
      rejectSymlinks: true,
      trailingNewline: false,
    });
    if (!IS_WINDOWS) {
      try {
        fs.chmodSync(artifactDest, a.mode);
      } catch {
        /* best-effort */
      }
    }
  }

  installLegacyBinCompat();

  return {
    target: dest,
    action: installedVersion ? 'updated' : 'created',
    detail: installedVersion
      ? `Upgraded launcher v${installedVersion} → v${LAUNCHER_VERSION}`
      : `Installed launcher v${LAUNCHER_VERSION}`,
  };
}

/**
 * Resolve the absolute path to the dist/cli.js currently running (the one
 * the user invoked via `trace-mcp init`). Used to write launcher.env.
 */
export function resolveCurrentCliPath(): string {
  // process.argv[1] is the script being executed. npm's bin symlink resolves
  // to the real dist/cli.js target under normal installs. For `npm link` in
  // dev, it's the repo's dist/cli.js. Either way, it's an absolute file path.
  const argv1 = process.argv[1];
  if (!argv1 || !path.isAbsolute(argv1)) {
    throw new Error('Cannot determine trace-mcp CLI path from process.argv[1]');
  }
  // Resolve symlink to the concrete file so upgrades don't leave dangling config.
  try {
    return fs.realpathSync(argv1);
  } catch {
    return argv1;
  }
}

/**
 * Convenience: install shim + write config in one call. Used by `trace-mcp init`.
 */
export function setupLauncher(
  opts: InstallLauncherOpts & { pkgVersion: string },
): InitStepResult[] {
  const steps: InitStepResult[] = [];
  steps.push(installLauncher(opts));

  if (opts.dryRun) {
    steps.push({
      target: getLauncherConfigPath(),
      action: 'skipped',
      detail: 'Would write launcher.env with current node + cli paths',
    });
    return steps;
  }

  try {
    const cfg: LauncherConfig = {
      node: process.execPath,
      cli: resolveCurrentCliPath(),
      version: opts.pkgVersion,
    };
    recordPkgRoot(cfg.cli);
    const existing = readLauncherConfig();
    const unchanged =
      existing.node === cfg.node && existing.cli === cfg.cli && existing.version === cfg.version;
    if (unchanged && !opts.force) {
      steps.push({
        target: getLauncherConfigPath(),
        action: 'already_configured',
        detail: `node=${cfg.node}`,
      });
    } else {
      writeLauncherConfig(cfg);
      steps.push({
        target: getLauncherConfigPath(),
        action: existing.node ? 'updated' : 'created',
        detail: `node=${cfg.node}`,
      });
    }
  } catch (err) {
    steps.push({
      target: getLauncherConfigPath(),
      action: 'skipped',
      detail: `Failed to write launcher.env: ${(err as Error).message}`,
    });
  }

  return steps;
}
