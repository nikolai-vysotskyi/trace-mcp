/**
 * Guard hook installation and management.
 * Extracted from the setup-hooks CLI command for reuse by init/upgrade.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { InitStepResult } from './types.js';
import { GUARD_HOOK_VERSION } from './types.js';

const HOME = os.homedir();
const HOOK_DEST = path.join(HOME, '.claude', 'hooks', 'trace-mcp-guard.sh');

/**
 * Get the path to the shipped hook script.
 * Works both in development (src/) and after build (dist/).
 */
function getHookSourcePath(): string {
  // In built version: dist/init/hooks.js → ../../hooks/trace-mcp-guard.sh
  // In source: src/init/hooks.ts → ../../hooks/trace-mcp-guard.sh
  const candidates = [
    path.resolve(import.meta.dirname ?? '.', '..', '..', 'hooks', 'trace-mcp-guard.sh'),
    path.resolve(process.cwd(), 'hooks', 'trace-mcp-guard.sh'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Could not find hooks/trace-mcp-guard.sh — trace-mcp installation may be corrupted.');
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
  fs.chmodSync(HOOK_DEST, 0o755);

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
      command: `CLAUDE_TOOL_NAME={{tool_name}} ${HOOK_DEST}`,
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

  return { target: HOOK_DEST, action: 'updated', detail: 'Removed' };
}

/**
 * Check if the installed hook is outdated compared to shipped version.
 */
export function isHookOutdated(installedVersion: string | null): boolean {
  if (!installedVersion) return true;
  return installedVersion !== GUARD_HOOK_VERSION;
}
