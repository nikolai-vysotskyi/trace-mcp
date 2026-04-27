/**
 * Audit AI agent config files for stale references, dead paths, token bloat,
 * scope leaks, and redundancy.
 *
 * Uses the symbol index for stale symbol detection + fuzzy search for suggestions.
 * Single-pass per file, no N+1: batch-collects references then validates.
 */

import type { Store } from '../../db/store.js';
import { fuzzySearch } from '../../db/fuzzy.js';
import fs from 'node:fs';
import path from 'node:path';

interface AuditOptions {
  configFiles?: string[];
  fixSuggestions?: boolean;
}

interface AuditIssue {
  file: string;
  line?: number;
  issue: string;
  severity: 'warning' | 'error' | 'info';
  category: 'dead_path' | 'stale_symbol' | 'bloat' | 'scope_leak' | 'redundancy';
  fix?: string;
}

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
  const issues: AuditIssue[] = [];

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

  return {
    files_scanned: fileContents.size,
    total_tokens: totalTokens,
    issues,
    summary:
      issues.length === 0
        ? 'No issues found'
        : `${issues.filter((i) => i.severity === 'error').length} errors, ${issues.filter((i) => i.severity === 'warning').length} warnings, ${issues.filter((i) => i.severity === 'info').length} info`,
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
