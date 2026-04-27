/**
 * Shared markdown routing-block writer used by both CLAUDE.md and AGENTS.md.
 *
 * The BLOCK content is the single source of truth for "how an AI agent should
 * route through trace-mcp". Anything that drifts between CLAUDE.md and
 * AGENTS.md is a bug — the block is authored here so both files stay in sync.
 *
 * File-I/O is intentionally kept here (not in the caller) so competitor
 * cleanup, marker handling, and whitespace normalization get the same
 * treatment regardless of which filename the block lands in.
 */
import fs from 'node:fs';
import type { InitStepResult } from './types.js';

export const START_MARKER = '<!-- trace-mcp:start -->';
export const END_MARKER = '<!-- trace-mcp:end -->';

/** Competing tools whose marker blocks should be removed on upsert. */
const COMPETING_MARKER_TOOLS = [
  'jcodemunch',
  'code-index',
  'repomix',
  'aider',
  'cline',
  'cody',
  'greptile',
  'sourcegraph',
  'code-compass',
  'repo-map',
];

export const TRACE_MCP_ROUTING_BLOCK = `${START_MARKER}
## trace-mcp Tool Routing

IMPORTANT: For ANY code exploration task, ALWAYS use trace-mcp tools first. NEVER use Read/Grep/Glob/Bash(ls,find) for navigating source code.

| Task | trace-mcp tool | Instead of |
|------|---------------|------------|
| Find a function/class/method | \`search\` | Grep |
| Understand a file before editing | \`get_outline\` | Read (full file) |
| Read one symbol's source | \`get_symbol\` | Read (full file) |
| What breaks if I change X | \`get_change_impact\` | guessing |
| All usages of a symbol | \`find_usages\` | Grep |
| All implementations of an interface | \`get_type_hierarchy\` | ls/find on directories |
| All classes implementing X | \`search\` with \`implements\` filter | Grep |
| Project health / coverage gaps | \`self_audit\` | manual inspection |
| Dead code / dead exports | \`get_dead_code\` / \`get_dead_exports\` | Grep for unused |
| Context for a task | \`get_feature_context\` | reading 15 files |
| Tests for a symbol | \`get_tests_for\` | Glob + Grep |
| Untested symbols (deep) | \`get_untested_symbols\` (classifies "unreached" vs "imported_not_called") | manual audit |
| HTTP request flow | \`get_request_flow\` | reading route files |
| DB model relationships | \`get_model_context\` | reading model + migrations |
| Component tree | \`get_component_tree\` | reading component files |
| Circular dependencies | \`get_circular_imports\` | manual tracing |

Use Read/Grep/Glob ONLY for non-code files (.md, .json, .yaml, config) or before Edit.
Start sessions with \`get_project_map\` (summary_only=true).
${END_MARKER}`;

/** Upsert the trace-mcp routing block into `filePath`. Idempotent. */
export function upsertTraceMcpBlock(
  filePath: string,
  opts: { dryRun?: boolean } = {},
): InitStepResult {
  if (opts.dryRun) {
    if (!fs.existsSync(filePath)) {
      return { target: filePath, action: 'skipped', detail: `Would create ${basename(filePath)}` };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes(START_MARKER)) {
      return { target: filePath, action: 'skipped', detail: 'Would update trace-mcp block' };
    }
    return { target: filePath, action: 'skipped', detail: 'Would append trace-mcp block' };
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, TRACE_MCP_ROUTING_BLOCK + '\n');
    return { target: filePath, action: 'created' };
  }

  let content = fs.readFileSync(filePath, 'utf-8');
  const originalContent = content;

  content = removeCompetingBlocks(content);

  if (content.includes(START_MARKER)) {
    const re = new RegExp(`${escapeRegex(START_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}`, 'm');
    content = content.replace(re, TRACE_MCP_ROUTING_BLOCK);
    content = cleanupWhitespace(content);
    if (content === originalContent) {
      return { target: filePath, action: 'already_configured' };
    }
    fs.writeFileSync(filePath, content);
    const cleaned = content !== removeCompetingBlocks(originalContent);
    return {
      target: filePath,
      action: 'updated',
      detail: cleaned ? 'Updated trace-mcp block and removed competing sections' : undefined,
    };
  }

  content = cleanupWhitespace(content);
  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, content + separator + TRACE_MCP_ROUTING_BLOCK + '\n');
  const cleaned = originalContent !== content;
  return {
    target: filePath,
    action: 'updated',
    detail: cleaned
      ? 'Appended trace-mcp block and removed competing sections'
      : 'Appended trace-mcp block',
  };
}

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

// ── Cleanup helpers (kept internal to this module) ──────────────────────

function removeCompetingBlocks(content: string): string {
  const markerPattern = new RegExp(
    `<!-- ?(${COMPETING_MARKER_TOOLS.join('|')}):start ?-->[\\s\\S]*?<!-- ?\\1:end ?-->\\n?`,
    'gi',
  );
  let result = content.replace(markerPattern, '');
  result = removeCompetingHeadingSections(result);
  result = removeOrphanedEndMarkers(result);
  result = removeOrphanedTraceMcpContent(result);
  return result;
}

function removeOrphanedEndMarkers(content: string): string {
  let result = content;
  while (result.includes(END_MARKER)) {
    const startIdx = result.indexOf(START_MARKER);
    const endIdx = result.indexOf(END_MARKER);
    if (endIdx !== -1 && (startIdx === -1 || endIdx < startIdx)) {
      result = result.slice(0, endIdx) + result.slice(endIdx + END_MARKER.length);
    } else {
      break;
    }
  }
  return result;
}

function removeOrphanedTraceMcpContent(content: string): string {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;
  const before = content.slice(0, startIdx);
  const markerBlock = content.slice(startIdx, endIdx + END_MARKER.length);
  const after = content.slice(endIdx + END_MARKER.length);
  const traceMcpHeadingRe = /^(#{1,6})\s+trace-mcp\b/i;
  const cleanBefore = filterSections(before.split('\n'), (heading) =>
    traceMcpHeadingRe.test(heading),
  ).join('\n');
  const cleanAfter = filterSections(after.split('\n'), (heading) =>
    traceMcpHeadingRe.test(heading),
  ).join('\n');
  return cleanBefore + markerBlock + cleanAfter;
}

function removeCompetingHeadingSections(content: string): string {
  const competitorNames = [
    'jcodemunch',
    'jCodeMunch',
    'code-index',
    'repomix',
    'repopack',
    'aider',
    'cline',
    'cody',
    'greptile',
    'sourcegraph',
    'code-compass',
    'repo-map',
  ];
  const competitorRe = new RegExp(`\\b(?:${competitorNames.join('|')})\\b`, 'i');
  const competingHeadingRe =
    /^(#{1,6})\s+(?:jCodeMunch|jcodemunch|code-index|repomix|aider|cline|cody|greptile|sourcegraph|code-compass|repo-map)\b/i;

  let lines = content.split('\n');
  lines = filterSections(lines, (headingLine) => competingHeadingRe.test(headingLine));
  lines = filterSections(lines, (headingLine, _level, body) => {
    if (/trace-mcp/i.test(headingLine)) return false;
    return competitorRe.test(body);
  });
  lines = removeEmptyParentSections(lines);
  lines = lines.filter((line) => {
    if (/^#{1,6}\s/.test(line)) return true;
    if (/^Two MCP tool sets are available/i.test(line.trim())) return false;
    return true;
  });
  return lines.join('\n');
}

function filterSections(
  lines: string[],
  shouldRemove: (heading: string, level: number, body: string) => boolean,
): string[] {
  const output: string[] = [];
  let skipping = false;
  let skipLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s/);
    if (skipping) {
      if (headingMatch && headingMatch[1].length <= skipLevel) {
        skipping = false;
      } else {
        continue;
      }
    }
    if (headingMatch) {
      const level = headingMatch[1].length;
      const body = lookAheadSection(lines, i + 1, level);
      if (shouldRemove(line, level, body)) {
        skipping = true;
        skipLevel = level;
        continue;
      }
    }
    output.push(line);
  }
  return output;
}

function removeEmptyParentSections(lines: string[]): string[] {
  const output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,6})\s/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const body = lookAheadSection(lines, i + 1, level);
      if (!body.trim()) continue;
    }
    output.push(lines[i]);
  }
  return output;
}

function lookAheadSection(lines: string[], start: number, level: number): string {
  const buf: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) break;
    buf.push(lines[i]);
  }
  return buf.join('\n');
}

function cleanupWhitespace(content: string): string {
  return content.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
