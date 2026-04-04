/**
 * CLAUDE.md tool routing block management.
 * Uses HTML comment markers for idempotent inject/update.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { InitStepResult } from './types.js';

const START_MARKER = '<!-- trace-mcp:start -->';
const END_MARKER = '<!-- trace-mcp:end -->';

const BLOCK = `${START_MARKER}
## trace-mcp Tool Routing

Use trace-mcp tools for code intelligence — they understand framework relationships, not just text.

| Task | trace-mcp tool | Instead of |
|------|---------------|------------|
| Find a function/class/method | \`search\` | Grep |
| Understand a file before editing | \`get_outline\` | Read (full file) |
| Read one symbol's source | \`get_symbol\` | Read (full file) |
| What breaks if I change X | \`get_change_impact\` | guessing |
| All usages of a symbol | \`find_usages\` | Grep |
| Context for a task | \`get_feature_context\` | reading 15 files |
| Tests for a symbol | \`get_tests_for\` | Glob + Grep |
| HTTP request flow | \`get_request_flow\` | reading route files |
| DB model relationships | \`get_model_context\` | reading model + migrations |

Use Read/Grep/Glob for non-code files (.md, .json, .yaml, config).
Start sessions with \`get_project_map\` (summary_only=true).
${END_MARKER}`;

export function updateClaudeMd(
  projectRoot: string,
  opts: { dryRun?: boolean; scope?: 'global' | 'project' },
): InitStepResult {
  const filePath = opts.scope === 'global'
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude', 'CLAUDE.md')
    : path.join(projectRoot, 'CLAUDE.md');

  if (opts.dryRun) {
    if (!fs.existsSync(filePath)) {
      return { target: filePath, action: 'skipped', detail: 'Would create CLAUDE.md' };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes(START_MARKER)) {
      return { target: filePath, action: 'skipped', detail: 'Would update trace-mcp block' };
    }
    return { target: filePath, action: 'skipped', detail: 'Would append trace-mcp block' };
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, BLOCK + '\n');
    return { target: filePath, action: 'created' };
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(START_MARKER)) {
    // Replace between markers
    const re = new RegExp(`${escapeRegex(START_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}`, 'm');
    const updated = content.replace(re, BLOCK);
    if (updated === content) {
      return { target: filePath, action: 'already_configured' };
    }
    fs.writeFileSync(filePath, updated);
    return { target: filePath, action: 'updated' };
  }

  // Append block
  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, content + separator + BLOCK + '\n');
  return { target: filePath, action: 'updated', detail: 'Appended trace-mcp block' };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
