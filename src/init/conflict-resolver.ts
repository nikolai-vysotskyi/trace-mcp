/**
 * Conflict resolver: applies fixes to detected conflicts.
 * Each fix is atomic and idempotent — safe to run multiple times.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Conflict } from './conflict-detector.js';

export type FixAction = 'removed' | 'disabled' | 'cleaned' | 'skipped';

export interface FixResult {
  conflictId: string;
  action: FixAction;
  detail: string;
  target: string;
}

/**
 * Fix a single conflict. Returns the result of the fix attempt.
 * Only fixes conflicts where `fixable === true`.
 */
export function fixConflict(conflict: Conflict, opts: { dryRun?: boolean } = {}): FixResult {
  if (!conflict.fixable) {
    return {
      conflictId: conflict.id,
      action: 'skipped',
      detail: `Manual fix required: ${conflict.detail}`,
      target: conflict.target,
    };
  }

  switch (conflict.category) {
    case 'mcp_server':
      return fixMcpServer(conflict, opts);
    case 'hook':
      return fixHookInSettings(conflict, opts);
    case 'hook_script':
      return fixHookScript(conflict, opts);
    case 'claude_md':
      return fixClaudeMdBlock(conflict, opts);
    case 'config_file':
      return fixConfigFile(conflict, opts);
    case 'global_artifact':
      return fixGlobalArtifact(conflict, opts);
    default:
      return { conflictId: conflict.id, action: 'skipped', detail: 'No fix strategy for this category', target: conflict.target };
  }
}

/**
 * Fix all fixable conflicts. Returns results for each.
 */
export function fixAllConflicts(conflicts: Conflict[], opts: { dryRun?: boolean } = {}): FixResult[] {
  return conflicts
    .filter((c) => c.fixable)
    .map((c) => fixConflict(c, opts));
}

// ---------------------------------------------------------------------------
// Fix strategies
// ---------------------------------------------------------------------------

/**
 * Remove a competing MCP server entry from a client config file.
 */
function fixMcpServer(conflict: Conflict, opts: { dryRun?: boolean }): FixResult {
  const configPath = conflict.target;
  // Extract server name from conflict id: "mcp:<serverName>:<clientName>:<path>"
  const serverName = conflict.id.split(':')[1];

  if (opts.dryRun) {
    return { conflictId: conflict.id, action: 'removed', detail: `Would remove "${serverName}" from ${shortPath(configPath)}`, target: configPath };
  }

  if (!fs.existsSync(configPath)) {
    return { conflictId: conflict.id, action: 'skipped', detail: 'Config file no longer exists', target: configPath };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Handle both `mcpServers` and `servers` keys
    let removed = false;
    for (const key of ['mcpServers', 'servers']) {
      if (parsed[key] && parsed[key][serverName]) {
        delete parsed[key][serverName];
        removed = true;
      }
    }

    if (!removed) {
      return { conflictId: conflict.id, action: 'skipped', detail: `Server "${serverName}" not found (already removed?)`, target: configPath };
    }

    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n');
    return { conflictId: conflict.id, action: 'removed', detail: `Removed "${serverName}" from ${shortPath(configPath)}`, target: configPath };
  } catch (err) {
    return { conflictId: conflict.id, action: 'skipped', detail: `Failed to update config: ${(err as Error).message}`, target: configPath };
  }
}

/**
 * Remove competing hook entries from settings.json.
 */
function fixHookInSettings(conflict: Conflict, opts: { dryRun?: boolean }): FixResult {
  const settingsPath = conflict.target;
  const competitor = conflict.competitor;

  if (opts.dryRun) {
    return { conflictId: conflict.id, action: 'removed', detail: `Would remove ${competitor} hooks from ${shortPath(settingsPath)}`, target: settingsPath };
  }

  if (!fs.existsSync(settingsPath)) {
    return { conflictId: conflict.id, action: 'skipped', detail: 'Settings file no longer exists', target: settingsPath };
  }

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    if (!hooks) {
      return { conflictId: conflict.id, action: 'skipped', detail: 'No hooks section found', target: settingsPath };
    }

    let modified = false;
    const competitorPattern = new RegExp(competitor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;

      const filtered = entries.filter((entry) => {
        const hookDefs = (entry as { hooks?: { command?: string }[] }).hooks;
        if (!Array.isArray(hookDefs)) return true;
        return !hookDefs.some((h) => competitorPattern.test(h.command ?? ''));
      });

      if (filtered.length !== entries.length) {
        hooks[event] = filtered;
        modified = true;
      }

      // Clean up empty arrays
      if (Array.isArray(hooks[event]) && (hooks[event] as unknown[]).length === 0) {
        delete hooks[event];
      }
    }

    // Clean up empty hooks object
    if (Object.keys(hooks).length === 0) {
      delete settings.hooks;
    }

    if (!modified) {
      return { conflictId: conflict.id, action: 'skipped', detail: 'Hook entries already removed', target: settingsPath };
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { conflictId: conflict.id, action: 'removed', detail: `Removed ${competitor} hooks from ${shortPath(settingsPath)}`, target: settingsPath };
  } catch (err) {
    return { conflictId: conflict.id, action: 'skipped', detail: `Failed to update settings: ${(err as Error).message}`, target: settingsPath };
  }
}

/**
 * Remove a competing hook script file from ~/.claude/hooks/.
 */
function fixHookScript(conflict: Conflict, opts: { dryRun?: boolean }): FixResult {
  const scriptPath = conflict.target;

  if (opts.dryRun) {
    return { conflictId: conflict.id, action: 'removed', detail: `Would delete ${shortPath(scriptPath)}`, target: scriptPath };
  }

  if (!fs.existsSync(scriptPath)) {
    return { conflictId: conflict.id, action: 'skipped', detail: 'Script already removed', target: scriptPath };
  }

  try {
    fs.unlinkSync(scriptPath);
    return { conflictId: conflict.id, action: 'removed', detail: `Deleted ${shortPath(scriptPath)}`, target: scriptPath };
  } catch (err) {
    return { conflictId: conflict.id, action: 'skipped', detail: `Failed to delete: ${(err as Error).message}`, target: scriptPath };
  }
}

/**
 * Remove a competing block from CLAUDE.md (if markers are present).
 */
function fixClaudeMdBlock(conflict: Conflict, opts: { dryRun?: boolean }): FixResult {
  const filePath = conflict.target;

  if (opts.dryRun) {
    return { conflictId: conflict.id, action: 'cleaned', detail: `Would remove ${conflict.competitor} block from ${shortPath(filePath)}`, target: filePath };
  }

  if (!fs.existsSync(filePath)) {
    return { conflictId: conflict.id, action: 'skipped', detail: 'File no longer exists', target: filePath };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Try to find and remove marker-delimited blocks
    // Common patterns: <!-- tool:start --> ... <!-- tool:end -->
    const markerPatterns = [
      /<!-- ?jcodemunch:start ?-->[\s\S]*?<!-- ?jcodemunch:end ?-->\n?/gi,
      /<!-- ?code-index:start ?-->[\s\S]*?<!-- ?code-index:end ?-->\n?/gi,
      /<!-- ?repomix:start ?-->[\s\S]*?<!-- ?repomix:end ?-->\n?/gi,
      /<!-- ?aider:start ?-->[\s\S]*?<!-- ?aider:end ?-->\n?/gi,
      /<!-- ?cline:start ?-->[\s\S]*?<!-- ?cline:end ?-->\n?/gi,
      /<!-- ?cody:start ?-->[\s\S]*?<!-- ?cody:end ?-->\n?/gi,
      /<!-- ?greptile:start ?-->[\s\S]*?<!-- ?greptile:end ?-->\n?/gi,
      /<!-- ?sourcegraph:start ?-->[\s\S]*?<!-- ?sourcegraph:end ?-->\n?/gi,
      /<!-- ?code-compass:start ?-->[\s\S]*?<!-- ?code-compass:end ?-->\n?/gi,
      /<!-- ?repo-map:start ?-->[\s\S]*?<!-- ?repo-map:end ?-->\n?/gi,
    ];

    let updated = content;
    for (const pattern of markerPatterns) {
      updated = updated.replace(pattern, '');
    }

    // Clean up excessive blank lines left behind
    updated = updated.replace(/\n{3,}/g, '\n\n').trim() + '\n';

    if (updated === content) {
      return { conflictId: conflict.id, action: 'skipped', detail: 'No marker-delimited blocks found to remove', target: filePath };
    }

    fs.writeFileSync(filePath, updated);
    return { conflictId: conflict.id, action: 'cleaned', detail: `Removed ${conflict.competitor} block from ${shortPath(filePath)}`, target: filePath };
  } catch (err) {
    return { conflictId: conflict.id, action: 'skipped', detail: `Failed to update: ${(err as Error).message}`, target: filePath };
  }
}

/**
 * Remove a competing config file or directory from project root.
 */
function fixConfigFile(conflict: Conflict, opts: { dryRun?: boolean }): FixResult {
  const filePath = conflict.target;

  if (opts.dryRun) {
    return { conflictId: conflict.id, action: 'removed', detail: `Would delete ${shortPath(filePath)}`, target: filePath };
  }

  if (!fs.existsSync(filePath)) {
    return { conflictId: conflict.id, action: 'skipped', detail: 'Already removed', target: filePath };
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
    return { conflictId: conflict.id, action: 'removed', detail: `Deleted ${shortPath(filePath)}`, target: filePath };
  } catch (err) {
    return { conflictId: conflict.id, action: 'skipped', detail: `Failed to delete: ${(err as Error).message}`, target: filePath };
  }
}

/**
 * Remove a global artifact directory.
 */
function fixGlobalArtifact(conflict: Conflict, opts: { dryRun?: boolean }): FixResult {
  const dirPath = conflict.target;

  if (opts.dryRun) {
    return { conflictId: conflict.id, action: 'removed', detail: `Would remove ${shortPath(dirPath)}`, target: dirPath };
  }

  if (!fs.existsSync(dirPath)) {
    return { conflictId: conflict.id, action: 'skipped', detail: 'Directory already removed', target: dirPath };
  }

  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return { conflictId: conflict.id, action: 'removed', detail: `Removed ${shortPath(dirPath)}`, target: dirPath };
  } catch (err) {
    return { conflictId: conflict.id, action: 'skipped', detail: `Failed to remove: ${(err as Error).message}`, target: dirPath };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
