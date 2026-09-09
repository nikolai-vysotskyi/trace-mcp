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

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withPs1Bom } from './ps1-bom.js';
import { atomicWriteString } from '../utils/atomic-write.js';
import { isSymlink } from '../utils/path-migration.js';
import { readIfExists } from '../utils/safe-fs.js';
import { LEGACY_MIGRATION_MARKER, TRACE_MCP_HOME } from '../global.js';
import { getHomeDir } from './home.js';
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
  return path.join(getHomeDir(), '.trace');
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

export type LauncherPathStatus =
  | 'ok'
  | 'missing'
  | 'dangling_symlink'
  | 'not_a_file'
  | 'not_executable'
  | 'broken_interpreter'
  | 'broken_delegate'
  | 'unmanaged_binary'
  | 'foreign'
  | 'unchecked';

export interface LauncherPathCheck {
  path: string;
  status: LauncherPathStatus;
  detail: string;
}

/**
 * Everything a client needs to be true of the file it spawns, in the order the
 * OS would hit it: the path exists, resolves, is a regular file, and is
 * executable. `foreign` is last and is not a breakage — a hand-rolled wrapper
 * still runs; it just is not a file we may repair.
 */
export function checkLauncherFile(file: string): LauncherPathCheck {
  // A bare command name ("npx", "trace") is resolved by the client through
  // PATH, which we cannot reproduce faithfully — say so instead of guessing.
  if (!path.isAbsolute(file)) {
    return { path: file, status: 'unchecked', detail: 'not an absolute path — resolved via PATH' };
  }
  let link: fs.Stats;
  try {
    link = fs.lstatSync(file);
  } catch {
    return { path: file, status: 'missing', detail: 'no such file' };
  }
  let target = file;
  if (link.isSymbolicLink()) {
    try {
      target = fs.realpathSync(file);
    } catch {
      const dest = (() => {
        try {
          return fs.readlinkSync(file);
        } catch {
          return '?';
        }
      })();
      return { path: file, status: 'dangling_symlink', detail: `symlink target missing: ${dest}` };
    }
  }
  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    return {
      path: file,
      status: 'not_a_file',
      detail: stat.isDirectory() ? 'is a directory' : 'not a regular file',
    };
  }
  // Windows has no execute bit — the extension decides, and the client spawns
  // it either way, so there is nothing here to check.
  if (!IS_WINDOWS) {
    try {
      fs.accessSync(target, fs.constants.X_OK);
    } catch {
      return {
        path: file,
        status: 'not_executable',
        detail: `mode ${(stat.mode & 0o777).toString(8)} — missing execute bit`,
      };
    }
  }
  if (!isOwnedShim(target)) {
    if (isDirectTraceMcpBinary(file, target)) {
      return {
        path: file,
        status: 'unmanaged_binary',
        detail: 'direct trace-mcp binary (bypasses launcher shim) — run: trace clients update',
      };
    }
    return { path: file, status: 'foreign', detail: 'not a trace-mcp launcher — left alone' };
  }
  // Mode bits are not the last gate: the kernel still has to find the shim's
  // interpreter, and the Windows compat shim still has to find the launcher it
  // execs. Both fail with the shim never running a line, so neither reaches
  // launcher.log — the exact class of failure this check exists for.
  const interpreter = missingInterpreter(target);
  if (interpreter) {
    return {
      path: file,
      status: 'broken_interpreter',
      detail: `interpreter missing: ${interpreter}`,
    };
  }
  const delegate = missingDelegate(target);
  if (delegate) {
    return {
      path: file,
      status: 'broken_delegate',
      detail: `delegates to a missing launcher: ${delegate}`,
    };
  }
  return { path: file, status: 'ok', detail: 'executable trace-mcp launcher' };
}

/** First line of a file, or '' when it cannot be read. */
function firstLines(file: string, count: number): string[] {
  try {
    return fs.readFileSync(file, 'utf-8').split(/\r?\n/, count);
  } catch {
    return [];
  }
}

/** Is `name` an executable file on PATH? */
function onPath(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => {
    try {
      fs.accessSync(path.join(d, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The interpreter a `#!` line names, when that interpreter is not there.
 * `exec` fails with ENOENT pointing at the *shim*, so the user sees a file that
 * plainly exists refusing to run — worth naming explicitly. Returns null when
 * the line is absent (a Windows `.cmd` has none) or the interpreter resolves.
 */
function missingInterpreter(file: string): string | null {
  const [first] = firstLines(file, 1);
  if (!first?.startsWith('#!')) return null;
  const parts = first.slice(2).trim().split(/\s+/).filter(Boolean);
  const [interp, arg] = parts;
  if (!interp) return null;
  if (!fs.existsSync(interp)) return interp;
  // `#!/usr/bin/env bash` fails just as hard when `bash` is not on PATH.
  if (path.basename(interp) === 'env' && arg && !arg.startsWith('-') && !onPath(arg)) {
    return arg;
  }
  return null;
}

/** Path a compat shim execs, when that path is gone. See legacyCompatCmdBody(). */
function missingDelegate(file: string): string | null {
  for (const line of firstLines(file, 8)) {
    const m = line.match(/^"([^"]+)"\s+%\*\s*$/);
    if (m?.[1] && !fs.existsSync(m[1])) return m[1];
  }
  return null;
}

/** Statuses that mean the client gets `Failed to connect` with an empty log. */
export function isBroken(status: LauncherPathStatus): boolean {
  return status !== 'ok' && status !== 'foreign' && status !== 'unchecked';
}

export interface InstallLauncherOpts {
  dryRun?: boolean;
  force?: boolean;
}

/** Header line every shim we ship carries — `# trace-mcp-launcher v0.4.0`. */
const LAUNCHER_HEADER_RE = /trace-mcp-launcher v[0-9]+\.[0-9]+\.[0-9]+/;

/** True only for a shim this project wrote, so we never clobber a user's file. */
export function isOwnedShim(file: string): boolean {
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
 * Detect whether a file or its symlink target is a direct npm binary or cli.js of trace-mcp,
 * rather than the canonical launcher shim. Direct binaries bypass launcher.env and daemon proxy,
 * and break when the host Node environment changes (TRA-1266).
 */
export function isDirectTraceMcpBinary(file: string, target: string): boolean {
  if (/[/\\]trace-mcp[/\\]dist[/\\]cli\.[cm]?js$/.test(target)) return true;
  const base = path.basename(file).toLowerCase();
  if (
    base === 'trace' ||
    base === 'trace-mcp' ||
    base === 'trace.cmd' ||
    base === 'trace-mcp.cmd' ||
    base === 'trace.ps1' ||
    base === 'trace-mcp.ps1'
  ) {
    if (/[/\\]dist[/\\]cli\.[cm]?js$/.test(target)) {
      const parentPkg = path.resolve(path.dirname(target), '..', 'package.json');
      try {
        if (fs.existsSync(parentPkg)) {
          const pkg = JSON.parse(fs.readFileSync(parentPkg, 'utf-8'));
          if (pkg.name === 'trace-mcp') return true;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/**
 * Body of the Windows compat shim. Windows symlinks need privileges the
 * installer usually lacks, so the legacy `.cmd` delegates by exec instead —
 * which tracks launcher upgrades just as a symlink would, since it resolves
 * the current shim at run time rather than copying it.
 */
export function legacyCompatCmdBody(currentLauncher: string): string {
  return [
    '@echo off',
    `REM trace-mcp-launcher v${LAUNCHER_VERSION} compat shim — do not edit by hand.`,
    'REM Delegates to the current launcher so this path tracks every upgrade.',
    `"${currentLauncher}" %*`,
    '',
  ].join('\r\n');
}

/**
 * Point `legacyPath` at `current` without ever leaving the legacy path missing.
 *
 * The old path is what a registered MCP client spawns, so it must survive a
 * failed replacement: unlinking first and then failing to create the
 * replacement would take the client's launcher away entirely — worse than the
 * stale shim we set out to fix. Both branches build the new entry beside the
 * old one and swap it in with a single rename.
 */
function writeLegacyCompat(legacyPath: string, current: string): void {
  // `.tmp.<pid>.<12 hex>`: the shape sweepOrphanTmpFiles collects
  // (src/utils/atomic-write.ts), and `bin` is one of the dirs it sweeps. A
  // process killed between the symlink and the rename leaks this file, and
  // without the hex suffix the pattern never matched it — so it sat next to the
  // launcher forever (TRA-982).
  const tmp = `${legacyPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    if (IS_WINDOWS) {
      fs.writeFileSync(tmp, legacyCompatCmdBody(current), { mode: 0o755 });
    } else {
      fs.symlinkSync(current, tmp);
    }
    fs.renameSync(tmp, legacyPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}

/**
 * Keep `~/.trace-mcp/bin/trace-mcp` (`trace-mcp.cmd` on Windows) pointing at the
 * current `~/.trace/bin/trace` shim, so a client still registered at the
 * pre-TRA-611 absolute path keeps working after the rename.
 *
 * The legacy path must *delegate*, not be a copy. A pre-rename install left a
 * real shim file there, and `installLauncher` only ever writes into the current
 * launcher dir — so a client spawning the legacy path stayed frozen on whatever
 * launcher version happened to be on disk at migration time, and no later
 * launcher fix could reach it (TRA-716). Replacing that stale file with a
 * symlink (or a delegating `.cmd` on Windows) is what makes the legacy path
 * track every future upgrade.
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
  const legacyDir = path.join(getHomeDir(), '.trace-mcp', 'bin');
  const legacyPath = path.join(legacyDir, LEGACY_PRIMARY_DEST);
  const current = getLauncherPath();
  // When the legacy home *is* the launcher home, the real shim already lives at
  // this path; delegating it would point it at itself.
  if (path.resolve(legacyPath) === path.resolve(current)) return;
  // The legacy path lives in the real home no matter where the launcher home
  // points, so a run aimed at some other home would reach out and repoint it at
  // a directory the real machine does not use. When that home is a throwaway one
  // — our own test suite's mkdtemp, a sandboxed install probe — the symlink
  // dangles the moment it is cleaned up, and every MCP client registered at the
  // legacy path gets ENOENT with nothing in launcher.log to explain it: the shim
  // never runs, so it never logs (TRA-910). A custom TRACE_MCP_HOME means "use
  // this home"; writing into a different one is never what it asked for.
  if (path.resolve(getLauncherDir()) !== path.resolve(getHomeDir(), '.trace')) return;
  try {
    // existsSync follows the link: a symlink pointing at a target that is gone
    // is the one state that actually breaks clients, so it must not be mistaken
    // for a healthy delegation and skipped (TRA-910).
    if (isSymlink(legacyPath) && fs.existsSync(legacyPath)) return; // already delegating
    const exists = fs.existsSync(legacyPath);
    if (
      !exists &&
      !fs.existsSync(legacyDir) &&
      !fs.existsSync(path.join(TRACE_MCP_HOME, LEGACY_MIGRATION_MARKER))
    ) {
      return;
    }
    // Anything we did not write is the user's own wrapper — leave it alone.
    // A dangling symlink has no content to sniff, so it cannot be checked for
    // ownership and is always repaired. That is the intended trade: a broken
    // link at this exact path spawns nothing for anyone, so there is no working
    // setup left to protect.
    if (exists && !isOwnedShim(legacyPath)) return;
    ensureDir(legacyDir);
    writeLegacyCompat(legacyPath, current);
  } catch {
    /* best-effort — the durable signals mean the next `trace init` retries,
       and the legacy path is left exactly as it was found */
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
  // A shim whose header reads current can still be unspawnable — most often it
  // lost its execute bit — and version alone would skip right past it, leaving
  // every client failing with a launcher.log that never got written (TRA-913).
  const isCurrent =
    installedVersion === LAUNCHER_VERSION && !isBroken(checkLauncherFile(dest).status);

  if (isCurrent && !opts.force) {
    // The shim in the current home is up to date, but the legacy compat path is
    // a separate file that may still hold a stale pre-rename shim — and this is
    // the branch an ordinary `trace upgrade` takes, so skipping the repair here
    // would leave every affected client unfixed (TRA-716).
    if (!dryRun) installLegacyBinCompat();
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
