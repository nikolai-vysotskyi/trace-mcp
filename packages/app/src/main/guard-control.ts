/**
 * Guard control — read trace-mcp guard status / mode for a project,
 * and toggle the per-project mode file.
 *
 * Status reader: parses $TMPDIR/trace-mcp-status-{projectHash}.json written
 * by the trace-mcp server (see src/server/heartbeat.ts).
 *
 * Mode toggle: writes <projectRoot>/.trace-mcp/guard-mode (one of
 * "strict" | "coach" | "off"). The hook reads this file before each call.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Minimum trace-mcp CLI version this app expects on the host machine.
 * Bump in lockstep with breaking server-side changes (e.g. a new sentinel
 * format or a hook contract change). The app reads this against the value
 * reported by `trace-mcp --version` and surfaces an upgrade prompt when
 * the installed CLI is older.
 */
export const MIN_TRACE_MCP_VERSION = '1.32.7';

export type GuardMode = 'strict' | 'coach' | 'off';

export interface GuardStatus {
  /** "ok" | "stalled" | "down" | "unknown" — derived from status JSON. */
  health: 'ok' | 'stalled' | 'down' | 'unknown';
  /** Current mode for this project. */
  mode: GuardMode;
  /** Server PID, when known. */
  pid?: number;
  /** ISO 8601 timestamp of last successful tool call, when known. */
  lastSuccessAt?: string | null;
  /** Total tool calls observed by the server. */
  toolCallsTotal?: number;
  /** Total tool-call failures observed by the server. */
  toolCallsFailed?: number;
  /** Seconds since the last successful tool call (when present). */
  quietSeconds?: number;
  /** Manual bypass active until (epoch seconds). 0 = no bypass. */
  bypassUntil?: number;
  /** Free-form reason, useful when health != "ok". */
  reason?: string;
  /** Epoch seconds when guard was first initialized for this project. */
  initializedAt?: number;
  /** Epoch seconds when coach mode auto-promotes to strict (only set in coach). */
  coachExpiresAt?: number;
  /** Set to true on the single status read that triggered auto-promotion. */
  autoPromoted?: boolean;
}

const STALL_THRESHOLD_SEC = 300;
const HEARTBEAT_STALE_SEC = 30;
/** First-week onboarding — coach mode automatically promotes after this. */
const COACH_PROMOTE_AFTER_DAYS = 7;
const COACH_PROMOTE_AFTER_SEC = COACH_PROMOTE_AFTER_DAYS * 24 * 60 * 60;

function projectHash(projectRoot: string): string {
  return crypto
    .createHash('sha256')
    .update(path.resolve(projectRoot))
    .digest('hex')
    .slice(0, 12);
}

function statusPath(projectRoot: string): string {
  return path.join(os.tmpdir(), `trace-mcp-status-${projectHash(projectRoot)}.json`);
}

function legacyHeartbeatPath(projectRoot: string): string {
  return path.join(os.tmpdir(), `trace-mcp-alive-${projectHash(projectRoot)}`);
}

function bypassPath(projectRoot: string): string {
  return path.join(os.tmpdir(), `trace-mcp-bypass-${projectHash(projectRoot)}`);
}

function modeFile(projectRoot: string): string {
  return path.join(projectRoot, '.trace-mcp', 'guard-mode');
}

function installDateFile(projectRoot: string): string {
  return path.join(projectRoot, '.trace-mcp', 'install-date');
}

function readInstallDate(projectRoot: string): number | undefined {
  try {
    const raw = fs.readFileSync(installDateFile(projectRoot), 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function writeInstallDate(projectRoot: string, epochSec: number): void {
  const dir = path.dirname(installDateFile(projectRoot));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(installDateFile(projectRoot), `${epochSec}\n`);
}

function clearInstallDate(projectRoot: string): void {
  try {
    fs.unlinkSync(installDateFile(projectRoot));
  } catch {
    /* not present */
  }
}

/**
 * Initialize guard state for a project on first encounter.
 * Idempotent: only writes files if neither mode-file nor install-date exists.
 * Default mode for new projects = coach (the onboarding contract).
 */
export function initializeGuard(projectRoot: string): {
  initialized: boolean;
  mode: GuardMode;
} {
  const hasMode = fs.existsSync(modeFile(projectRoot));
  const hasInstallDate = fs.existsSync(installDateFile(projectRoot));
  if (hasMode || hasInstallDate) {
    return { initialized: false, mode: getGuardMode(projectRoot) };
  }
  const now = Math.floor(Date.now() / 1000);
  setGuardMode(projectRoot, 'coach');
  writeInstallDate(projectRoot, now);
  return { initialized: true, mode: 'coach' };
}

/** Read the per-project guard mode file. Falls back to "strict". */
export function getGuardMode(projectRoot: string): GuardMode {
  try {
    const raw = fs.readFileSync(modeFile(projectRoot), 'utf-8').trim();
    if (raw === 'strict' || raw === 'coach' || raw === 'off') return raw;
  } catch {
    /* missing file = default */
  }
  return 'strict';
}

/** Write the per-project guard mode file (creates parent dir). */
export function setGuardMode(projectRoot: string, mode: GuardMode): void {
  const dir = path.dirname(modeFile(projectRoot));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(modeFile(projectRoot), `${mode}\n`);
}

/** Best-effort read of a project's current guard status + mode. */
export function getGuardStatus(projectRoot: string): GuardStatus {
  let mode = getGuardMode(projectRoot);
  const initializedAt = readInstallDate(projectRoot);
  let autoPromoted = false;
  let coachExpiresAt: number | undefined;

  // Auto-promote coach → strict after 7 days. The install-date file is
  // cleared so this only fires once; a subsequent manual switch back to
  // coach won't re-arm the timer (fresh setGuardMode doesn't write the date).
  if (mode === 'coach' && initializedAt) {
    coachExpiresAt = initializedAt + COACH_PROMOTE_AFTER_SEC;
    const now = Math.floor(Date.now() / 1000);
    if (now >= coachExpiresAt) {
      setGuardMode(projectRoot, 'strict');
      clearInstallDate(projectRoot);
      mode = 'strict';
      autoPromoted = true;
      coachExpiresAt = undefined;
    }
  }

  // Manual bypass takes visual precedence — it means the user explicitly
  // disabled enforcement.
  let bypassUntil = 0;
  try {
    const bp = bypassPath(projectRoot);
    if (fs.existsSync(bp)) {
      const m = fs.statSync(bp).mtimeMs;
      if (m > Date.now()) bypassUntil = Math.floor(m / 1000);
    }
  } catch {
    /* ignore */
  }

  // Try the rich status JSON first.
  try {
    const raw = fs.readFileSync(statusPath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as {
      pid?: number;
      last_successful_tool_call_at?: string | null;
      last_heartbeat_at?: string;
      tool_calls_total?: number;
      tool_calls_failed?: number;
    };

    const now = Date.now();
    const heartbeatAge = parsed.last_heartbeat_at
      ? Math.floor((now - new Date(parsed.last_heartbeat_at).getTime()) / 1000)
      : Number.POSITIVE_INFINITY;

    let health: GuardStatus['health'] = 'ok';
    let reason: string | undefined;

    if (heartbeatAge > HEARTBEAT_STALE_SEC) {
      health = 'down';
      reason = `Heartbeat stale (${heartbeatAge}s)`;
    } else if (
      typeof parsed.tool_calls_total === 'number' &&
      parsed.tool_calls_total > 0 &&
      parsed.last_successful_tool_call_at
    ) {
      const quiet = Math.floor(
        (now - new Date(parsed.last_successful_tool_call_at).getTime()) / 1000,
      );
      if (quiet > STALL_THRESHOLD_SEC) {
        health = 'stalled';
        reason = `MCP channel quiet for ${quiet}s`;
      }
    }

    const quietSeconds = parsed.last_successful_tool_call_at
      ? Math.floor((now - new Date(parsed.last_successful_tool_call_at).getTime()) / 1000)
      : undefined;

    return {
      health,
      mode,
      pid: parsed.pid,
      lastSuccessAt: parsed.last_successful_tool_call_at ?? null,
      toolCallsTotal: parsed.tool_calls_total,
      toolCallsFailed: parsed.tool_calls_failed,
      quietSeconds,
      bypassUntil,
      reason,
      initializedAt,
      coachExpiresAt,
      autoPromoted: autoPromoted || undefined,
    };
  } catch {
    /* fall through to legacy / unknown */
  }

  // Fallback: legacy heartbeat sentinel only — limited info.
  try {
    const legacy = legacyHeartbeatPath(projectRoot);
    if (fs.existsSync(legacy)) {
      const age = Math.floor((Date.now() - fs.statSync(legacy).mtimeMs) / 1000);
      if (age <= HEARTBEAT_STALE_SEC) {
        return {
          health: 'ok',
          mode,
          bypassUntil,
          reason: 'Legacy heartbeat only — server pre-v0.8',
          initializedAt,
          coachExpiresAt,
          autoPromoted: autoPromoted || undefined,
        };
      }
      return {
        health: 'down',
        mode,
        bypassUntil,
        reason: `Legacy heartbeat stale (${age}s)`,
        initializedAt,
        coachExpiresAt,
        autoPromoted: autoPromoted || undefined,
      };
    }
  } catch {
    /* ignore */
  }

  return {
    health: 'down',
    mode,
    bypassUntil,
    reason: 'trace-mcp server not running',
    initializedAt,
    coachExpiresAt,
    autoPromoted: autoPromoted || undefined,
  };
}

// ─── Hook installer (Claude Code settings.json) ────────────────────

const HOOK_SCRIPT_NAME = 'trace-mcp-guard.sh';

function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function claudeHooksDir(): string {
  return path.join(os.homedir(), '.claude', 'hooks');
}

export interface InstallStatus {
  /** True iff Claude Code's settings.json exists. */
  claudeDetected: boolean;
  /** True iff the trace-mcp guard hook is currently installed. */
  installed: boolean;
  /** Hook script path on disk (if installed). */
  scriptPath?: string;
  /** Free-form reason. */
  reason?: string;
}

/** Detect whether Claude Code is installed and whether our guard hook is wired in. */
export function checkInstallStatus(): InstallStatus {
  const settingsFile = claudeSettingsPath();
  if (!fs.existsSync(settingsFile)) {
    return {
      claudeDetected: false,
      installed: false,
      reason: 'Claude Code settings.json not found',
    };
  }
  let installed = false;
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const parsed = JSON.parse(raw) as {
      hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const pretool = parsed.hooks?.PreToolUse ?? [];
    for (const block of pretool) {
      for (const h of block.hooks ?? []) {
        if (typeof h.command === 'string' && h.command.includes(HOOK_SCRIPT_NAME)) {
          installed = true;
        }
      }
    }
  } catch {
    /* malformed settings — treat as not installed */
  }
  const scriptPath = path.join(claudeHooksDir(), HOOK_SCRIPT_NAME);
  return {
    claudeDetected: true,
    installed,
    scriptPath: fs.existsSync(scriptPath) ? scriptPath : undefined,
  };
}

/**
 * Install the guard hook into ~/.claude/settings.json.
 * - Backs up the existing settings file to settings.json.bak (one level deep).
 * - Adds a PreToolUse block matching Read|Grep|Glob|Bash|Agent to the script.
 * - Idempotent: re-running does not add a duplicate block.
 *
 * The caller is expected to have already copied the script to ~/.claude/hooks/
 * (the npm CLI does this on `trace-mcp init --mcp-client claude-code`).
 */
export function installHook(opts: { sourceScript: string }): {
  ok: boolean;
  alreadyInstalled?: boolean;
  backupPath?: string;
  scriptPath?: string;
  error?: string;
} {
  const settingsFile = claudeSettingsPath();
  const hooksDir = claudeHooksDir();
  const scriptDest = path.join(hooksDir, HOOK_SCRIPT_NAME);

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    if (fs.existsSync(opts.sourceScript)) {
      fs.copyFileSync(opts.sourceScript, scriptDest);
      fs.chmodSync(scriptDest, 0o755);
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let parsed: Record<string, unknown> = {};
  if (fs.existsSync(settingsFile)) {
    try {
      const raw = fs.readFileSync(settingsFile, 'utf-8');
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: `settings.json is not valid JSON: ${String(e)}` };
    }
    // Backup before modifying — single level, deterministic name.
    const backup = `${settingsFile}.bak`;
    try {
      fs.copyFileSync(settingsFile, backup);
    } catch (e) {
      return { ok: false, error: `failed to backup settings.json: ${String(e)}` };
    }
  } else {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  }

  const hooks = (parsed.hooks ??= {}) as Record<string, unknown>;
  const preTool = (hooks.PreToolUse ??= []) as Array<{
    matcher?: string;
    hooks?: Array<{ type: string; command: string }>;
  }>;

  const alreadyInstalled = preTool.some((b) =>
    b.hooks?.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_SCRIPT_NAME)),
  );
  if (alreadyInstalled) {
    return {
      ok: true,
      alreadyInstalled: true,
      scriptPath: scriptDest,
    };
  }

  preTool.push({
    matcher: 'Read|Grep|Glob|Bash|Agent',
    hooks: [{ type: 'command', command: scriptDest }],
  });

  try {
    fs.writeFileSync(settingsFile, JSON.stringify(parsed, null, 2));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return {
    ok: true,
    alreadyInstalled: false,
    backupPath: `${settingsFile}.bak`,
    scriptPath: scriptDest,
  };
}

/**
 * Remove the guard hook entry from ~/.claude/settings.json.
 * Leaves the script file on disk (cheap, harmless without the hook entry).
 * Backs up settings.json first. Idempotent.
 */
export function uninstallHook(): {
  ok: boolean;
  removed?: boolean;
  backupPath?: string;
  error?: string;
} {
  const settingsFile = claudeSettingsPath();
  if (!fs.existsSync(settingsFile)) {
    return { ok: true, removed: false };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch (e) {
    return { ok: false, error: `settings.json is not valid JSON: ${String(e)}` };
  }
  const backup = `${settingsFile}.bak`;
  try {
    fs.copyFileSync(settingsFile, backup);
  } catch (e) {
    return { ok: false, error: `failed to backup settings.json: ${String(e)}` };
  }

  const hooks = parsed.hooks as { PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }> } | undefined;
  if (!hooks?.PreToolUse) {
    return { ok: true, removed: false, backupPath: backup };
  }

  let removed = false;
  hooks.PreToolUse = hooks.PreToolUse
    .map((block) => {
      const filtered = (block.hooks ?? []).filter((h) => {
        if (typeof h.command === 'string' && h.command.includes(HOOK_SCRIPT_NAME)) {
          removed = true;
          return false;
        }
        return true;
      });
      return { ...block, hooks: filtered };
    })
    // Drop blocks whose hooks array became empty.
    .filter((block) => (block.hooks ?? []).length > 0);

  if (hooks.PreToolUse.length === 0) {
    delete hooks.PreToolUse;
  }

  try {
    fs.writeFileSync(settingsFile, JSON.stringify(parsed, null, 2));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return { ok: true, removed, backupPath: backup };
}

export interface CliVersionCheck {
  /** Currently installed CLI version, or null if `trace-mcp` could not be found / executed. */
  current: string | null;
  /** Minimum version this app expects. */
  required: string;
  /** True iff a usable CLI is installed and >= required. */
  ok: boolean;
  /** True iff the CLI is installed but older than required. */
  needsUpgrade: boolean;
  /** True iff the CLI was not detected at all. */
  notInstalled: boolean;
  /** Free-form reason when ok=false. */
  reason?: string;
}

/** Compare two semver-ish strings (X.Y.Z, ignoring pre-release tags). */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .split('-')[0]
      .split('.')
      .map((p) => Number.parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

/**
 * Check that the trace-mcp CLI is installed on PATH and is at least
 * MIN_TRACE_MCP_VERSION. Used for an in-app upgrade prompt at startup.
 *
 * Best-effort: if `trace-mcp --version` doesn't exit cleanly we treat the
 * CLI as missing rather than crashing the app.
 */
export function checkCliVersion(): CliVersionCheck {
  let current: string | null = null;
  try {
    const result = spawnSync('trace-mcp', ['--version'], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (result.status === 0 && result.stdout) {
      const m = result.stdout.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
      if (m) current = m[1];
    }
  } catch {
    /* not installed */
  }

  if (!current) {
    return {
      current: null,
      required: MIN_TRACE_MCP_VERSION,
      ok: false,
      needsUpgrade: false,
      notInstalled: true,
      reason: 'trace-mcp CLI not found on PATH',
    };
  }

  const needsUpgrade = compareVersions(current, MIN_TRACE_MCP_VERSION) < 0;
  return {
    current,
    required: MIN_TRACE_MCP_VERSION,
    ok: !needsUpgrade,
    needsUpgrade,
    notInstalled: false,
    reason: needsUpgrade
      ? `Installed ${current}, app expects ≥ ${MIN_TRACE_MCP_VERSION}`
      : undefined,
  };
}

/** Toggle bypass on/off (writes the same sentinel as scripts/trace-mcp-disable-guard.sh). */
export function setBypass(projectRoot: string, minutes: number): void {
  const file = bypassPath(projectRoot);
  if (minutes <= 0) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* not present */
    }
    return;
  }
  fs.writeFileSync(file, 'manual');
  const future = new Date(Date.now() + minutes * 60_000);
  fs.utimesSync(file, future, future);
}
