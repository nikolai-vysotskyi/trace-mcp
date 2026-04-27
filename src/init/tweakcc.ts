/**
 * tweakcc system prompt integration.
 * Writes trace-mcp routing prompts to tweakcc's system-prompts directory,
 * so Claude internalizes trace-mcp preferences from the start.
 *
 * @see https://github.com/Piebald-AI/tweakcc
 * @see docs/tweakcc.md
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import type { InitStepResult } from './types.js';

// ---------------------------------------------------------------------------
// tweakcc config directory detection (mirrors tweakcc's own logic)
// ---------------------------------------------------------------------------

const DEFAULT_TWEAKCC_DIR = path.join(os.homedir(), '.tweakcc');

function getTweakccConfigDir(): string | null {
  const envDir = process.env.TWEAKCC_CONFIG_DIR?.trim();
  if (envDir) return envDir;

  const candidates = [DEFAULT_TWEAKCC_DIR, path.join(os.homedir(), '.claude', 'tweakcc')];

  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) candidates.push(path.join(xdg, 'tweakcc'));

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }

  return null;
}

function getTweakccSystemPromptsDir(): string | null {
  const configDir = getTweakccConfigDir();
  if (!configDir) return null;
  return path.join(configDir, 'system-prompts');
}

/**
 * Resolve the target system-prompts dir, creating the default location on
 * demand when tweakcc hasn't been run yet. Returns null only if tweakcc is
 * not installed at all (npx can't find it).
 */
function resolveOrBootstrapPromptsDir(): string | null {
  const existing = getTweakccSystemPromptsDir();
  if (existing) return existing;

  // tweakcc config dir doesn't exist yet — try to bootstrap it at the default
  // location if the tweakcc package itself is available.
  if (!isTweakccInstalled()) return null;
  return path.join(DEFAULT_TWEAKCC_DIR, 'system-prompts');
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isTweakccInstalled(): boolean {
  try {
    execSync('npx tweakcc --version', { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return getTweakccConfigDir() !== null;
  }
}

export function detectTweakccPrompts(): {
  installed: boolean;
  promptsDir: string | null;
  hasOurPrompts: boolean;
} {
  const promptsDir = getTweakccSystemPromptsDir();
  if (!promptsDir || !fs.existsSync(promptsDir)) {
    return { installed: isTweakccInstalled(), promptsDir, hasOurPrompts: false };
  }

  // Check if any of our prompt files already exist
  const hasOurs = PROMPT_FILES.some((pf) => fs.existsSync(path.join(promptsDir, pf.filename)));

  return { installed: true, promptsDir, hasOurPrompts: hasOurs };
}

// ---------------------------------------------------------------------------
// Prompt file definitions — content from docs/tweakcc.md
// ---------------------------------------------------------------------------

interface PromptFile {
  filename: string;
  id: string;
  name: string;
  description: string;
  content: string;
}

const PROMPT_FILES: PromptFile[] = [
  {
    filename: 'tool-description-readfile.md',
    id: 'tool-description-readfile',
    name: 'Tool Description: ReadFile',
    description: 'Patched Read tool description that routes code reading through trace-mcp',
    content: `Before reading any source code file, call trace-mcp get_outline to see its
structure first. To read specific symbols, use get_symbol (by symbol_id or fqn)
or get_context_bundle (symbol + its imports, or batch multiple symbol_ids) instead
of reading the whole file. Use Read for non-code files (.md, .json, .yaml, .toml,
.env, .txt, .html, images, PDFs) and when you need complete file content before
editing with Edit/Write. Never use cat, head, tail, or sed to read any file.`,
  },
  {
    filename: 'tool-description-grep.md',
    id: 'tool-description-grep',
    name: 'Tool Description: Grep',
    description: 'Patched Grep tool description that routes code search through trace-mcp',
    content: `To search code by symbol name (function, class, method, variable), use trace-mcp
search — narrow with kind=, language=, file_pattern=, implements=, extends=.
Set fusion=true for best ranking (combines BM25, PageRank, embeddings, identity).
To search for strings, comments, TODOs, or patterns in source code, use trace-mcp
search_text (supports regex, context_lines for surrounding code). For semantic
usages (imports, calls, renders, dispatches), use find_usages. Use Grep only for
searching non-code file content (.md, .json, .yaml, .txt, .env, config files).
Never invoke grep or rg via Bash.`,
  },
  {
    filename: 'tool-description-glob.md',
    id: 'tool-description-glob',
    name: 'Tool Description: Glob',
    description: 'Patched Glob tool description that routes file search through trace-mcp',
    content: `To browse project structure, use trace-mcp get_project_map (summary_only for
overview, or full for detailed structure). To find symbols in specific paths, use
search with file_pattern= filter. To see what's in a specific file, use
get_outline. Use Glob only when finding non-code files by name pattern. Never use
find or ls via Bash for file discovery.`,
  },
  {
    filename: 'tool-description-bash.md',
    id: 'tool-description-bash',
    name: 'Tool Description: Bash',
    description: 'Patched Bash tool description that prevents code exploration via shell',
    content: `Reserve Bash exclusively for system commands and terminal operations: builds
(npm run build), tests (npm test, vitest, pytest), git commands, package managers,
docker, kubectl, and similar. Never use Bash for code exploration — do not run
grep, rg, find, cat, head, or tail on source code files through it. Use trace-mcp
MCP tools for all code reading and searching. If unsure whether a dedicated tool
exists, default to the dedicated tool.`,
  },
  {
    filename: 'system-prompt-tool-usage-direct-search.md',
    id: 'system-prompt-tool-usage-direct-search',
    name: 'System Prompt: Direct search routing',
    description: 'Routes directed codebase searches to trace-mcp search',
    content: `For directed codebase searches (finding a specific function, class, or method),
use trace-mcp search directly — it is faster and more precise than text search.
Narrow results with kind= (function, class, method, interface, type, variable),
language=, file_pattern=, implements=, extends=. For best ranking quality, set
fusion=true to enable Signal Fusion — multi-channel ranking that combines BM25
(lexical), PageRank (structural), embeddings (similarity), and exact/prefix match
(identity) via Weighted Reciprocal Rank fusion. For text pattern searches in
code, use trace-mcp search_text. Use native search tools only for non-code files.`,
  },
  {
    filename: 'system-prompt-tool-usage-delegate-exploration.md',
    id: 'system-prompt-tool-usage-delegate-exploration',
    name: 'System Prompt: Delegate exploration routing',
    description: 'Routes codebase exploration to trace-mcp instead of Agent(Explore)',
    content: `For broader codebase exploration, start with trace-mcp: get_project_map for
project overview, get_task_context for all-in-one task context (replaces manual
chaining of search → get_symbol → Read). When the project is unfamiliar, call
suggest_queries for orientation. Never spawn Agent(Explore) subagents for code
exploration — use get_task_context or get_feature_context instead (50x cheaper).
Agent subagents are only for: writing code in parallel, running tests, web research.`,
  },
  {
    filename: 'system-prompt-tool-usage-subagent-guidance.md',
    id: 'system-prompt-tool-usage-subagent-guidance',
    name: 'System Prompt: Subagent guidance',
    description: 'Prevents wasteful Agent(Explore) subagents for code exploration',
    content: `Use subagents only for tasks that require actual execution: writing code in
parallel (background workers), running tests, web/external research, or Plan mode.
Never use Agent(Explore) or Agent(general-purpose) for code exploration, review,
or analysis — each subprocess costs ~50K tokens in overhead. Instead use trace-mcp:
get_task_context (all-in-one task context), get_feature_context (NL query),
batch (multiple lookups in one call), find_usages, get_call_graph.`,
  },
  {
    filename: 'system-prompt-doing-tasks-read-first.md',
    id: 'system-prompt-doing-tasks-read-first',
    name: 'System Prompt: Read first via trace-mcp',
    description: 'Routes pre-edit code understanding through trace-mcp tools',
    content: `Do not propose changes to code you haven't understood. Before modifying code, use
trace-mcp to build context: get_outline to see the file's structure, get_symbol
or get_context_bundle to read the relevant symbols, and get_change_impact to
understand the blast radius. For complete task context in one call, use
get_task_context with a natural language description of your task.

Use batch to combine multiple independent trace-mcp calls into a single request
(e.g., get_outline for 3 files + search for a symbol).

For non-code files (.md, .json, .yaml, .toml, .env, .txt, .html), use Read
directly.`,
  },
];

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

function generateMarkdown(pf: PromptFile): string {
  return `<!--
name: "${pf.name}"
description: "${pf.description}"
ccVersion: "2.1"
-->
${pf.content}
`;
}

export function installTweakccPrompts(opts: { dryRun?: boolean }): InitStepResult[] {
  const results: InitStepResult[] = [];
  const promptsDir = resolveOrBootstrapPromptsDir();

  if (!promptsDir) {
    results.push({
      target: '~/.tweakcc/system-prompts/',
      action: 'skipped',
      detail: 'tweakcc package not available — run `npx tweakcc` manually, then re-run init',
    });
    return results;
  }

  if (opts.dryRun) {
    for (const pf of PROMPT_FILES) {
      results.push({
        target: path.join(promptsDir, pf.filename),
        action: 'created',
        detail: `Would write ${pf.id}`,
      });
    }
    results.push({
      target: 'tweakcc --apply',
      action: 'skipped',
      detail: 'Would run `npx tweakcc --apply` to patch Claude Code',
    });
    return results;
  }

  // Ensure system-prompts dir exists
  fs.mkdirSync(promptsDir, { recursive: true });

  let written = 0;
  for (const pf of PROMPT_FILES) {
    const filePath = path.join(promptsDir, pf.filename);
    const content = generateMarkdown(pf);
    const existed = fs.existsSync(filePath);
    fs.writeFileSync(filePath, content, 'utf-8');
    written++;
    results.push({
      target: filePath,
      action: existed ? 'updated' : 'created',
      detail: pf.id,
    });
  }

  // Try to apply via tweakcc
  if (written > 0) {
    try {
      execSync('npx tweakcc --apply', { stdio: 'pipe', timeout: 60_000 });
      results.push({
        target: 'tweakcc --apply',
        action: 'updated',
        detail: `Applied ${written} prompt rewrites to Claude Code`,
      });
    } catch {
      results.push({
        target: 'tweakcc --apply',
        action: 'skipped',
        detail:
          'Prompt files written but `npx tweakcc --apply` failed — run it manually (may need Claude Code not running)',
      });
    }
  }

  return results;
}

export function uninstallTweakccPrompts(opts: { dryRun?: boolean }): InitStepResult[] {
  const results: InitStepResult[] = [];
  const promptsDir = getTweakccSystemPromptsDir();
  if (!promptsDir) return results;

  for (const pf of PROMPT_FILES) {
    const filePath = path.join(promptsDir, pf.filename);
    if (fs.existsSync(filePath)) {
      if (!opts.dryRun) fs.unlinkSync(filePath);
      results.push({ target: filePath, action: 'updated', detail: `Removed ${pf.id}` });
    }
  }

  return results;
}
