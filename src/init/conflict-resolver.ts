/**
 * Conflict resolver: applies fixes to detected conflicts.
 * Each fix is atomic and idempotent — safe to run multiple times.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Conflict } from './conflict-detector.js';

type FixAction = 'removed' | 'disabled' | 'cleaned' | 'skipped';

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
 * Comment out a competing MCP server entry in a client config file (JSONC).
 * Uses line-level `//` comments so the user can easily re-enable if needed.
 */
function fixMcpServer(conflict: Conflict, opts: { dryRun?: boolean }): FixResult {
  const configPath = conflict.target;
  // Extract server name from conflict id: "mcp:<serverName>:<clientName>:<path>"
  const serverName = conflict.id.split(':')[1];

  if (opts.dryRun) {
    return { conflictId: conflict.id, action: 'disabled', detail: `Would comment out "${serverName}" in ${shortPath(configPath)}`, target: configPath };
  }

  if (!fs.existsSync(configPath)) {
    return { conflictId: conflict.id, action: 'skipped', detail: 'Config file no longer exists', target: configPath };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const result = commentOutJsonKey(raw, serverName);

    if (!result) {
      return { conflictId: conflict.id, action: 'skipped', detail: `Server "${serverName}" not found (already disabled?)`, target: configPath };
    }

    fs.writeFileSync(configPath, result);
    return { conflictId: conflict.id, action: 'disabled', detail: `Commented out "${serverName}" in ${shortPath(configPath)}`, target: configPath };
  } catch (err) {
    return { conflictId: conflict.id, action: 'skipped', detail: `Failed to update config: ${(err as Error).message}`, target: configPath };
  }
}

/**
 * Comment out a top-level key inside a JSON object using `//` line comments.
 * Finds `"key": <value>` (value may span multiple lines) and prefixes each line with `// `.
 * Returns the modified text, or null if the key was not found or already commented out.
 */
export function commentOutJsonKey(raw: string, key: string): string | null {
  const lines = raw.split('\n');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyPattern = new RegExp(`^(\\s*)"${escaped}"\\s*:`);

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    // Skip already-commented lines
    if (/^\s*\/\//.test(lines[i])) continue;
    if (keyPattern.test(lines[i])) {
      startLine = i;
      break;
    }
  }

  if (startLine === -1) return null;

  // Find the end of the value by tracking brace/bracket depth
  let endLine = startLine;
  let braceDepth = 0;
  let foundOpen = false;

  for (let i = startLine; i < lines.length; i++) {
    // Strip string literals to avoid counting braces inside strings
    const stripped = lines[i].replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const ch of stripped) {
      if (ch === '{' || ch === '[') { braceDepth++; foundOpen = true; }
      else if (ch === '}' || ch === ']') { braceDepth--; }
    }

    if (foundOpen && braceDepth <= 0) {
      endLine = i;
      break;
    }

    // Simple value on one line (string/number/bool) — no braces opened
    if (!foundOpen && i === startLine) {
      endLine = i;
      break;
    }
  }

  // Comment out lines [startLine..endLine]
  for (let i = startLine; i <= endLine; i++) {
    lines[i] = '// ' + lines[i];
  }

  return lines.join('\n');
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
    // Use the original detection regex when available; fall back to literal competitor name
    const competitorPattern = conflict.detectionPattern
      ?? new RegExp(competitor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

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
 * Remove competing content from CLAUDE.md / memory files.
 * Supports three strategies:
 * 1. Marker-delimited blocks: <!-- tool:start --> ... <!-- tool:end -->
 * 2. Markdown sections: headings containing competitor name → remove to next same-level heading
 * 3. Whole-file removal for memory files that are entirely about a competitor
 */
function fixClaudeMdBlock(conflict: Conflict, opts: { dryRun?: boolean }): FixResult {
  const filePath = conflict.target;

  if (opts.dryRun) {
    return { conflictId: conflict.id, action: 'cleaned', detail: `Would remove ${conflict.competitor} content from ${shortPath(filePath)}`, target: filePath };
  }

  if (!fs.existsSync(filePath)) {
    return { conflictId: conflict.id, action: 'skipped', detail: 'File no longer exists', target: filePath };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Strategy 1: Remove marker-delimited blocks: <!-- tool:start --> ... <!-- tool:end -->
    const tools = ['jcodemunch', 'code-index', 'repomix', 'aider', 'cline', 'cody', 'greptile', 'sourcegraph', 'code-compass', 'repo-map'];
    const markerPattern = new RegExp(
      `<!-- ?(${tools.join('|')}):start ?-->[\\s\\S]*?<!-- ?\\1:end ?-->\\n?`, 'gi',
    );

    let updated = content.replace(markerPattern, '');

    // Strategy 2: Remove markdown sections whose heading contains the competitor name
    updated = removeCompetitorSections(updated, conflict.competitor);

    // Strategy 3: For memory files — if the entire file is about the competitor, delete it
    if (filePath.includes('/memory/') && isEntirelyAboutCompetitor(updated, conflict.competitor)) {
      fs.unlinkSync(filePath);
      // Also remove from MEMORY.md index if present
      removeFromMemoryIndex(filePath);
      return { conflictId: conflict.id, action: 'removed', detail: `Deleted memory file ${shortPath(filePath)}`, target: filePath };
    }

    // Clean up excessive blank lines left behind
    updated = updated.replace(/\n{3,}/g, '\n\n').trim() + '\n';

    if (updated === content) {
      return { conflictId: conflict.id, action: 'skipped', detail: 'No competing content found to remove', target: filePath };
    }

    fs.writeFileSync(filePath, updated);
    return { conflictId: conflict.id, action: 'cleaned', detail: `Removed ${conflict.competitor} content from ${shortPath(filePath)}`, target: filePath };
  } catch (err) {
    return { conflictId: conflict.id, action: 'skipped', detail: `Failed to update: ${(err as Error).message}`, target: filePath };
  }
}

/** Competitor name → aliases that may appear in headings. */
const COMPETITOR_HEADING_NAMES: Record<string, string[]> = {
  'jcodemunch-mcp': ['jcodemunch', 'jCodeMunch', 'code-index'],
  'code-index': ['code-index', 'codeindex'],
  'repomix': ['repomix', 'repopack'],
  'aider': ['aider'],
  'cline': ['cline'],
  'sourcegraph-cody': ['cody', 'sourcegraph'],
  'sourcegraph': ['sourcegraph'],
  'greptile': ['greptile'],
  'code-compass': ['code-compass', 'codecompass'],
  'repo-map': ['repo-map', 'repomap'],
};

/**
 * Remove markdown sections whose heading contains the competitor name.
 * A section starts at `# Heading` and ends at the next heading of the same or higher level.
 */
function removeCompetitorSections(content: string, competitor: string): string {
  const names = COMPETITOR_HEADING_NAMES[competitor] ?? [competitor.replace(/-mcp$/, '')];
  const lines = content.split('\n');
  const linesToRemove = new Set<number>();

  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headingRe = new RegExp(`^(#{1,6})\\s+.*${escaped}`, 'i');

    for (let i = 0; i < lines.length; i++) {
      const match = headingRe.exec(lines[i]);
      if (!match) continue;

      const level = match[1].length; // number of '#' chars
      // Mark this heading and everything until the next heading of same or higher level
      linesToRemove.add(i);
      for (let j = i + 1; j < lines.length; j++) {
        const nextHeading = /^(#{1,6})\s+/.exec(lines[j]);
        if (nextHeading && nextHeading[1].length <= level) break;
        linesToRemove.add(j);
      }
    }
  }

  if (linesToRemove.size === 0) return content;

  return lines.filter((_, i) => !linesToRemove.has(i)).join('\n');
}

/**
 * Check if the remaining content of a memory file is entirely about a competitor.
 * Used to decide whether to delete the whole file vs. just clean sections.
 */
function isEntirelyAboutCompetitor(content: string, competitor: string): boolean {
  // Strip frontmatter
  const stripped = content.replace(/^---[\s\S]*?---\s*/, '').trim();
  if (!stripped) return true; // empty after stripping → delete

  const names = COMPETITOR_HEADING_NAMES[competitor] ?? [competitor.replace(/-mcp$/, '')];
  for (const name of names) {
    if (stripped.toLowerCase().includes(name.toLowerCase())) return true;
  }
  return false;
}

/**
 * Remove the entry for a deleted memory file from the MEMORY.md index.
 */
function removeFromMemoryIndex(deletedFilePath: string): void {
  const memoryDir = path.dirname(deletedFilePath);
  const indexPath = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) return;

  try {
    const content = fs.readFileSync(indexPath, 'utf-8');
    const fileName = path.basename(deletedFilePath);
    const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Remove lines that reference this file (e.g. "- [Title](filename.md) — description")
    const updated = content
      .split('\n')
      .filter((line) => !new RegExp(`\\(${escaped}\\)`).test(line))
      .join('\n');

    if (updated !== content) {
      fs.writeFileSync(indexPath, updated);
    }
  } catch { /* best-effort */ }
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
