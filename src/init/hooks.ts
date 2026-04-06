/**
 * Guard hook installation and management.
 * Extracted from the setup-hooks CLI command for reuse by init/upgrade.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { InitStepResult } from './types.js';
import { GUARD_HOOK_VERSION, REINDEX_HOOK_VERSION, PRECOMPACT_HOOK_VERSION, WORKTREE_HOOK_VERSION } from './types.js';

const HOME = os.homedir();
const IS_WINDOWS = process.platform === 'win32';
const HOOK_EXT = IS_WINDOWS ? '.cmd' : '.sh';

/** Build the hook command string with inline env var — platform-aware. */
function hookCommand(hookPath: string): string {
  return IS_WINDOWS
    ? `cmd /c "set CLAUDE_TOOL_NAME={{tool_name}}&& "${hookPath}""`
    : `CLAUDE_TOOL_NAME={{tool_name}} ${hookPath}`;
}

/** Build a plain hook command (no env vars — for hooks like PreCompact). */
function plainHookCommand(hookPath: string): string {
  return IS_WINDOWS ? `cmd /c "${hookPath}"` : hookPath;
}

// --- Client directories (Claude + Claw) ---

interface ClientDir {
  configDir: string;    // e.g. '.claude'
  hooksSubdir: string;  // e.g. '.claude/hooks'
}

const CLIENTS: ClientDir[] = [
  { configDir: '.claude', hooksSubdir: path.join('.claude', 'hooks') },
  { configDir: '.claw', hooksSubdir: path.join('.claw', 'hooks') },
];

// --- Hook descriptors ---

interface HookDescriptor {
  scriptName: string;           // e.g. 'trace-mcp-guard'
  settingsKey: string;          // e.g. 'PreToolUse' or 'PostToolUse' or 'PreCompact'
  matcher?: string;             // e.g. 'Read|Grep|Glob|Bash' (optional — PreCompact has none)
  version: string;
  dryRunLabel: string;
  /** If true, use plain command (no CLAUDE_TOOL_NAME env var) */
  plainCommand?: boolean;
}

const GUARD_HOOK: HookDescriptor = {
  scriptName: 'trace-mcp-guard',
  settingsKey: 'PreToolUse',
  matcher: 'Read|Grep|Glob|Bash',
  version: GUARD_HOOK_VERSION,
  dryRunLabel: 'Would install guard hook',
};

const REINDEX_HOOK: HookDescriptor = {
  scriptName: 'trace-mcp-reindex',
  settingsKey: 'PostToolUse',
  matcher: 'Edit|Write|MultiEdit',
  version: REINDEX_HOOK_VERSION,
  dryRunLabel: 'Would install reindex hook',
};

const PRECOMPACT_HOOK: HookDescriptor = {
  scriptName: 'trace-mcp-precompact',
  settingsKey: 'PreCompact',
  version: PRECOMPACT_HOOK_VERSION,
  dryRunLabel: 'Would install precompact hook',
  plainCommand: true,
};

const WORKTREE_HOOK: HookDescriptor = {
  scriptName: 'trace-mcp-worktree',
  settingsKey: 'WorktreeCreate',
  version: WORKTREE_HOOK_VERSION,
  dryRunLabel: 'Would install worktree hook',
  plainCommand: true,
};

// WorktreeRemove uses the same script but different settings key
const WORKTREE_REMOVE_HOOK: HookDescriptor = {
  scriptName: 'trace-mcp-worktree',
  settingsKey: 'WorktreeRemove',
  version: WORKTREE_HOOK_VERSION,
  dryRunLabel: 'Would install worktree remove hook',
  plainCommand: true,
};

// --- Helpers ---

function hookDest(client: ClientDir, desc: HookDescriptor): string {
  return path.join(HOME, client.hooksSubdir, `${desc.scriptName}${HOOK_EXT}`);
}

function settingsPath(client: ClientDir, global: boolean): string {
  return global
    ? path.join(HOME, client.configDir, 'settings.json')
    : path.resolve(process.cwd(), client.configDir, 'settings.local.json');
}

function clientExists(client: ClientDir): boolean {
  return fs.existsSync(path.join(HOME, client.configDir));
}

function findHookSource(scriptName: string): string {
  const filename = `${scriptName}${HOOK_EXT}`;
  const candidates = [
    path.resolve(import.meta.dirname ?? '.', '..', '..', 'hooks', filename),
    path.resolve(process.cwd(), 'hooks', filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Could not find hooks/${filename} — trace-mcp installation may be corrupted.`);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readSettings(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeSettings(filePath: string, settings: Record<string, unknown>): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n');
}

function addHookEntry(
  settings: Record<string, unknown>,
  desc: HookDescriptor,
  dest: string,
): void {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined ?? {};
  settings.hooks = hooks;
  if (!hooks[desc.settingsKey]) hooks[desc.settingsKey] = [];
  const entries = hooks[desc.settingsKey] as { hooks?: { command?: string }[] }[];

  const alreadyExists = entries.some(
    (h) => h.hooks?.some((hh) => hh.command?.includes(desc.scriptName)),
  );
  if (!alreadyExists) {
    const cmd = desc.plainCommand ? plainHookCommand(dest) : hookCommand(dest);
    const entry: Record<string, unknown> = {
      hooks: [{ type: 'command' as const, command: cmd }],
    };
    if (desc.matcher) entry.matcher = desc.matcher;
    entries.push(entry as unknown as { hooks?: { command?: string }[] });
  }
}

function removeHookEntry(settings: Record<string, unknown>, desc: HookDescriptor): void {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return;
  const entries = hooks[desc.settingsKey];
  if (!Array.isArray(entries)) return;

  hooks[desc.settingsKey] = entries.filter(
    (h: { hooks?: { command?: string }[] }) =>
      !h.hooks?.some((hh) => hh.command?.includes(desc.scriptName)),
  );
  if ((hooks[desc.settingsKey] as unknown[]).length === 0) delete hooks[desc.settingsKey];
  if (Object.keys(hooks).length === 0) delete settings.hooks;
}

// --- Generic install/uninstall ---

function installHook(
  desc: HookDescriptor,
  opts: { global?: boolean; dryRun?: boolean },
): InitStepResult {
  const primaryDest = hookDest(CLIENTS[0], desc);

  if (opts.dryRun) {
    return { target: primaryDest, action: 'skipped', detail: desc.dryRunLabel };
  }

  const hookSrc = findHookSource(desc.scriptName);
  const isUpdate = fs.existsSync(primaryDest);

  for (const client of CLIENTS) {
    // Skip non-primary clients if their config dir doesn't exist
    if (client !== CLIENTS[0] && !clientExists(client)) continue;

    const dest = hookDest(client, desc);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(hookSrc, dest);
    if (!IS_WINDOWS) fs.chmodSync(dest, 0o755);

    const sPath = settingsPath(client, !!opts.global);
    const settings = readSettings(sPath);
    addHookEntry(settings, desc, dest);
    writeSettings(sPath, settings);
  }

  return {
    target: primaryDest,
    action: isUpdate ? 'updated' : 'created',
    detail: `v${desc.version} → ${settingsPath(CLIENTS[0], !!opts.global)}`,
  };
}

function uninstallHook(
  desc: HookDescriptor,
  opts: { global?: boolean },
): InitStepResult {
  for (const client of CLIENTS) {
    const sPath = settingsPath(client, !!opts.global);
    if (fs.existsSync(sPath)) {
      const settings = readSettings(sPath);
      removeHookEntry(settings, desc);
      writeSettings(sPath, settings);
    }
    const dest = hookDest(client, desc);
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
  }

  return { target: hookDest(CLIENTS[0], desc), action: 'updated', detail: 'Removed' };
}

// --- Public API ---

export function installGuardHook(opts: {
  global?: boolean;
  dryRun?: boolean;
}): InitStepResult {
  return installHook(GUARD_HOOK, opts);
}

export function uninstallGuardHook(opts: { global?: boolean }): InitStepResult {
  return uninstallHook(GUARD_HOOK, opts);
}

/**
 * Check if the installed hook is outdated compared to shipped version.
 */
export function isHookOutdated(installedVersion: string | null): boolean {
  if (!installedVersion) return true;
  return installedVersion !== GUARD_HOOK_VERSION;
}

export function installReindexHook(opts: {
  global?: boolean;
  dryRun?: boolean;
}): InitStepResult {
  return installHook(REINDEX_HOOK, opts);
}

export function uninstallReindexHook(opts: { global?: boolean }): InitStepResult {
  return uninstallHook(REINDEX_HOOK, opts);
}

export function installPrecompactHook(opts: {
  global?: boolean;
  dryRun?: boolean;
}): InitStepResult {
  return installHook(PRECOMPACT_HOOK, opts);
}

export function uninstallPrecompactHook(opts: { global?: boolean }): InitStepResult {
  return uninstallHook(PRECOMPACT_HOOK, opts);
}

export function installWorktreeHook(opts: {
  global?: boolean;
  dryRun?: boolean;
}): InitStepResult[] {
  // Install both WorktreeCreate and WorktreeRemove — same script handles both events
  return [
    installHook(WORKTREE_HOOK, opts),
    installHook(WORKTREE_REMOVE_HOOK, opts),
  ];
}

export function uninstallWorktreeHook(opts: { global?: boolean }): InitStepResult[] {
  return [
    uninstallHook(WORKTREE_HOOK, opts),
    uninstallHook(WORKTREE_REMOVE_HOOK, opts),
  ];
}
