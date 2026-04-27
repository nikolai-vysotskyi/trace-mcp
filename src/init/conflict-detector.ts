/**
 * Conflict detector: finds competing MCP servers, hooks, CLAUDE.md injections,
 * IDE rule files, and other artifacts that may interfere with trace-mcp.
 *
 * Known competitors: jcodemunch-mcp, aider, cline, repomix, code-index,
 * continue.dev, sourcegraph/cody, code-compass, repo-map, greptile.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConflictSeverity = 'critical' | 'warning' | 'info';

type ConflictCategory =
  | 'mcp_server' // Competing MCP server registered in client config
  | 'hook' // Competing PreToolUse / PostToolUse hooks
  | 'hook_script' // Physical hook script files on disk
  | 'claude_md' // Competing CLAUDE.md blocks / instructions
  | 'ide_rules' // .cursorrules, .windsurfrules, .clinerules with competing directives
  | 'config_file' // .jcodemunch.jsonc, .code-index/, etc.
  | 'global_artifact'; // ~/.code-index/ and similar global state

export interface Conflict {
  /** Unique identifier for deduplication (e.g. "mcp:jcodemunch:claude-code") */
  id: string;
  category: ConflictCategory;
  severity: ConflictSeverity;
  /** What was found */
  summary: string;
  /** Actionable detail */
  detail: string;
  /** Absolute path to the artifact (file, directory, or config entry) */
  target: string;
  /** The competing tool name */
  competitor: string;
  /** Regex pattern used to detect this conflict (for use by the resolver) */
  detectionPattern?: RegExp;
  /** Whether automatic fix is available */
  fixable: boolean;
}

interface ConflictReport {
  conflicts: Conflict[];
  scannedAt: string;
  projectRoot: string | null;
}

// ---------------------------------------------------------------------------
// Known competitors — patterns to detect
// ---------------------------------------------------------------------------

/** MCP server names that compete with trace-mcp for code intelligence. */
const COMPETING_MCP_SERVERS: Record<string, string> = {
  // jcodemunch / code-index family
  jcodemunch: 'jcodemunch-mcp',
  'jcodemunch-mcp': 'jcodemunch-mcp',
  'code-index': 'code-index',
  'code-index-mcp': 'code-index',
  // repomix — repo packing / context bundling
  repomix: 'repomix',
  'repomix-mcp': 'repomix',
  repopack: 'repomix',
  // aider
  aider: 'aider',
  'aider-mcp': 'aider',
  // sourcegraph / cody
  sourcegraph: 'sourcegraph',
  'sourcegraph-mcp': 'sourcegraph',
  cody: 'sourcegraph-cody',
  'cody-mcp': 'sourcegraph-cody',
  // generic code intelligence MCP servers
  'codebase-mcp': 'codebase-mcp',
  'code-compass': 'code-compass',
  'code-compass-mcp': 'code-compass',
  'repo-map': 'repo-map',
  'repo-map-mcp': 'repo-map',
  greptile: 'greptile',
  'greptile-mcp': 'greptile',
  codegraph: 'codegraph',
  'codegraph-mcp': 'codegraph',
  codesearch: 'codesearch',
  'codesearch-mcp': 'codesearch',
};

/** Hook script filename / command patterns from known competitors. */
const COMPETING_HOOK_PATTERNS: { pattern: RegExp; competitor: string }[] = [
  { pattern: /jcodemunch/i, competitor: 'jcodemunch-mcp' },
  { pattern: /code[_-]?index/i, competitor: 'code-index' },
  { pattern: /repomix/i, competitor: 'repomix' },
  { pattern: /repopack/i, competitor: 'repomix' },
  { pattern: /\baider\b/i, competitor: 'aider' },
  { pattern: /\bcody\b/i, competitor: 'sourcegraph-cody' },
  { pattern: /sourcegraph/i, competitor: 'sourcegraph' },
  { pattern: /greptile/i, competitor: 'greptile' },
  { pattern: /code[_-]?compass/i, competitor: 'code-compass' },
  { pattern: /repo[_-]?map/i, competitor: 'repo-map' },
];

/** CLAUDE.md content patterns that indicate competing tool injections. */
const COMPETING_CLAUDE_MD_PATTERNS: { pattern: RegExp; competitor: string; marker?: string }[] = [
  // jcodemunch — marker blocks
  {
    pattern: /<!-- ?jcodemunch:start ?-->/i,
    competitor: 'jcodemunch-mcp',
    marker: 'jcodemunch:start',
  },
  { pattern: /<!-- ?code-index:start ?-->/i, competitor: 'code-index', marker: 'code-index:start' },
  // jcodemunch — tool name references (distinctive API surface)
  { pattern: /jcodemunch|jCodeMunch/i, competitor: 'jcodemunch-mcp' },
  {
    pattern: /get_file_outline|get_symbol_source|get_context_bundle|get_ranked_context/i,
    competitor: 'jcodemunch-mcp',
  },
  {
    pattern: /embed_repo|get_blast_radius|get_session_stats|suggest_queries/i,
    competitor: 'jcodemunch-mcp',
  },
  // repomix
  { pattern: /<!-- ?repomix:start ?-->/i, competitor: 'repomix', marker: 'repomix:start' },
  { pattern: /repomix|repopack/i, competitor: 'repomix' },
  // aider
  { pattern: /<!-- ?aider:start ?-->/i, competitor: 'aider', marker: 'aider:start' },
  // cline
  { pattern: /<!-- ?cline:start ?-->/i, competitor: 'cline', marker: 'cline:start' },
  // sourcegraph/cody
  { pattern: /<!-- ?cody:start ?-->/i, competitor: 'sourcegraph-cody', marker: 'cody:start' },
  // greptile
  { pattern: /<!-- ?greptile:start ?-->/i, competitor: 'greptile', marker: 'greptile:start' },
];

/** Config files from competing tools at project root. */
const COMPETING_PROJECT_FILES: { file: string; competitor: string }[] = [
  // jcodemunch
  { file: '.jcodemunch.jsonc', competitor: 'jcodemunch-mcp' },
  { file: '.jcodemunch.json', competitor: 'jcodemunch-mcp' },
  { file: '.code-index.json', competitor: 'code-index' },
  { file: '.code-index.jsonc', competitor: 'code-index' },
  // aider (multiple config files)
  { file: '.aider.conf.yml', competitor: 'aider' },
  { file: '.aider.model.settings.yml', competitor: 'aider' },
  { file: '.aider.model.metadata.json', competitor: 'aider' },
  { file: '.aider.input.history', competitor: 'aider' },
  { file: '.aider.chat.history.md', competitor: 'aider' },
  { file: '.aider.tags.cache.v3', competitor: 'aider' },
  { file: '.aiderignore', competitor: 'aider' },
  // cline (file and directory)
  { file: '.clinerules', competitor: 'cline' },
  { file: '.cline', competitor: 'cline' },
  // repomix
  { file: 'repomix.config.json', competitor: 'repomix' },
  { file: '.repomix', competitor: 'repomix' },
  { file: 'repopack.config.json', competitor: 'repomix' },
  // continue.dev
  { file: '.continuerules', competitor: 'continue.dev' },
  // greptile
  { file: '.greptile.yml', competitor: 'greptile' },
  { file: '.greptile.yaml', competitor: 'greptile' },
];

/** Global directories from competing tools. */
const COMPETING_GLOBAL_DIRS: { dir: string; competitor: string }[] = [
  { dir: path.join(HOME, '.code-index'), competitor: 'jcodemunch-mcp' },
  { dir: path.join(HOME, '.repomix'), competitor: 'repomix' },
  { dir: path.join(HOME, '.aider.tags.cache.v3'), competitor: 'aider' },
];

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

export function detectConflicts(projectRoot?: string): ConflictReport {
  const conflicts: Conflict[] = [];

  // 1. Competing MCP servers in client configs
  conflicts.push(...scanMcpServerConfigs(projectRoot));

  // 2. Competing hooks in settings files
  conflicts.push(...scanHooksInSettings());

  // 3. Competing hook script files on disk
  conflicts.push(...scanHookScriptFiles());

  // 4. CLAUDE.md injections (global + project)
  conflicts.push(...scanClaudeMdFiles(projectRoot));

  // 5. IDE rules with competing directives
  conflicts.push(...scanIdeRuleFiles(projectRoot));

  // 6. Competing project config files
  if (projectRoot) {
    conflicts.push(...scanProjectConfigFiles(projectRoot));
  }

  // 7. Competing project directories
  if (projectRoot) {
    conflicts.push(...scanProjectConfigDirs(projectRoot));
  }

  // 8. Continue.dev MCP configs
  conflicts.push(...scanContinueConfigs(projectRoot));

  // 9. Aider git hooks
  if (projectRoot) {
    conflicts.push(...scanGitHooks(projectRoot));
  }

  // 10. Global artifacts (directories, caches)
  conflicts.push(...scanGlobalArtifacts());

  return {
    conflicts,
    scannedAt: new Date().toISOString(),
    projectRoot: projectRoot ?? null,
  };
}

// ---------------------------------------------------------------------------
// 1. MCP server configs
// ---------------------------------------------------------------------------

function scanMcpServerConfigs(projectRoot?: string): Conflict[] {
  const conflicts: Conflict[] = [];
  const configs = getMcpConfigPaths(projectRoot);

  for (const { clientName, configPath } of configs) {
    if (!fs.existsSync(configPath)) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      continue; // malformed JSON — not our problem here
    }

    const servers = (parsed.mcpServers ?? parsed.servers ?? {}) as Record<string, unknown>;
    for (const serverName of Object.keys(servers)) {
      const competitorName = COMPETING_MCP_SERVERS[serverName.toLowerCase()];
      if (!competitorName) continue;

      conflicts.push({
        id: `mcp:${serverName}:${clientName}:${configPath}`,
        category: 'mcp_server',
        severity: 'critical',
        summary: `Competing MCP server "${serverName}" registered in ${clientName}`,
        detail:
          `Server "${serverName}" (${competitorName}) is registered in ${shortPath(configPath)}. ` +
          `It provides overlapping code intelligence tools that will conflict with trace-mcp.`,
        target: configPath,
        competitor: competitorName,
        fixable: true,
      });
    }
  }

  return conflicts;
}

function getMcpConfigPaths(projectRoot?: string): { clientName: string; configPath: string }[] {
  const paths: { clientName: string; configPath: string }[] = [];
  const platform = os.platform();

  // Claude Code
  if (projectRoot) {
    paths.push({ clientName: 'claude-code', configPath: path.join(projectRoot, '.mcp.json') });
  }
  paths.push({ clientName: 'claude-code', configPath: path.join(HOME, '.claude.json') });
  paths.push({
    clientName: 'claude-code',
    configPath: path.join(HOME, '.claude', 'settings.json'),
  });

  // Claw Code
  if (projectRoot) {
    paths.push({ clientName: 'claw-code', configPath: path.join(projectRoot, '.claw.json') });
  }
  paths.push({ clientName: 'claw-code', configPath: path.join(HOME, '.claw', 'settings.json') });

  // Claude Desktop
  if (platform === 'darwin') {
    paths.push({
      clientName: 'claude-desktop',
      configPath: path.join(
        HOME,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      ),
    });
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming');
    paths.push({
      clientName: 'claude-desktop',
      configPath: path.join(appData, 'Claude', 'claude_desktop_config.json'),
    });
  }

  // Cursor
  paths.push({ clientName: 'cursor', configPath: path.join(HOME, '.cursor', 'mcp.json') });
  if (projectRoot) {
    paths.push({ clientName: 'cursor', configPath: path.join(projectRoot, '.cursor', 'mcp.json') });
  }

  // Windsurf
  paths.push({ clientName: 'windsurf', configPath: path.join(HOME, '.windsurf', 'mcp.json') });
  if (projectRoot) {
    paths.push({
      clientName: 'windsurf',
      configPath: path.join(projectRoot, '.windsurf', 'mcp.json'),
    });
  }

  // Continue
  paths.push({
    clientName: 'continue',
    configPath: path.join(HOME, '.continue', 'mcpServers', 'mcp.json'),
  });

  // Junie
  paths.push({ clientName: 'junie', configPath: path.join(HOME, '.junie', 'mcp', 'mcp.json') });
  if (projectRoot) {
    paths.push({
      clientName: 'junie',
      configPath: path.join(projectRoot, '.junie', 'mcp', 'mcp.json'),
    });
  }

  // Codex (TOML format — conflict scanner only checks for competing server names in JSON configs,
  // so we skip Codex here since its format differs)

  // AMP: scanner expects `mcpServers` key but AMP uses `amp.mcpServers`, so cross-tool
  // server-name collisions in AMP configs would be missed. Skipping for now keeps the
  // scanner consistent — AMP-specific conflicts surface during init writes instead.

  // Factory Droid
  paths.push({ clientName: 'factory-droid', configPath: path.join(HOME, '.factory', 'mcp.json') });
  if (projectRoot) {
    paths.push({
      clientName: 'factory-droid',
      configPath: path.join(projectRoot, '.factory', 'mcp.json'),
    });
  }

  // Warp: cloud-synced storage — no scannable file path.

  return paths;
}

// ---------------------------------------------------------------------------
// 2. Hooks in settings
// ---------------------------------------------------------------------------

function scanHooksInSettings(): Conflict[] {
  const conflicts: Conflict[] = [];
  const settingsFiles = [
    path.join(HOME, '.claude', 'settings.json'),
    path.join(HOME, '.claude', 'settings.local.json'),
    path.join(HOME, '.claw', 'settings.json'),
    path.join(HOME, '.claw', 'settings.local.json'),
  ];

  // Project-scoped settings in ~/.claude/projects/*/
  const projectsDir = path.join(HOME, '.claude', 'projects');
  if (fs.existsSync(projectsDir)) {
    try {
      for (const entry of fs.readdirSync(projectsDir)) {
        const projDir = path.join(projectsDir, entry);
        try {
          if (!fs.statSync(projDir).isDirectory()) continue;
        } catch {
          continue;
        }
        settingsFiles.push(path.join(projDir, 'settings.json'));
        settingsFiles.push(path.join(projDir, 'settings.local.json'));
      }
    } catch {
      /* ignore */
    }
  }

  for (const settingsPath of settingsFiles) {
    if (!fs.existsSync(settingsPath)) continue;

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      continue;
    }

    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    if (!hooks) continue;

    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;

      for (const entry of entries) {
        const hookDefs = (entry as { hooks?: { command?: string }[] }).hooks;
        if (!Array.isArray(hookDefs)) continue;

        for (let hi = 0; hi < hookDefs.length; hi++) {
          const cmd = hookDefs[hi].command ?? '';
          for (const { pattern, competitor } of COMPETING_HOOK_PATTERNS) {
            if (pattern.test(cmd)) {
              // Extract the most distinctive part of the command for ID uniqueness
              const scriptName =
                cmd
                  .split('/')
                  .pop()
                  ?.replace(/[^a-zA-Z0-9._-]/g, '') ?? `${hi}`;
              conflicts.push({
                id: `hook:${event}:${competitor}:${scriptName}`,
                category: 'hook',
                severity: 'critical',
                summary: `Competing ${event} hook from ${competitor}`,
                detail:
                  `Hook command "${truncate(cmd, 80)}" in ${shortPath(settingsPath)} ` +
                  `intercepts tool calls and may block or redirect trace-mcp operations.`,
                target: settingsPath,
                competitor,
                detectionPattern: pattern,
                fixable: true,
              });
            }
          }
        }
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// 3. Hook script files
// ---------------------------------------------------------------------------

function scanHookScriptFiles(): Conflict[] {
  const conflicts: Conflict[] = [];
  const hooksDirs = [path.join(HOME, '.claude', 'hooks'), path.join(HOME, '.claw', 'hooks')];

  for (const hooksDir of hooksDirs) {
    if (!fs.existsSync(hooksDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(hooksDir);
    } catch {
      continue;
    }

    for (const file of files) {
      // Skip our own hook
      if (file.startsWith('trace-mcp')) continue;

      for (const { pattern, competitor } of COMPETING_HOOK_PATTERNS) {
        if (pattern.test(file)) {
          const filePath = path.join(hooksDir, file);
          conflicts.push({
            id: `hook_script:${file}:${competitor}`,
            category: 'hook_script',
            severity: 'warning',
            summary: `Competing hook script: ${file}`,
            detail:
              `Hook script from ${competitor} at ${shortPath(filePath)}. ` +
              `Even if not registered in settings.json, it may be re-enabled later.`,
            target: filePath,
            competitor,
            detectionPattern: pattern,
            fixable: true,
          });
        }
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// 4. CLAUDE.md injections
// ---------------------------------------------------------------------------

function scanClaudeMdFiles(projectRoot?: string): Conflict[] {
  const conflicts: Conflict[] = [];
  const files = [path.join(HOME, '.claude', 'CLAUDE.md'), path.join(HOME, '.claude', 'AGENTS.md')];

  // Project-scoped CLAUDE.md files in ~/.claude/projects/*/
  const projectsDir = path.join(HOME, '.claude', 'projects');
  if (fs.existsSync(projectsDir)) {
    try {
      for (const entry of fs.readdirSync(projectsDir)) {
        const projDir = path.join(projectsDir, entry);
        if (!fs.statSync(projDir).isDirectory()) continue;
        files.push(path.join(projDir, 'CLAUDE.md'));
        files.push(path.join(projDir, 'AGENTS.md'));
        // Memory files
        const memDir = path.join(projDir, 'memory');
        if (fs.existsSync(memDir)) {
          try {
            for (const memFile of fs.readdirSync(memDir)) {
              if (memFile.endsWith('.md') && memFile !== 'MEMORY.md') {
                files.push(path.join(memDir, memFile));
              }
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (projectRoot) {
    files.push(path.join(projectRoot, 'CLAUDE.md'), path.join(projectRoot, 'AGENTS.md'));
  }

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const { pattern, competitor, marker } of COMPETING_CLAUDE_MD_PATTERNS) {
      if (pattern.test(content)) {
        const id = `claude_md:${competitor}:${filePath}`;
        // Avoid duplicate entries for same file+competitor
        if (conflicts.some((c) => c.id === id)) continue;

        // Fixable if we have markers OR if competitor name appears in a markdown heading
        const hasSection = hasCompetitorSection(content, competitor);

        conflicts.push({
          id,
          category: 'claude_md',
          severity: marker ? 'critical' : 'warning',
          summary: `${shortPath(filePath)} contains ${competitor} directives`,
          detail: marker
            ? `Found "${marker}" block marker. This injects competing tool routing instructions that override trace-mcp tools.`
            : hasSection
              ? `Found "${competitor}" section heading with tool routing instructions that override trace-mcp tools.`
              : `Found references to ${competitor} tools/APIs. These instructions may cause the AI to prefer competing tools over trace-mcp.`,
          target: filePath,
          competitor,
          fixable: !!marker || hasSection,
        });
      }
    }
  }

  return conflicts;
}

/** Check if content has a markdown heading containing the competitor name. */
function hasCompetitorSection(content: string, competitor: string): boolean {
  // Build patterns for the competitor and its common aliases
  const names = COMPETITOR_ALIASES[competitor] ?? [competitor.replace(/-mcp$/, '')];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headingPattern = new RegExp(`^#{1,6}\\s+.*${escaped}`, 'im');
    if (headingPattern.test(content)) return true;
  }
  return false;
}

/** Map competitor id → possible names that appear in headings. */
const COMPETITOR_ALIASES: Record<string, string[]> = {
  'jcodemunch-mcp': ['jcodemunch', 'jCodeMunch', 'code-index'],
  'code-index': ['code-index', 'codeindex'],
  repomix: ['repomix', 'repopack'],
  aider: ['aider'],
  cline: ['cline'],
  'sourcegraph-cody': ['cody', 'sourcegraph'],
  sourcegraph: ['sourcegraph'],
  greptile: ['greptile'],
  'code-compass': ['code-compass', 'codecompass'],
  'repo-map': ['repo-map', 'repomap'],
};

// ---------------------------------------------------------------------------
// 5. IDE rule files
// ---------------------------------------------------------------------------

function scanIdeRuleFiles(projectRoot?: string): Conflict[] {
  const conflicts: Conflict[] = [];

  const ruleFiles: { path: string; type: string }[] = [];

  // Global
  ruleFiles.push({ path: path.join(HOME, '.cursorrules'), type: '.cursorrules (global)' });
  ruleFiles.push({ path: path.join(HOME, '.windsurfrules'), type: '.windsurfrules (global)' });

  // Project
  if (projectRoot) {
    ruleFiles.push({ path: path.join(projectRoot, '.cursorrules'), type: '.cursorrules' });
    ruleFiles.push({ path: path.join(projectRoot, '.windsurfrules'), type: '.windsurfrules' });
    ruleFiles.push({ path: path.join(projectRoot, '.clinerules'), type: '.clinerules' });
    ruleFiles.push({ path: path.join(projectRoot, '.continuerules'), type: '.continuerules' });
    ruleFiles.push({
      path: path.join(projectRoot, '.github', 'copilot-instructions.md'),
      type: 'copilot-instructions.md',
    });

    // Scan .clinerules/ directory if it exists (Cline uses both file and dir)
    const clineRulesDir = path.join(projectRoot, '.clinerules');
    if (fs.existsSync(clineRulesDir)) {
      try {
        const stat = fs.statSync(clineRulesDir);
        if (stat.isDirectory()) {
          for (const file of fs.readdirSync(clineRulesDir)) {
            ruleFiles.push({ path: path.join(clineRulesDir, file), type: `.clinerules/${file}` });
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Also scan .cursor/rules/ for competing .mdc files
  const cursorRulesDirs = [path.join(HOME, '.cursor', 'rules')];
  if (projectRoot) cursorRulesDirs.push(path.join(projectRoot, '.cursor', 'rules'));

  for (const rulesDir of cursorRulesDirs) {
    if (!fs.existsSync(rulesDir)) continue;
    try {
      for (const file of fs.readdirSync(rulesDir)) {
        if (!file.endsWith('.mdc') || file === 'trace-mcp.mdc') continue;
        ruleFiles.push({ path: path.join(rulesDir, file), type: `.cursor/rules/${file}` });
      }
    } catch {
      /* ignore */
    }
  }

  for (const { path: filePath, type } of ruleFiles) {
    if (!fs.existsSync(filePath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const { pattern, competitor } of COMPETING_HOOK_PATTERNS) {
      if (pattern.test(content)) {
        conflicts.push({
          id: `ide_rules:${competitor}:${filePath}`,
          category: 'ide_rules',
          severity: 'warning',
          summary: `${type} contains ${competitor} directives`,
          detail:
            `IDE rule file ${shortPath(filePath)} references ${competitor}. ` +
            `This may cause the IDE agent to prefer competing tools.`,
          target: filePath,
          competitor,
          fixable: false, // IDE rules are too varied to auto-fix safely
        });
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// 6. Project config files
// ---------------------------------------------------------------------------

function scanProjectConfigFiles(projectRoot: string): Conflict[] {
  const conflicts: Conflict[] = [];

  for (const { file, competitor } of COMPETING_PROJECT_FILES) {
    const filePath = path.join(projectRoot, file);
    if (!fs.existsSync(filePath)) continue;

    conflicts.push({
      id: `config:${competitor}:${file}`,
      category: 'config_file',
      severity: 'info',
      summary: `Competing config: ${file}`,
      detail:
        `Project config file for ${competitor} found at ${shortPath(filePath)}. ` +
        `This won't directly conflict but indicates the project was used with a competing tool.`,
      target: filePath,
      competitor,
      fixable: true,
    });
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// 7. Competing project directories
// ---------------------------------------------------------------------------

function scanProjectConfigDirs(projectRoot: string): Conflict[] {
  const conflicts: Conflict[] = [];

  const dirs: { dir: string; competitor: string }[] = [
    { dir: '.clinerules', competitor: 'cline' },
    { dir: '.cline', competitor: 'cline' },
    { dir: '.aider.tags.cache.v3', competitor: 'aider' },
    { dir: '.continue', competitor: 'continue.dev' },
  ];

  for (const { dir, competitor } of dirs) {
    const fullPath = path.join(projectRoot, dir);
    if (!fs.existsSync(fullPath)) continue;

    // Only flag directories (files are handled by scanProjectConfigFiles)
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    conflicts.push({
      id: `config_dir:${competitor}:${dir}`,
      category: 'config_file',
      severity: competitor === 'continue.dev' ? 'info' : 'warning',
      summary: `Competing config directory: ${dir}/`,
      detail:
        `Config directory for ${competitor} found at ${shortPath(fullPath)}/. ` +
        `May contain rules or cache that influence AI behavior.`,
      target: fullPath,
      competitor,
      fixable: competitor !== 'continue.dev', // Don't auto-delete .continue/ — it has broader uses
    });
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// 8. Continue.dev MCP configs
// ---------------------------------------------------------------------------

function scanContinueConfigs(projectRoot?: string): Conflict[] {
  const conflicts: Conflict[] = [];

  // Global continue config may contain competing MCP servers
  const configPaths = [
    path.join(HOME, '.continue', 'config.yaml'),
    path.join(HOME, '.continue', 'config.json'),
  ];
  if (projectRoot) {
    configPaths.push(
      path.join(projectRoot, '.continue', 'config.yaml'),
      path.join(projectRoot, '.continue', 'config.json'),
    );
  }

  // Check mcpServers directory for competing server configs
  const mcpServersDirs = [path.join(HOME, '.continue', 'mcpServers')];
  if (projectRoot) {
    mcpServersDirs.push(path.join(projectRoot, '.continue', 'mcpServers'));
  }

  for (const mcpDir of mcpServersDirs) {
    if (!fs.existsSync(mcpDir)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(mcpDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(mcpDir, file);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      // Check if any competing server names appear in the config
      for (const [serverName, competitorName] of Object.entries(COMPETING_MCP_SERVERS)) {
        if (content.toLowerCase().includes(serverName)) {
          conflicts.push({
            id: `continue_mcp:${competitorName}:${filePath}`,
            category: 'mcp_server',
            severity: 'warning',
            summary: `Competing MCP server "${competitorName}" in Continue config`,
            detail: `Continue.dev MCP config ${shortPath(filePath)} references "${serverName}".`,
            target: filePath,
            competitor: competitorName,
            fixable: false, // YAML/complex JSON — too risky to auto-edit
          });
          break; // One finding per file is enough
        }
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// 9. Aider git hooks
// ---------------------------------------------------------------------------

function scanGitHooks(projectRoot: string): Conflict[] {
  const conflicts: Conflict[] = [];
  const hooksDir = path.join(projectRoot, '.git', 'hooks');

  if (!fs.existsSync(hooksDir)) return conflicts;

  // Aider is known to install pre-commit hooks
  const hookFiles = ['pre-commit', 'post-commit', 'prepare-commit-msg'];

  for (const hookFile of hookFiles) {
    const hookPath = path.join(hooksDir, hookFile);
    if (!fs.existsSync(hookPath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(hookPath, 'utf-8');
    } catch {
      continue;
    }

    if (/\baider\b/i.test(content)) {
      conflicts.push({
        id: `git_hook:aider:${hookFile}`,
        category: 'hook',
        severity: 'info',
        summary: `Git ${hookFile} hook references aider`,
        detail:
          `Git hook ${shortPath(hookPath)} contains aider references. ` +
          `This may modify commit messages or run aider operations on commit.`,
        target: hookPath,
        competitor: 'aider',
        fixable: false, // Git hooks are too dangerous to auto-modify
      });
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// 10. Global artifacts
// ---------------------------------------------------------------------------

function scanGlobalArtifacts(): Conflict[] {
  const conflicts: Conflict[] = [];

  for (const { dir, competitor } of COMPETING_GLOBAL_DIRS) {
    if (!fs.existsSync(dir)) continue;

    let size = 0;
    try {
      const files = fs.readdirSync(dir);
      size = files.length;
    } catch {
      /* ignore */
    }

    conflicts.push({
      id: `global:${competitor}:${dir}`,
      category: 'global_artifact',
      severity: 'info',
      summary: `Global cache: ${shortPath(dir)} (${size} files)`,
      detail:
        `Global index/cache directory from ${competitor}. ` +
        `Takes disk space but doesn't directly interfere at runtime.`,
      target: dir,
      competitor,
      fixable: true,
    });
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortPath(p: string): string {
  if (p.startsWith(HOME)) return `~${p.slice(HOME.length)}`;
  return p;
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}
