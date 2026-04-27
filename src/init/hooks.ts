/**
 * Guard hook installation and management.
 * Extracted from the setup-hooks CLI command for reuse by init/upgrade.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { InitStepResult } from './types.js';
import {
  GUARD_HOOK_VERSION,
  REINDEX_HOOK_VERSION,
  PRECOMPACT_HOOK_VERSION,
  WORKTREE_HOOK_VERSION,
} from './types.js';

const HOME = os.homedir();
const IS_WINDOWS = process.platform === 'win32';
const HOOK_EXT = IS_WINDOWS ? '.cmd' : '.sh';

/**
 * Build the hook command string — platform-aware.
 * Claude Code does not substitute {{tool_name}} in hook commands; tool info
 * is delivered to the hook via stdin JSON. Hooks read `tool_name` from stdin
 * via jq, so no env var prefix is needed.
 */
function hookCommand(hookPath: string): string {
  return IS_WINDOWS ? `cmd /c "${hookPath}"` : hookPath;
}

function plainHookCommand(hookPath: string): string {
  return hookCommand(hookPath);
}

// --- Client directories (Claude + Claw) ---

interface ClientDir {
  configDir: string; // e.g. '.claude'
  hooksSubdir: string; // e.g. '.claude/hooks'
}

const CLIENTS: ClientDir[] = [
  { configDir: '.claude', hooksSubdir: path.join('.claude', 'hooks') },
  { configDir: '.claw', hooksSubdir: path.join('.claw', 'hooks') },
];

// --- Hook descriptors ---

interface HookDescriptor {
  scriptName: string; // e.g. 'trace-mcp-guard'
  settingsKey: string; // e.g. 'PreToolUse' or 'PostToolUse' or 'PreCompact'
  matcher?: string; // e.g. 'Read|Grep|Glob|Bash|Agent' (optional — PreCompact has none)
  version: string;
  dryRunLabel: string;
  /** If true, use plain command (no CLAUDE_TOOL_NAME env var) */
  plainCommand?: boolean;
  /**
   * Aux file basenames to copy alongside the main script into the same hooks dir.
   * Used for platform-specific helpers like Windows .ps1 companions.
   * Per entry: { file: 'trace-mcp-guard-read.ps1', platforms: ['win32'] }
   * platforms=undefined means all platforms.
   */
  auxFiles?: Array<{ file: string; platforms?: NodeJS.Platform[] }>;
}

const GUARD_HOOK: HookDescriptor = {
  scriptName: 'trace-mcp-guard',
  settingsKey: 'PreToolUse',
  matcher: 'Read|Grep|Glob|Bash|Agent',
  version: GUARD_HOOK_VERSION,
  dryRunLabel: 'Would install guard hook',
  auxFiles: [
    // Windows-only PowerShell helper for the Read-handler repeat-read dedup.
    { file: 'trace-mcp-guard-read.ps1', platforms: ['win32'] },
  ],
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
  const base = import.meta.dirname ?? '.';
  const candidates = [
    path.resolve(base, '..', '..', 'hooks', filename), // dev: src/init/ → ../../hooks
    path.resolve(base, '..', 'hooks', filename), // bundled: dist/ → ../hooks
    path.resolve(process.cwd(), 'hooks', filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Could not find hooks/${filename} — trace-mcp installation may be corrupted.`);
}

/** Locate an aux hook file by basename (same search path as findHookSource). */
function findAuxFile(basename: string): string | null {
  const base = import.meta.dirname ?? '.';
  const candidates = [
    path.resolve(base, '..', '..', 'hooks', basename),
    path.resolve(base, '..', 'hooks', basename),
    path.resolve(process.cwd(), 'hooks', basename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
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

function addHookEntry(settings: Record<string, unknown>, desc: HookDescriptor, dest: string): void {
  const hooks = (settings.hooks as Record<string, unknown[]> | undefined) ?? {};
  settings.hooks = hooks;
  if (!hooks[desc.settingsKey]) hooks[desc.settingsKey] = [];
  const entries = hooks[desc.settingsKey] as {
    matcher?: string;
    hooks?: { type?: string; command?: string }[];
  }[];

  const expectedCmd = desc.plainCommand ? plainHookCommand(dest) : hookCommand(dest);

  const existing = entries.find((h) =>
    h.hooks?.some((hh) => hh.command?.includes(desc.scriptName)),
  );
  if (existing) {
    // Refresh command (e.g. after removing the obsolete {{tool_name}} template)
    // and matcher in case the schema changed between versions.
    existing.hooks = [{ type: 'command', command: expectedCmd }];
    if (desc.matcher) existing.matcher = desc.matcher;
    else delete existing.matcher;
    return;
  }

  const entry: Record<string, unknown> = {
    hooks: [{ type: 'command' as const, command: expectedCmd }],
  };
  if (desc.matcher) entry.matcher = desc.matcher;
  entries.push(entry as unknown as { hooks?: { command?: string }[] });
}

function removeHookEntry(settings: Record<string, unknown>, desc: HookDescriptor): void {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return;
  const entries = hooks[desc.settingsKey];
  if (!Array.isArray(entries)) return;

  hooks[desc.settingsKey] = entries.filter((h) => {
    const entry = h as { hooks?: { command?: string }[] };
    return !entry.hooks?.some((hh) => hh.command?.includes(desc.scriptName));
  });
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

    // Copy aux files (e.g. Windows .ps1 helper) into the same hooks dir.
    if (desc.auxFiles) {
      for (const aux of desc.auxFiles) {
        if (aux.platforms && !aux.platforms.includes(process.platform)) continue;
        const auxSrc = findAuxFile(aux.file);
        if (!auxSrc) continue; // soft-fail: main script still works, fallback path handles missing helper
        const auxDest = path.join(path.dirname(dest), aux.file);
        fs.copyFileSync(auxSrc, auxDest);
        if (!IS_WINDOWS) fs.chmodSync(auxDest, 0o644);
      }
    }

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

function uninstallHook(desc: HookDescriptor, opts: { global?: boolean }): InitStepResult {
  for (const client of CLIENTS) {
    const sPath = settingsPath(client, !!opts.global);
    if (fs.existsSync(sPath)) {
      const settings = readSettings(sPath);
      removeHookEntry(settings, desc);
      writeSettings(sPath, settings);
    }
    const dest = hookDest(client, desc);
    if (fs.existsSync(dest)) fs.unlinkSync(dest);

    // Remove aux files shipped alongside the main script.
    if (desc.auxFiles) {
      for (const aux of desc.auxFiles) {
        if (aux.platforms && !aux.platforms.includes(process.platform)) continue;
        const auxDest = path.join(path.dirname(dest), aux.file);
        if (fs.existsSync(auxDest)) fs.unlinkSync(auxDest);
      }
    }
  }

  return { target: hookDest(CLIENTS[0], desc), action: 'updated', detail: 'Removed' };
}

// --- Public API ---

export function installGuardHook(opts: { global?: boolean; dryRun?: boolean }): InitStepResult {
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

export function installReindexHook(opts: { global?: boolean; dryRun?: boolean }): InitStepResult {
  return installHook(REINDEX_HOOK, opts);
}

export function installPrecompactHook(opts: {
  global?: boolean;
  dryRun?: boolean;
}): InitStepResult {
  return installHook(PRECOMPACT_HOOK, opts);
}

function _uninstallPrecompactHook(opts: { global?: boolean }): InitStepResult {
  return uninstallHook(PRECOMPACT_HOOK, opts);
}

export function installWorktreeHook(opts: {
  global?: boolean;
  dryRun?: boolean;
}): InitStepResult[] {
  // Install both WorktreeCreate and WorktreeRemove — same script handles both events
  return [installHook(WORKTREE_HOOK, opts), installHook(WORKTREE_REMOVE_HOOK, opts)];
}

function _uninstallWorktreeHook(opts: { global?: boolean }): InitStepResult[] {
  return [uninstallHook(WORKTREE_HOOK, opts), uninstallHook(WORKTREE_REMOVE_HOOK, opts)];
}

/**
 * Legacy hook script names that past trace-mcp versions installed but the
 * current version no longer ships. init must clean these up so settings.json
 * doesn't accumulate orphaned entries pointing at unmanaged scripts (which
 * in turn means the {{tool_name}} template fix never reaches them).
 */
const LEGACY_HOOK_SCRIPTS = ['trace-mcp-precommit', 'trace-mcp-edit-guard'] as const;

const LEGACY_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'WorktreeCreate',
  'WorktreeRemove',
  'Stop',
  'Notification',
] as const;

export function cleanupLegacyHooks(opts: { global?: boolean; dryRun?: boolean }): InitStepResult[] {
  const results: InitStepResult[] = [];

  for (const client of CLIENTS) {
    if (!clientExists(client)) continue;
    const sPath = settingsPath(client, !!opts.global);
    if (!fs.existsSync(sPath)) continue;

    const settings = readSettings(sPath);
    const hooks = settings.hooks as Record<string, unknown[]> | undefined;

    let changed = false;
    const removedNames = new Set<string>();

    if (hooks) {
      for (const event of LEGACY_HOOK_EVENTS) {
        const entries = hooks[event];
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter((h) => {
          const entry = h as { hooks?: { command?: string }[] };
          const matches = entry.hooks?.some((hh) =>
            LEGACY_HOOK_SCRIPTS.some((name) => hh.command?.includes(name)),
          );
          if (matches) {
            for (const name of LEGACY_HOOK_SCRIPTS) {
              if (entry.hooks?.some((hh) => hh.command?.includes(name))) removedNames.add(name);
            }
          }
          return !matches;
        });
        if (filtered.length !== entries.length) {
          changed = true;
          if (filtered.length === 0) delete hooks[event];
          else hooks[event] = filtered;
        }
      }
      if (hooks && Object.keys(hooks).length === 0) delete settings.hooks;
    }

    if (changed && !opts.dryRun) writeSettings(sPath, settings);

    // Also delete the orphaned script files
    const hooksDir = path.join(HOME, client.hooksSubdir);
    for (const name of LEGACY_HOOK_SCRIPTS) {
      for (const ext of ['.sh', '.cmd', '.ps1']) {
        const scriptPath = path.join(hooksDir, `${name}${ext}`);
        if (fs.existsSync(scriptPath)) {
          if (!opts.dryRun) fs.unlinkSync(scriptPath);
          removedNames.add(name);
          changed = true;
        }
      }
    }

    if (changed) {
      results.push({
        target: sPath,
        action: 'updated',
        detail: `Removed legacy hooks: ${[...removedNames].join(', ')}`,
      });
    }
  }

  return results;
}
