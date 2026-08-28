/**
 * IDE-specific rules file generation.
 * Writes tool routing policies into .cursor/rules/ and .windsurfrules
 * so that IDE agents always prefer trace-mcp tools over built-in search.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readIfExists } from '../utils/safe-fs.js';
import type { InitStepResult } from './types.js';

const START_MARKER = '<!-- trace-mcp:start -->';
const END_MARKER = '<!-- trace-mcp:end -->';

const TOOL_ROUTING_POLICY = `IMPORTANT: For ANY code exploration task, ALWAYS use trace-mcp tools first. NEVER use built-in search/grep/file listing for navigating source code.

## Tool Routing

| Task | trace-mcp tool | Instead of |
|------|---------------|------------|
| Find a function/class/method | \`search\` | built-in search / grep |
| Understand a file before editing | \`get_outline\` | reading full file |
| Read one symbol's source | \`get_symbol\` | reading full file |
| What breaks if I change X | \`get_change_impact\` | guessing |
| All usages of a symbol | \`find_usages\` | grep / find references |
| All implementations of an interface | \`get_type_hierarchy\` | listing directories |
| All classes implementing X | \`search\` with \`implements\` filter | grep |
| Project health / coverage gaps | \`self_audit\` | manual inspection |
| Dead code / dead exports | \`get_dead_code\` (\`mode: "exports_only"\`) | grep for unused |
| Context for a task | \`get_feature_context\` | reading many files |
| Tests for a symbol | \`get_tests_for\` | searching test files |
| HTTP request flow | \`get_request_flow\` | reading route files |
| DB model relationships | \`get_model_context\` | reading model + migration files |
| Component tree | \`get_component_tree\` | reading component files |
| Circular dependencies | \`get_circular_imports\` | manual tracing |

Start sessions with \`get_project_map\` (summary_only=true) to get project overview.
Use built-in file reading ONLY for non-code files (.md, .json, .yaml, config) or before editing.`;

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
  const existing = readIfExists(filePath);

  if (opts.dryRun) {
    if (existing !== null) {
      if (existing === CURSOR_RULE) {
        return { target: filePath, action: 'skipped', detail: 'Already up to date' };
      }
      return { target: filePath, action: 'skipped', detail: 'Would update trace-mcp.mdc' };
    }
    return { target: filePath, action: 'skipped', detail: 'Would create trace-mcp.mdc' };
  }

  if (existing !== null) {
    if (existing === CURSOR_RULE) {
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
  const existing = readIfExists(filePath);

  if (opts.dryRun) {
    if (existing === null) {
      return { target: filePath, action: 'skipped', detail: 'Would create .windsurfrules' };
    }
    if (existing.includes(START_MARKER)) {
      return { target: filePath, action: 'skipped', detail: 'Would update trace-mcp block' };
    }
    return { target: filePath, action: 'skipped', detail: 'Would append trace-mcp block' };
  }

  if (existing === null) {
    fs.writeFileSync(filePath, `${WINDSURF_BLOCK}\n`);
    return { target: filePath, action: 'created' };
  }

  if (existing.includes(START_MARKER)) {
    const re = new RegExp(`${escapeRegex(START_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}`, 'm');
    const updated = existing.replace(re, WINDSURF_BLOCK);
    if (updated === existing) {
      return { target: filePath, action: 'already_configured' };
    }
    fs.writeFileSync(filePath, updated);
    return { target: filePath, action: 'updated' };
  }

  // Append
  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, `${existing + separator + WINDSURF_BLOCK}\n`);
  return { target: filePath, action: 'updated', detail: 'Appended trace-mcp block' };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
