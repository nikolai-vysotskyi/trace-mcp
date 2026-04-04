/**
 * IDE-specific rules file generation.
 * Writes tool routing policies into .cursor/rules/ and .windsurfrules
 * so that IDE agents always prefer trace-mcp tools over built-in search.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { InitStepResult } from './types.js';

const START_MARKER = '<!-- trace-mcp:start -->';
const END_MARKER = '<!-- trace-mcp:end -->';

const TOOL_ROUTING_POLICY = `Use trace-mcp MCP tools for all code intelligence tasks — they understand framework relationships, not just text.

## Tool Routing

| Task | trace-mcp tool | Instead of |
|------|---------------|------------|
| Find a function/class/method | \`search\` | built-in search / grep |
| Understand a file before editing | \`get_outline\` | reading full file |
| Read one symbol's source | \`get_symbol\` | reading full file |
| What breaks if I change X | \`get_change_impact\` | guessing |
| All usages of a symbol | \`find_usages\` | grep / find references |
| Context for a task | \`get_feature_context\` | reading many files |
| Tests for a symbol | \`get_tests_for\` | searching test files |
| HTTP request flow | \`get_request_flow\` | reading route files |
| DB model relationships | \`get_model_context\` | reading model + migration files |

Start sessions with \`get_project_map\` (summary_only=true) to get project overview.
Use built-in file reading only for non-code files (.md, .json, .yaml, config).`;

// --- Cursor ---

const CURSOR_RULE = `---
description: trace-mcp tool routing — prefer trace-mcp MCP tools over built-in search for code intelligence
globs:
alwaysApply: true
---

${TOOL_ROUTING_POLICY}
`;

export function installCursorRules(
  projectRoot: string,
  opts: { dryRun?: boolean; global?: boolean },
): InitStepResult {
  const base = opts.global
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.cursor')
    : path.join(projectRoot, '.cursor');
  const rulesDir = path.join(base, 'rules');
  const filePath = path.join(rulesDir, 'trace-mcp.mdc');

  if (opts.dryRun) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content === CURSOR_RULE) {
        return { target: filePath, action: 'skipped', detail: 'Already up to date' };
      }
      return { target: filePath, action: 'skipped', detail: 'Would update trace-mcp.mdc' };
    }
    return { target: filePath, action: 'skipped', detail: 'Would create trace-mcp.mdc' };
  }

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content === CURSOR_RULE) {
      return { target: filePath, action: 'already_configured' };
    }
    fs.writeFileSync(filePath, CURSOR_RULE);
    return { target: filePath, action: 'updated' };
  }

  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(filePath, CURSOR_RULE);
  return { target: filePath, action: 'created' };
}

// --- Windsurf ---

const WINDSURF_BLOCK = `${START_MARKER}
## trace-mcp Tool Routing

${TOOL_ROUTING_POLICY}
${END_MARKER}`;

export function installWindsurfRules(
  projectRoot: string,
  opts: { dryRun?: boolean; global?: boolean },
): InitStepResult {
  const filePath = opts.global
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.windsurfrules')
    : path.join(projectRoot, '.windsurfrules');

  if (opts.dryRun) {
    if (!fs.existsSync(filePath)) {
      return { target: filePath, action: 'skipped', detail: 'Would create .windsurfrules' };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes(START_MARKER)) {
      return { target: filePath, action: 'skipped', detail: 'Would update trace-mcp block' };
    }
    return { target: filePath, action: 'skipped', detail: 'Would append trace-mcp block' };
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, WINDSURF_BLOCK + '\n');
    return { target: filePath, action: 'created' };
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(START_MARKER)) {
    const re = new RegExp(`${escapeRegex(START_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}`, 'm');
    const updated = content.replace(re, WINDSURF_BLOCK);
    if (updated === content) {
      return { target: filePath, action: 'already_configured' };
    }
    fs.writeFileSync(filePath, updated);
    return { target: filePath, action: 'updated' };
  }

  // Append
  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, content + separator + WINDSURF_BLOCK + '\n');
  return { target: filePath, action: 'updated', detail: 'Appended trace-mcp block' };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
