/**
 * Guard hook installation and management.
 * Extracted from the setup-hooks CLI command for reuse by init/upgrade.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { InitStepResult } from './types.js';
import { GUARD_HOOK_VERSION, REINDEX_HOOK_VERSION } from './types.js';

const HOME = os.homedir();
const IS_WINDOWS = process.platform === 'win32';
const HOOK_EXT = IS_WINDOWS ? '.cmd' : '.sh';

/** Build the hook command string with inline env var — platform-aware. */
function hookCommand(hookPath: string): string {
  return IS_WINDOWS
    ? `cmd /c "set CLAUDE_TOOL_NAME={{tool_name}}&& "${hookPath}""`
    : `CLAUDE_TOOL_NAME={{tool_name}} ${hookPath}`;
}
const HOOK_DEST = path.join(HOME, '.claude', 'hooks', `trace-mcp-guard${HOOK_EXT}`);
const REINDEX_HOOK_DEST = path.join(HOME, '.claude', 'hooks', `trace-mcp-reindex${HOOK_EXT}`);
const CLAW_HOOK_DEST = path.join(HOME, '.claw', 'hooks', `trace-mcp-guard${HOOK_EXT}`);
const CLAW_REINDEX_HOOK_DEST = path.join(HOME, '.claw', 'hooks', `trace-mcp-reindex${HOOK_EXT}`);

/**
 * Get the path to the shipped hook script.
 * Works both in development (src/) and after build (dist/).
 */
function getHookSourcePath(): string {
  const filename = `trace-mcp-guard${HOOK_EXT}`;
  const candidates = [
    path.resolve(import.meta.dirname ?? '.', '..', '..', 'hooks', filename),
    path.resolve(process.cwd(), 'hooks', filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Could not find hooks/${filename} — trace-mcp installation may be corrupted.`);
}

export function installGuardHook(opts: {
  global?: boolean;
  dryRun?: boolean;
}): InitStepResult {
  const settingsPath = opts.global
    ? path.join(HOME, '.claude', 'settings.json')
    : path.resolve(process.cwd(), '.claude', 'settings.local.json');

  if (opts.dryRun) {
    return { target: HOOK_DEST, action: 'skipped', detail: 'Would install guard hook' };
  }

  const hookSrc = getHookSourcePath();

  // Copy hook script
  const hookDir = path.dirname(HOOK_DEST);
  if (!fs.existsSync(hookDir)) fs.mkdirSync(hookDir, { recursive: true });

  const isUpdate = fs.existsSync(HOOK_DEST);
  fs.copyFileSync(hookSrc, HOOK_DEST);
  if (!IS_WINDOWS) fs.chmodSync(HOOK_DEST, 0o755);

  // Update settings
  const settingsDir = path.dirname(settingsPath);
  if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });

  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    : {};
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  const hookEntry = {
    matcher: 'Read|Grep|Glob|Bash',
    hooks: [{
      type: 'command' as const,
      command: hookCommand(HOOK_DEST),
    }],
  };

  // Don't duplicate
  const existing = settings.hooks.PreToolUse.find(
    (h: { hooks?: { command?: string }[] }) =>
      h.hooks?.some((hh) => hh.command?.includes('trace-mcp-guard')),
  );
  if (!existing) {
    settings.hooks.PreToolUse.push(hookEntry);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // Also install for Claw Code if .claw/ directory exists
  const clawHome = path.join(HOME, '.claw');
  if (fs.existsSync(clawHome)) {
    const clawHookDir = path.dirname(CLAW_HOOK_DEST);
    if (!fs.existsSync(clawHookDir)) fs.mkdirSync(clawHookDir, { recursive: true });
    fs.copyFileSync(hookSrc, CLAW_HOOK_DEST);
    if (!IS_WINDOWS) fs.chmodSync(CLAW_HOOK_DEST, 0o755);

    const clawSettingsPath = opts.global
      ? path.join(clawHome, 'settings.json')
      : path.resolve(process.cwd(), '.claw', 'settings.local.json');
    const clawSettingsDir = path.dirname(clawSettingsPath);
    if (!fs.existsSync(clawSettingsDir)) fs.mkdirSync(clawSettingsDir, { recursive: true });
    const clawSettings = fs.existsSync(clawSettingsPath)
      ? JSON.parse(fs.readFileSync(clawSettingsPath, 'utf-8'))
      : {};
    if (!clawSettings.hooks) clawSettings.hooks = {};
    if (!clawSettings.hooks.PreToolUse) clawSettings.hooks.PreToolUse = [];
    const clawExisting = clawSettings.hooks.PreToolUse.find(
      (h: { hooks?: { command?: string }[] }) =>
        h.hooks?.some((hh) => hh.command?.includes('trace-mcp-guard')),
    );
    if (!clawExisting) {
      clawSettings.hooks.PreToolUse.push({
        matcher: 'Read|Grep|Glob|Bash',
        hooks: [{ type: 'command' as const, command: hookCommand(CLAW_HOOK_DEST) }],
      });
    }
    fs.writeFileSync(clawSettingsPath, JSON.stringify(clawSettings, null, 2) + '\n');
  }

  return {
    target: HOOK_DEST,
    action: isUpdate ? 'updated' : 'created',
    detail: `v${GUARD_HOOK_VERSION} → ${settingsPath}`,
  };
}

export function uninstallGuardHook(opts: { global?: boolean }): InitStepResult {
  const settingsPath = opts.global
    ? path.join(HOME, '.claude', 'settings.json')
    : path.resolve(process.cwd(), '.claude', 'settings.local.json');

  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const pre = settings.hooks?.PreToolUse;
    if (Array.isArray(pre)) {
      settings.hooks.PreToolUse = pre.filter(
        (h: { hooks?: { command?: string }[] }) =>
          !h.hooks?.some((hh) => hh.command?.includes('trace-mcp-guard')),
      );
      if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  }
  if (fs.existsSync(HOOK_DEST)) fs.unlinkSync(HOOK_DEST);

  // Also clean up Claw Code guard hook
  const clawSettingsPath = opts.global
    ? path.join(HOME, '.claw', 'settings.json')
    : path.resolve(process.cwd(), '.claw', 'settings.local.json');
  if (fs.existsSync(clawSettingsPath)) {
    const clawSettings = JSON.parse(fs.readFileSync(clawSettingsPath, 'utf-8'));
    const clawPre = clawSettings.hooks?.PreToolUse;
    if (Array.isArray(clawPre)) {
      clawSettings.hooks.PreToolUse = clawPre.filter(
        (h: { hooks?: { command?: string }[] }) =>
          !h.hooks?.some((hh) => hh.command?.includes('trace-mcp-guard')),
      );
      if (clawSettings.hooks.PreToolUse.length === 0) delete clawSettings.hooks.PreToolUse;
      if (clawSettings.hooks && Object.keys(clawSettings.hooks).length === 0) delete clawSettings.hooks;
      fs.writeFileSync(clawSettingsPath, JSON.stringify(clawSettings, null, 2) + '\n');
    }
  }
  if (fs.existsSync(CLAW_HOOK_DEST)) fs.unlinkSync(CLAW_HOOK_DEST);

  return { target: HOOK_DEST, action: 'updated', detail: 'Removed' };
}

/**
 * Check if the installed hook is outdated compared to shipped version.
 */
export function isHookOutdated(installedVersion: string | null): boolean {
  if (!installedVersion) return true;
  return installedVersion !== GUARD_HOOK_VERSION;
}

// --- PostToolUse auto-reindex hook ---

function getReindexHookSourcePath(): string {
  const filename = `trace-mcp-reindex${HOOK_EXT}`;
  const candidates = [
    path.resolve(import.meta.dirname ?? '.', '..', '..', 'hooks', filename),
    path.resolve(process.cwd(), 'hooks', filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Could not find hooks/${filename} — trace-mcp installation may be corrupted.`);
}

export function installReindexHook(opts: {
  global?: boolean;
  dryRun?: boolean;
}): InitStepResult {
  const settingsPath = opts.global
    ? path.join(HOME, '.claude', 'settings.json')
    : path.resolve(process.cwd(), '.claude', 'settings.local.json');

  if (opts.dryRun) {
    return { target: REINDEX_HOOK_DEST, action: 'skipped', detail: 'Would install reindex hook' };
  }

  const hookSrc = getReindexHookSourcePath();

  const hookDir = path.dirname(REINDEX_HOOK_DEST);
  if (!fs.existsSync(hookDir)) fs.mkdirSync(hookDir, { recursive: true });

  const isUpdate = fs.existsSync(REINDEX_HOOK_DEST);
  fs.copyFileSync(hookSrc, REINDEX_HOOK_DEST);
  if (!IS_WINDOWS) fs.chmodSync(REINDEX_HOOK_DEST, 0o755);

  const settingsDir = path.dirname(settingsPath);
  if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });

  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    : {};
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

  const hookEntry = {
    matcher: 'Edit|Write|MultiEdit',
    hooks: [{
      type: 'command' as const,
      command: hookCommand(REINDEX_HOOK_DEST),
    }],
  };

  // Don't duplicate
  const existing = settings.hooks.PostToolUse.find(
    (h: { hooks?: { command?: string }[] }) =>
      h.hooks?.some((hh) => hh.command?.includes('trace-mcp-reindex')),
  );
  if (!existing) {
    settings.hooks.PostToolUse.push(hookEntry);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // Also install for Claw Code if .claw/ directory exists
  const clawHome = path.join(HOME, '.claw');
  if (fs.existsSync(clawHome)) {
    const clawHookDir = path.dirname(CLAW_REINDEX_HOOK_DEST);
    if (!fs.existsSync(clawHookDir)) fs.mkdirSync(clawHookDir, { recursive: true });
    fs.copyFileSync(hookSrc, CLAW_REINDEX_HOOK_DEST);
    if (!IS_WINDOWS) fs.chmodSync(CLAW_REINDEX_HOOK_DEST, 0o755);

    const clawSettingsPath = opts.global
      ? path.join(clawHome, 'settings.json')
      : path.resolve(process.cwd(), '.claw', 'settings.local.json');
    const clawSettingsDir = path.dirname(clawSettingsPath);
    if (!fs.existsSync(clawSettingsDir)) fs.mkdirSync(clawSettingsDir, { recursive: true });
    const clawSettings = fs.existsSync(clawSettingsPath)
      ? JSON.parse(fs.readFileSync(clawSettingsPath, 'utf-8'))
      : {};
    if (!clawSettings.hooks) clawSettings.hooks = {};
    if (!clawSettings.hooks.PostToolUse) clawSettings.hooks.PostToolUse = [];
    const clawExisting = clawSettings.hooks.PostToolUse.find(
      (h: { hooks?: { command?: string }[] }) =>
        h.hooks?.some((hh) => hh.command?.includes('trace-mcp-reindex')),
    );
    if (!clawExisting) {
      clawSettings.hooks.PostToolUse.push({
        matcher: 'Edit|Write|MultiEdit',
        hooks: [{ type: 'command' as const, command: hookCommand(CLAW_REINDEX_HOOK_DEST) }],
      });
    }
    fs.writeFileSync(clawSettingsPath, JSON.stringify(clawSettings, null, 2) + '\n');
  }

  return {
    target: REINDEX_HOOK_DEST,
    action: isUpdate ? 'updated' : 'created',
    detail: `v${REINDEX_HOOK_VERSION} → ${settingsPath}`,
  };
}

export function uninstallReindexHook(opts: { global?: boolean }): InitStepResult {
  const settingsPath = opts.global
    ? path.join(HOME, '.claude', 'settings.json')
    : path.resolve(process.cwd(), '.claude', 'settings.local.json');

  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const post = settings.hooks?.PostToolUse;
    if (Array.isArray(post)) {
      settings.hooks.PostToolUse = post.filter(
        (h: { hooks?: { command?: string }[] }) =>
          !h.hooks?.some((hh) => hh.command?.includes('trace-mcp-reindex')),
      );
      if (settings.hooks.PostToolUse.length === 0) delete settings.hooks.PostToolUse;
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  }
  if (fs.existsSync(REINDEX_HOOK_DEST)) fs.unlinkSync(REINDEX_HOOK_DEST);

  // Also clean up Claw Code reindex hook
  const clawSettingsPath = opts.global
    ? path.join(HOME, '.claw', 'settings.json')
    : path.resolve(process.cwd(), '.claw', 'settings.local.json');
  if (fs.existsSync(clawSettingsPath)) {
    const clawSettings = JSON.parse(fs.readFileSync(clawSettingsPath, 'utf-8'));
    const clawPost = clawSettings.hooks?.PostToolUse;
    if (Array.isArray(clawPost)) {
      clawSettings.hooks.PostToolUse = clawPost.filter(
        (h: { hooks?: { command?: string }[] }) =>
          !h.hooks?.some((hh) => hh.command?.includes('trace-mcp-reindex')),
      );
      if (clawSettings.hooks.PostToolUse.length === 0) delete clawSettings.hooks.PostToolUse;
      if (clawSettings.hooks && Object.keys(clawSettings.hooks).length === 0) delete clawSettings.hooks;
      fs.writeFileSync(clawSettingsPath, JSON.stringify(clawSettings, null, 2) + '\n');
    }
  }
  if (fs.existsSync(CLAW_REINDEX_HOOK_DEST)) fs.unlinkSync(CLAW_REINDEX_HOOK_DEST);

  return { target: REINDEX_HOOK_DEST, action: 'updated', detail: 'Removed' };
}
