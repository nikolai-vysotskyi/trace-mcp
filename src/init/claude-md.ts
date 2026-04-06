/**
 * CLAUDE.md tool routing block management.
 * Uses HTML comment markers for idempotent inject/update.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { InitStepResult } from './types.js';

const START_MARKER = '<!-- trace-mcp:start -->';
const END_MARKER = '<!-- trace-mcp:end -->';

/** Competing tools whose marker blocks should be removed. */
const COMPETING_MARKER_TOOLS = ['jcodemunch', 'code-index', 'repomix', 'aider', 'cline', 'cody', 'greptile', 'sourcegraph', 'code-compass', 'repo-map'];


const BLOCK = `${START_MARKER}
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
| HTTP request flow | \`get_request_flow\` | reading route files |
| DB model relationships | \`get_model_context\` | reading model + migrations |
| Component tree | \`get_component_tree\` | reading component files |
| Circular dependencies | \`get_circular_imports\` | manual tracing |

Use Read/Grep/Glob ONLY for non-code files (.md, .json, .yaml, config) or before Edit.
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

  let content = fs.readFileSync(filePath, 'utf-8');
  const originalContent = content;

  // --- Remove competing tool blocks ---
  content = removeCompetingBlocks(content);

  if (content.includes(START_MARKER)) {
    // Replace between markers
    const re = new RegExp(`${escapeRegex(START_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}`, 'm');
    content = content.replace(re, BLOCK);
    content = cleanupWhitespace(content);
    if (content === originalContent) {
      return { target: filePath, action: 'already_configured' };
    }
    fs.writeFileSync(filePath, content);
    const cleaned = content !== removeCompetingBlocks(originalContent);
    return { target: filePath, action: 'updated', detail: cleaned ? 'Updated trace-mcp block and removed competing sections' : undefined };
  }

  // Append block
  content = cleanupWhitespace(content);
  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, content + separator + BLOCK + '\n');
  const cleaned = originalContent !== content;
  return { target: filePath, action: 'updated', detail: cleaned ? 'Appended trace-mcp block and removed competing sections' : 'Appended trace-mcp block' };
}

/**
 * Remove competing tool sections from CLAUDE.md content:
 * 1. Marker-delimited blocks (<!-- tool:start -->...<!-- tool:end -->)
 * 2. Heading-based sections (### jCodeMunch, ### Decision matrix with jCodeMunch refs)
 * 3. Preamble text that references competing tools above the first heading
 */
function removeCompetingBlocks(content: string): string {
  // 1. Remove marker-delimited blocks from competing tools
  const markerPattern = new RegExp(
    `<!-- ?(${COMPETING_MARKER_TOOLS.join('|')}):start ?-->[\\s\\S]*?<!-- ?\\1:end ?-->\\n?`, 'gi',
  );
  let result = content.replace(markerPattern, '');

  // 2. Remove heading-based sections by walking lines
  result = removeCompetingHeadingSections(result);

  // 3. Clean up orphaned end markers (end without matching start)
  // Must run before step 4 so removeOrphanedTraceMcpContent can find the correct marker pair
  result = removeOrphanedEndMarkers(result);

  // 4. Remove stale trace-mcp content outside marker block (orphaned duplicates)
  result = removeOrphanedTraceMcpContent(result);

  return result;
}

/**
 * Remove orphaned <!-- trace-mcp:end --> markers that appear without a matching start marker.
 */
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

/**
 * Remove any "## trace-mcp Tool Routing" section that exists OUTSIDE
 * the <!-- trace-mcp:start/end --> markers. This handles orphaned duplicates
 * left by previous broken cleanup runs.
 */
function removeOrphanedTraceMcpContent(content: string): string {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  // Only relevant if we have a proper marker block
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;

  // Split into: before markers, marker block, after markers
  const before = content.slice(0, startIdx);
  const markerBlock = content.slice(startIdx, endIdx + END_MARKER.length);
  const after = content.slice(endIdx + END_MARKER.length);

  // Remove trace-mcp heading sections from before and after
  const traceMcpHeadingRe = /^(#{1,6})\s+trace-mcp\b/i;
  const cleanBefore = filterSections(before.split('\n'), (heading) => traceMcpHeadingRe.test(heading)).join('\n');
  const cleanAfter = filterSections(after.split('\n'), (heading) => traceMcpHeadingRe.test(heading)).join('\n');

  return cleanBefore + markerBlock + cleanAfter;
}

/**
 * Remove heading sections whose title or body references competing tools.
 * A section starts at a heading and ends just before the next heading of same or higher level.
 *
 * Three-pass approach:
 * 1. Remove sections with competing tool names in the heading
 * 2. Remove sections whose body references competing tools (not trace-mcp's own)
 * 3. Remove parent headings that became empty after subsection removal
 */
function removeCompetingHeadingSections(content: string): string {
  const competitorNames = ['jcodemunch', 'jCodeMunch', 'code-index', 'repomix', 'repopack', 'aider', 'cline', 'cody', 'greptile', 'sourcegraph', 'code-compass', 'repo-map'];
  const competitorRe = new RegExp(`\\b(?:${competitorNames.join('|')})\\b`, 'i');

  // Patterns that indicate a competing section heading
  const competingHeadingRe = /^(#{1,6})\s+(?:jCodeMunch|jcodemunch|code-index|repomix|aider|cline|cody|greptile|sourcegraph|code-compass|repo-map)\b/i;

  let lines = content.split('\n');

  // --- Pass 1: Remove sections with competing heading titles ---
  lines = filterSections(lines, (headingLine, _level, _body) => {
    return competingHeadingRe.test(headingLine);
  });

  // --- Pass 2: Remove sections whose body references competing tools ---
  // Skip trace-mcp's own sections (heading contains "trace-mcp")
  lines = filterSections(lines, (headingLine, _level, body) => {
    if (/trace-mcp/i.test(headingLine)) return false;
    // "Decision matrix" or any section whose body mentions competing tools
    return competitorRe.test(body);
  });

  // --- Pass 3: Remove parent headings that became empty ---
  lines = removeEmptyParentSections(lines);

  // Also remove standalone preamble lines that reference competing tools
  lines = lines.filter((line) => {
    if (/^#{1,6}\s/.test(line)) return true; // keep headings (handled above)
    if (/^Two MCP tool sets are available/i.test(line.trim())) return false;
    return true;
  });

  return lines.join('\n');
}

/**
 * Filter out sections matching a predicate.
 * predicate(headingLine, level, bodyText) → true means REMOVE the section.
 */
function filterSections(lines: string[], shouldRemove: (heading: string, level: number, body: string) => boolean): string[] {
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

/**
 * Remove parent heading sections that have no meaningful content left
 * (only whitespace or empty lines between the heading and the next same-level heading).
 */
function removeEmptyParentSections(lines: string[]): string[] {
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,6})\s/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const body = lookAheadSection(lines, i + 1, level);
      // Empty if only whitespace / blank lines remain
      if (!body.trim()) {
        // Skip this heading (and the blank lines after it will be cleaned by whitespace cleanup)
        continue;
      }
    }
    output.push(lines[i]);
  }

  return output;
}

/** Collect text of a section until next heading of same/higher level. */
function lookAheadSection(lines: string[], start: number, level: number): string {
  const buf: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) break;
    buf.push(lines[i]);
  }
  return buf.join('\n');
}

/** Clean up excessive blank lines left by removal. */
function cleanupWhitespace(content: string): string {
  return content.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
