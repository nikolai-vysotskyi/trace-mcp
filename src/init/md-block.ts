/**
 * Shared markdown routing-block writer used by both CLAUDE.md and AGENTS.md.
 *
 * The BLOCK content is the single source of truth for "how an AI agent should
 * route through trace". Anything that drifts between CLAUDE.md and
 * AGENTS.md is a bug — the block is authored here so both files stay in sync.
 *
 * File-I/O is intentionally kept here (not in the caller) so competitor
 * cleanup, marker handling, and whitespace normalization get the same
 * treatment regardless of which filename the block lands in.
 */
import fs from 'node:fs';
import { readIfExists } from '../utils/safe-fs.js';
import type { InitStepResult } from './types.js';

export const START_MARKER = '<!-- trace:start -->';
export const LEGACY_START_MARKER = '<!-- trace-mcp:start -->';
export const END_MARKER = '<!-- trace:end -->';
export const LEGACY_END_MARKER = '<!-- trace-mcp:end -->';

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

/** Matches our own generated heading, current ("trace") and pre-TRA-611
 * ("trace-mcp") spellings — anchored to the exact heading text so it never
 * matches an unrelated user heading that merely starts with the word
 * "trace" (e.g. "## Trace logging policy"). */
const TRACE_HEADING_RE = /^#{1,6}\s+trace(?:-mcp)?\s+Tool Routing\b/i;

export const TRACE_ROUTING_BLOCK = `${START_MARKER}
## trace Tool Routing

IMPORTANT: For ANY code exploration task, ALWAYS use trace tools first. NEVER use Read/Grep/Glob/Bash(ls,find) for navigating source code.

| Task | trace tool | Instead of |
|------|------------|------------|
| Find a function/class/method | \`search\` | Grep |
| Understand a file before editing | \`get_outline\` | Read (full file) |
| Read one symbol's source | \`get_symbol\` | Read (full file) |
| What breaks if I change X | \`get_change_impact\` | guessing |
| All usages of a symbol | \`find_usages\` | Grep |
| All implementations of an interface | \`get_implementations\` | ls/find on directories |
| All classes implementing X | \`search\` with \`implements\` filter | Grep |
| Project health / coverage gaps | \`self_audit\` | manual inspection |
| Dead code / dead exports | \`get_dead_code\` (\`mode: "exports_only"\`) | Grep for unused |
| Context for a task | \`get_feature_context\` | reading 15 files |
| Tests for a symbol | \`get_tests_for\` | Glob + Grep |
| Untested symbols (deep) | \`get_untested_symbols\` (deferred — load via \`load_tools\`) | manual audit |
| HTTP request flow | \`get_request_flow\` (framework-gated) | reading route files |
| DB model relationships | \`get_model_context\` (framework-gated) | reading model + migrations |
| Component tree | \`get_component_tree\` (framework-gated) | reading component files |
| Circular dependencies | \`get_circular_imports\` | manual tracing |

Use Read/Grep/Glob ONLY for non-code files (.md, .json, .yaml, config) or before Edit.
Start sessions with \`get_project_map\` (summary_only=true).
${END_MARKER}`;

/** Backwards-compatible alias for legacy imports. */
export const TRACE_MCP_ROUTING_BLOCK = TRACE_ROUTING_BLOCK;

/** Upsert the trace routing block into `filePath`. Idempotent. */
export function upsertTraceMcpBlock(
  filePath: string,
  opts: { dryRun?: boolean } = {},
): InitStepResult {
  const existing = readIfExists(filePath);

  const hasAnyMarker =
    existing !== null &&
    (existing.includes(START_MARKER) || existing.includes(LEGACY_START_MARKER));

  if (opts.dryRun) {
    if (existing === null) {
      return { target: filePath, action: 'skipped', detail: `Would create ${basename(filePath)}` };
    }
    if (hasAnyMarker) {
      return { target: filePath, action: 'skipped', detail: 'Would update trace block' };
    }
    return { target: filePath, action: 'skipped', detail: 'Would append trace block' };
  }

  if (existing === null) {
    fs.writeFileSync(filePath, `${TRACE_ROUTING_BLOCK}\n`);
    return { target: filePath, action: 'created' };
  }

  let content = existing;
  const originalContent = content;

  content = removeCompetingBlocks(content);

  const markerRe = new RegExp(
    `(?:${escapeRegex(START_MARKER)}|${escapeRegex(LEGACY_START_MARKER)})[\\s\\S]*?(?:${escapeRegex(END_MARKER)}|${escapeRegex(LEGACY_END_MARKER)})`,
    'm',
  );

  if (markerRe.test(content)) {
    content = content.replace(markerRe, TRACE_ROUTING_BLOCK);
    content = cleanupWhitespace(content);
    if (content === originalContent) {
      return { target: filePath, action: 'already_configured' };
    }
    fs.writeFileSync(filePath, content);
    const cleaned = content !== removeCompetingBlocks(originalContent);
    return {
      target: filePath,
      action: 'updated',
      detail: cleaned ? 'Updated trace block and removed competing sections' : undefined,
    };
  }

  content = cleanupWhitespace(content);
  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, `${content + separator + TRACE_ROUTING_BLOCK}\n`);
  const cleaned = originalContent !== content;
  return {
    target: filePath,
    action: 'updated',
    detail: cleaned
      ? 'Appended trace block and removed competing sections'
      : 'Appended trace block',
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
  for (const endMarker of [END_MARKER, LEGACY_END_MARKER]) {
    while (result.includes(endMarker)) {
      const startIdxes = [START_MARKER, LEGACY_START_MARKER]
        .map((m) => result.indexOf(m))
        .filter((idx) => idx !== -1);
      const startIdx = startIdxes.length > 0 ? Math.min(...startIdxes) : -1;
      const endIdx = result.indexOf(endMarker);
      if (endIdx !== -1 && (startIdx === -1 || endIdx < startIdx)) {
        result = result.slice(0, endIdx) + result.slice(endIdx + endMarker.length);
      } else {
        break;
      }
    }
  }
  return result;
}

function removeOrphanedTraceMcpContent(content: string): string {
  const startItems = [START_MARKER, LEGACY_START_MARKER]
    .map((m) => ({ marker: m, idx: content.indexOf(m) }))
    .filter((x) => x.idx !== -1);
  const endItems = [END_MARKER, LEGACY_END_MARKER]
    .map((m) => ({ marker: m, idx: content.indexOf(m) }))
    .filter((x) => x.idx !== -1);

  if (startItems.length === 0 || endItems.length === 0) return content;
  startItems.sort((a, b) => a.idx - b.idx);
  endItems.sort((a, b) => a.idx - b.idx);
  const firstStart = startItems[0];
  const firstEnd = endItems[0];
  if (firstEnd.idx < firstStart.idx) return content;

  const before = content.slice(0, firstStart.idx);
  const markerBlock = content.slice(firstStart.idx, firstEnd.idx + firstEnd.marker.length);
  const after = content.slice(firstEnd.idx + firstEnd.marker.length);
  const cleanBefore = filterSections(before.split('\n'), (heading) =>
    TRACE_HEADING_RE.test(heading),
  ).join('\n');
  const cleanAfter = filterSections(after.split('\n'), (heading) =>
    TRACE_HEADING_RE.test(heading),
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
    if (TRACE_HEADING_RE.test(headingLine)) return false;
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
  return `${content.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
