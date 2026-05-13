/**
 * Audit AI agent config files for stale references, dead paths, token bloat,
 * scope leaks, and redundancy.
 *
 * Uses the symbol index for stale symbol detection + fuzzy search for suggestions.
 * Single-pass per file, no N+1: batch-collects references then validates.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fuzzySearch } from '../../db/fuzzy.js';
import type { Store } from '../../db/store.js';

interface AuditOptions {
  configFiles?: string[];
  fixSuggestions?: boolean;
  /**
   * E14 — opt into CLAUDE.md drift detection. Adds dead_tool_ref,
   * dead_skill_ref, dead_command_ref, and oversized_section categories on
   * top of the v1 issue set. Default false for back-compat.
   */
  includeDrift?: boolean;
  /**
   * E14 — restrict the output to drift-class categories only. Implies
   * includeDrift. Use when you only care about "what is broken in
   * agent-config" and want to skip stale_symbol/redundancy noise.
   */
  driftOnly?: boolean;
  /**
   * E14 — registered tool name set (typically populated from the live
   * MCP registry / preset info). When provided, enables dead_tool_ref
   * detection. Skipped silently when omitted.
   */
  registeredTools?: ReadonlySet<string>;
  /** E14 — registered CLI subcommand names (e.g. ["serve","add",...]). */
  registeredCliCommands?: ReadonlySet<string>;
  /** E14 — package.json scripts available (e.g. ["build","test"]). */
  pnpmScripts?: ReadonlySet<string>;
  /** E14 — installed skill names (resolved from ~/.claude/skills + project). */
  installedSkills?: ReadonlySet<string>;
}

type DriftCategory = 'dead_tool_ref' | 'dead_skill_ref' | 'dead_command_ref' | 'oversized_section';

interface AuditIssue {
  file: string;
  line?: number;
  issue: string;
  severity: 'warning' | 'error' | 'info';
  category: 'dead_path' | 'stale_symbol' | 'bloat' | 'scope_leak' | 'redundancy' | DriftCategory;
  fix?: string;
}

const DRIFT_CATEGORIES: ReadonlySet<AuditIssue['category']> = new Set<AuditIssue['category']>([
  'dead_path',
  'dead_tool_ref',
  'dead_skill_ref',
  'dead_command_ref',
  'oversized_section',
]);

interface AuditResult {
  files_scanned: number;
  total_tokens: number;
  issues: AuditIssue[];
  summary: string;
}

/** Known AI agent config file patterns */
const CONFIG_PATTERNS = [
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  '.cursorrules',
  '.cursor/rules',
  '.github/copilot-instructions.md',
  '.aider.conf.yml',
  '.continue/config.json',
  'cline_docs',
  '.windsurfrules',
  // Generic agent rules consumed by AMP, Warp, Factory Droid, Hermes
  'AGENTS.md',
  // Claw Code
  '.claw.json',
  '.claw/settings.json',
  '.claw/settings.local.json',
  // AMP
  '.amp/settings.json',
  '.amp/settings.jsonc',
  '.amp/AGENTS.md',
  // Factory Droid
  '.factory/mcp.json',
];

/** Global config locations */
const GLOBAL_CONFIG_PATTERNS = [
  '~/.claude/CLAUDE.md',
  '~/.claw/settings.json',
  '~/.config/amp/settings.json',
  '~/.config/amp/settings.jsonc',
  '~/.factory/mcp.json',
];

export function auditConfig(
  store: Store,
  projectRoot: string,
  options: AuditOptions = {},
): AuditResult {
  const { fixSuggestions = true } = options;
  const driftEnabled = options.driftOnly || options.includeDrift;
  const issues: AuditIssue[] = [];

  // Resolve skill directories once per call. We accept already-resolved sets
  // from the caller for testability, but fall back to a filesystem scan so
  // the function stays useful when called directly (not via MCP).
  const skillSet =
    options.installedSkills ?? (driftEnabled ? scanInstalledSkills(projectRoot) : undefined);

  // Find config files
  const configFiles = options.configFiles ?? findConfigFiles(projectRoot);
  let totalTokens = 0;

  // Read all files first (batch)
  const fileContents = new Map<string, { content: string; lines: string[] }>();
  for (const file of configFiles) {
    const absPath = resolveConfigPath(file, projectRoot);
    if (!fs.existsSync(absPath)) continue;

    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      fileContents.set(file, { content, lines: content.split('\n') });
      totalTokens += Math.ceil(content.length / 4);
    } catch {
      // Skip unreadable files
    }
  }

  for (const [file, { content, lines }] of fileContents) {
    // --- Dead file paths ---
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const pathMatches = line.match(
        /(?:src|lib|app|routes|tests?|components?|pages?)\/[\w/.-]+\.\w+/g,
      );
      if (pathMatches) {
        for (const ref of pathMatches) {
          const refPath = path.join(projectRoot, ref);
          if (!fs.existsSync(refPath) && !store.getFile(ref)) {
            issues.push({
              file,
              line: i + 1,
              category: 'dead_path',
              issue: `Dead path: \`${ref}\` — file does not exist`,
              severity: 'error',
              ...(fixSuggestions ? { fix: `Remove or update reference to ${ref}` } : {}),
            });
          }
        }
      }
    }

    // --- Stale symbol references ---
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // PascalCase symbols in backticks: `UserService`, `PaymentController`
      const symbolMatches = line.matchAll(/`([A-Z][a-zA-Z0-9]{2,}(?:\.[a-zA-Z][a-zA-Z0-9]*)*)`/g);
      for (const m of symbolMatches) {
        const name = m[1];
        if (name.includes('/') || name.endsWith('.md') || name.endsWith('.json')) continue;
        checkSymbol(store, name, file, i + 1, fixSuggestions, issues);
      }

      // camelCase function names in backticks: `getUserProfile()`, `processPayment`
      const funcMatches = line.matchAll(/`([a-z][a-zA-Z0-9]{3,})(?:\(\))?`/g);
      for (const m of funcMatches) {
        const name = m[1];
        const reserved = [
          'true',
          'false',
          'null',
          'undefined',
          'default',
          'string',
          'number',
          'boolean',
          'async',
          'await',
          'const',
          'function',
          'return',
          'import',
          'export',
        ];
        if (reserved.includes(name)) continue;
        checkSymbol(store, name, file, i + 1, fixSuggestions, issues);
      }
    }

    // --- Token bloat ---
    const fileTokens = Math.ceil(content.length / 4);
    if (fileTokens > 2000) {
      issues.push({
        file,
        category: 'bloat',
        issue: `${fileTokens} tokens — consider reducing below 2,000`,
        severity: 'warning',
        ...(fixSuggestions
          ? { fix: 'Trim redundant instructions or split into focused files' }
          : {}),
      });
    }

    // --- E14 — drift detection passes ---
    if (driftEnabled) {
      // 1) Dead MCP-tool references in backticks. Snake-case identifiers of
      //    length >= 4 inside backticks that don't match any registered tool.
      if (options.registeredTools && options.registeredTools.size > 0) {
        const seen = new Set<string>();
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const matches = line.matchAll(/`([a-z][a-z0-9_]{3,})`/g);
          for (const m of matches) {
            const name = m[1];
            // Only flag tokens that look like MCP tool names: snake_case
            // with at least one underscore, OR exact matches against an
            // existing registered tool (so we don't downgrade a real ref
            // to "missing" if the cache lacked it).
            if (!name.includes('_')) continue;
            if (options.registeredTools.has(name)) continue;
            const key = `${file}:${i + 1}:${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            issues.push({
              file,
              line: i + 1,
              category: 'dead_tool_ref',
              issue: `Dead MCP tool reference: \`${name}\` — not registered`,
              severity: 'warning',
              ...(fixSuggestions
                ? { fix: `Check the current trace-mcp tool list with get_preset_info` }
                : {}),
            });
          }
        }
      }

      // 2) Skill references. Lines mentioning `skills/<name>` (markdown
      //    links or plain paths). Flag if neither global nor project-local
      //    skill exists.
      if (skillSet !== undefined) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const matches = line.matchAll(/skills\/([a-zA-Z0-9_-]+)/g);
          for (const m of matches) {
            const skillName = m[1];
            if (skillSet.has(skillName)) continue;
            issues.push({
              file,
              line: i + 1,
              category: 'dead_skill_ref',
              issue: `Skill reference not installed: \`${skillName}\``,
              severity: 'warning',
              ...(fixSuggestions
                ? { fix: 'Install the skill or remove the reference (skills are user-scope)' }
                : {}),
            });
          }
        }
      }

      // 3) Command references. `trace-mcp <subcmd>` or `pnpm run <name>` or
      //    `pnpm <name>` inside backticks. Skipped when no command sets given.
      const cliSet = options.registeredCliCommands;
      const scriptSet = options.pnpmScripts;
      if ((cliSet && cliSet.size > 0) || (scriptSet && scriptSet.size > 0)) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (cliSet && cliSet.size > 0) {
            const matches = line.matchAll(/trace-mcp\s+([a-z][a-z0-9-]*)/g);
            for (const m of matches) {
              const cmd = m[1];
              if (cliSet.has(cmd)) continue;
              issues.push({
                file,
                line: i + 1,
                category: 'dead_command_ref',
                issue: `Dead CLI command: \`trace-mcp ${cmd}\` — not in CLI registry`,
                severity: 'warning',
              });
            }
          }
          if (scriptSet && scriptSet.size > 0) {
            const matches = line.matchAll(/pnpm(?:\s+run)?\s+([a-z][a-z0-9:_-]*)/g);
            for (const m of matches) {
              const script = m[1];
              if (script === 'run') continue; // tokens after "pnpm run"
              if (scriptSet.has(script)) continue;
              issues.push({
                file,
                line: i + 1,
                category: 'dead_command_ref',
                issue: `Dead pnpm script: \`pnpm ${script}\` — not in package.json scripts`,
                severity: 'warning',
              });
            }
          }
        }
      }

      // 4) Oversized H2 sections (>2000 tokens of content under a single
      //    "## " heading). Helps catch sections that have accumulated
      //    cruft and need to be split.
      const headerRe = /^##\s+(.+?)\s*$/;
      let sectionTitle: string | null = null;
      let sectionStart = 0;
      let sectionChars = 0;
      const flushSection = (endLine: number): void => {
        if (sectionTitle !== null && sectionChars > 0) {
          const sectionTokens = Math.ceil(sectionChars / 4);
          if (sectionTokens > 2000) {
            issues.push({
              file,
              line: sectionStart + 1,
              category: 'oversized_section',
              issue: `Section "${sectionTitle}" is ${sectionTokens} tokens — consider splitting`,
              severity: 'warning',
              ...(fixSuggestions
                ? { fix: 'Split the section into focused subsections, or trim examples' }
                : {}),
            });
          }
        }
        sectionTitle = null;
        sectionStart = endLine;
        sectionChars = 0;
      };
      for (let i = 0; i < lines.length; i++) {
        const hdr = lines[i].match(headerRe);
        if (hdr) {
          flushSection(i);
          sectionTitle = hdr[1];
          sectionStart = i;
          sectionChars = 0;
        } else if (sectionTitle !== null) {
          sectionChars += lines[i].length + 1;
        }
      }
      flushSection(lines.length);
    }

    // --- Scope leaks (project-specific paths in global config) ---
    if (isGlobalConfig(file)) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const absPathMatch = line.match(/\/(?:Users|home)\/[^\s`"']+/);
        if (absPathMatch) {
          issues.push({
            file,
            line: i + 1,
            category: 'scope_leak',
            issue: `Scope leak: absolute path \`${absPathMatch[0]}\` in global config`,
            severity: 'warning',
            ...(fixSuggestions
              ? { fix: 'Use relative paths or project-local config instead' }
              : {}),
          });
        }
      }
    }
  }

  // --- Redundancy between files ---
  if (fileContents.size > 1) {
    const entries = [...fileContents.entries()];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [fileA, { lines: linesA }] = entries[i];
        const [fileB, { lines: linesB }] = entries[j];
        const setB = new Set(linesB.map((l) => l.trim()).filter((l) => l.length > 30));
        for (let k = 0; k < linesA.length; k++) {
          const trimmed = linesA[k].trim();
          if (trimmed.length > 30 && setB.has(trimmed)) {
            issues.push({
              file: fileA,
              line: k + 1,
              category: 'redundancy',
              issue: `Duplicated in ${fileB}: "${trimmed.slice(0, 60)}..."`,
              severity: 'info',
            });
            break; // One per file pair
          }
        }
      }
    }
  }

  const filteredIssues = options.driftOnly
    ? issues.filter((i) => DRIFT_CATEGORIES.has(i.category))
    : issues;

  return {
    files_scanned: fileContents.size,
    total_tokens: totalTokens,
    issues: filteredIssues,
    summary:
      filteredIssues.length === 0
        ? 'No issues found'
        : `${filteredIssues.filter((i) => i.severity === 'error').length} errors, ${filteredIssues.filter((i) => i.severity === 'warning').length} warnings, ${filteredIssues.filter((i) => i.severity === 'info').length} info`,
  };
}

// ─── Helpers ──────────────────────────────────────────────

function checkSymbol(
  store: Store,
  name: string,
  file: string,
  line: number,
  fixSuggestions: boolean,
  issues: AuditIssue[],
): void {
  const sym = store.getSymbolByName(name);
  if (sym) return; // Found — not stale

  const issue: AuditIssue = {
    file,
    line,
    category: 'stale_symbol',
    issue: `Stale symbol: \`${name}\` — not found in index`,
    severity: 'warning',
  };

  if (fixSuggestions) {
    try {
      const matches = fuzzySearch(store.db, name, { limit: 1, threshold: 0.3, maxEditDistance: 3 });
      if (matches.length > 0) {
        const best = matches[0];
        const fileRow = store.getFileById(best.fileId);
        issue.fix = `Did you mean \`${best.name}\`?` + (fileRow ? ` (${fileRow.path})` : '');
      }
    } catch {
      // Fuzzy search may fail if trigram table empty — ignore
    }
  }

  issues.push(issue);
}

function findConfigFiles(projectRoot: string): string[] {
  const found: string[] = [];
  for (const pattern of CONFIG_PATTERNS) {
    const absPath = path.join(projectRoot, pattern);
    if (fs.existsSync(absPath)) found.push(pattern);
  }
  for (const pattern of GLOBAL_CONFIG_PATTERNS) {
    const absPath = pattern.replace('~', process.env.HOME ?? '');
    if (fs.existsSync(absPath)) found.push(pattern);
  }
  return found;
}

function resolveConfigPath(file: string, projectRoot: string): string {
  if (file.startsWith('~')) return file.replace('~', process.env.HOME ?? '');
  if (path.isAbsolute(file)) return file;
  return path.join(projectRoot, file);
}

function isGlobalConfig(file: string): boolean {
  return (
    file.startsWith('~') ||
    file.includes('.claude/CLAUDE.md') ||
    file.includes('.claw/settings.json')
  );
}

/**
 * E14 — enumerate installed Claude Code skills by scanning the conventional
 * locations: `~/.claude/skills/<name>/` and `<projectRoot>/.claude/skills/<name>/`.
 * Returns an empty set when neither directory exists.
 */
export function scanInstalledSkills(projectRoot: string): Set<string> {
  const skills = new Set<string>();
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', 'skills'),
    path.join(projectRoot, '.claude', 'skills'),
  ];
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) skills.add(entry.name);
      }
    } catch {
      // Ignore unreadable directories.
    }
  }
  return skills;
}

/**
 * E14 — read pnpm/npm script names from a project's package.json. Returns
 * an empty set on missing file or invalid JSON.
 */
export function scanPnpmScripts(projectRoot: string): Set<string> {
  const scripts = new Set<string>();
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return scripts;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.scripts ?? {})) scripts.add(name);
  } catch {
    // Bad JSON / IO error — return empty set silently.
  }
  return scripts;
}
