/**
 * pack_context — intelligent repo context packing for external LLMs.
 *
 * Unlike Repomix (flat dump), this uses the dependency graph to:
 * - Rank files by PageRank importance
 * - Group by detected communities/modules
 * - Fit within a token budget
 * - Include structured metadata (routes, models, components)
 */

import type { Store } from '../../db/store.js';
import type { PluginRegistry } from '../../plugin-api/registry.js';
import { searchFts } from '../../db/fts.js';
import { getPageRank } from '../analysis/graph-analysis.js';
import fs from 'node:fs';
import path from 'node:path';

export type PackStrategy = 'most_relevant' | 'core_first' | 'compact';

interface PackOptions {
  scope: 'project' | 'module' | 'feature';
  path?: string;
  query?: string;
  format: 'xml' | 'markdown' | 'json';
  maxTokens: number;
  include: string[];
  compress: boolean;
  projectRoot: string;
  /**
   * Selection / packing strategy:
   * - most_relevant: feature query rank → PageRank → insertion (default; current behavior)
   * - core_first:   PageRank always wins; architecturally central files first regardless of scope
   * - compact:      signatures only — drops the `source` section entirely, forces compress=true,
   *                 letting outlines cover much more of the repo for the same budget
   */
  strategy?: PackStrategy;
  /** Include a per-section budget breakdown in the result (default false) */
  includeBudgetReport?: boolean;
}

interface SectionMeta {
  tokens: number;
  status: 'included' | 'dropped' | 'truncated';
  items_included?: number;
  items_dropped?: number;
}

interface BudgetReport {
  strategy: PackStrategy;
  total_used: number;
  total_budget: number;
  headroom: number;
  per_section: Record<string, SectionMeta>;
}

interface PackResult {
  format: string;
  content: string;
  token_count: number;
  token_budget: number;
  files_included: number;
  sections: string[];
  budget_report?: BudgetReport;
}

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function packContext(
  store: Store,
  registry: PluginRegistry,
  options: PackOptions,
): PackResult {
  const { scope, path: scopePath, query, format, maxTokens, projectRoot } = options;
  const strategy: PackStrategy = options.strategy ?? 'most_relevant';
  // compact strategy forces compression and drops the heavy `source` section
  const compress = strategy === 'compact' ? true : options.compress;
  const include =
    strategy === 'compact' ? options.include.filter((s) => s !== 'source') : options.include;

  const parts: string[] = [];
  const includedSections: string[] = [];
  const sectionMeta: Record<string, SectionMeta> = {};
  let tokenCount = 0;

  const addSection = (
    name: string,
    content: string,
    extra?: { items_included?: number; items_dropped?: number; truncated?: boolean },
  ): boolean => {
    const tokens = estimateTokens(content);
    if (tokenCount + tokens > maxTokens) {
      sectionMeta[name] = {
        tokens: 0,
        status: 'dropped',
        ...(extra?.items_dropped !== undefined ? { items_dropped: extra.items_dropped } : {}),
      };
      return false;
    }
    parts.push(content);
    tokenCount += tokens;
    includedSections.push(name);
    sectionMeta[name] = {
      tokens,
      status: extra?.truncated ? 'truncated' : 'included',
      ...(extra?.items_included !== undefined ? { items_included: extra.items_included } : {}),
      ...(extra?.items_dropped ? { items_dropped: extra.items_dropped } : {}),
    };
    return true;
  };

  // Header
  if (format === 'markdown') {
    addSection(
      'header',
      `# Context Pack: ${scope}${scopePath ? ` (${scopePath})` : ''}${query ? ` — "${query}"` : ''}\n`,
    );
  } else if (format === 'xml') {
    addSection(
      'header',
      `<context scope="${scope}"${scopePath ? ` path="${scopePath}"` : ''}${query ? ` query="${query}"` : ''}>\n`,
    );
  }

  // --- File Tree ---
  if (include.includes('file_tree')) {
    const files = getAllScopeFiles(store, scope, scopePath);
    const tree = buildFileTree(files.map((f) => f.path));
    const section =
      format === 'markdown'
        ? `## File Tree\n\`\`\`\n${tree}\n\`\`\`\n`
        : format === 'xml'
          ? `<file_tree>\n${tree}\n</file_tree>\n`
          : tree;
    addSection('file_tree', section);
  }

  // --- Outlines (symbol signatures) ---
  if (include.includes('outlines')) {
    // compact mode: pull a much wider net since we're not spending budget on source bodies
    const outlineLimit = strategy === 'compact' ? 200 : 30;
    const files = getScopeFiles(store, scope, scopePath, query, outlineLimit, strategy);
    const outlineLines: string[] = [];
    let outlineFilesIncluded = 0;
    let outlineFilesDropped = 0;
    let outlineTruncated = false;
    for (const f of files) {
      const symbols = store.getSymbolsByFile(f.id);
      if (symbols.length === 0) continue;
      outlineLines.push(`### ${f.path}`);
      for (const s of symbols) {
        if (s.signature) {
          outlineLines.push(`  ${s.signature}`);
        } else {
          outlineLines.push(`  ${s.kind} ${s.name} (line ${s.line_start})`);
        }
      }
      outlineLines.push('');
      outlineFilesIncluded++;
      if (estimateTokens(outlineLines.join('\n')) + tokenCount > maxTokens * 0.8) {
        outlineTruncated = true;
        outlineFilesDropped = files.length - outlineFilesIncluded;
        break;
      }
    }
    const section =
      format === 'markdown'
        ? `## Outlines\n${outlineLines.join('\n')}\n`
        : format === 'xml'
          ? `<outlines>\n${outlineLines.join('\n')}\n</outlines>\n`
          : outlineLines.join('\n');
    addSection('outlines', section, {
      items_included: outlineFilesIncluded,
      items_dropped: outlineFilesDropped,
      truncated: outlineTruncated,
    });
  }

  // --- Source Code (key files) ---
  if (include.includes('source')) {
    const files = getScopeFiles(store, scope, scopePath, query, 20, strategy);
    const sourceLines: string[] = [];
    const budgetForSource = Math.floor((maxTokens - tokenCount) * 0.9);
    let sourceTokens = 0;
    let sourceFilesIncluded = 0;
    let sourceTruncated = false;

    for (const f of files) {
      const absPath = path.join(projectRoot, f.path);
      if (!fs.existsSync(absPath)) continue;

      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      if (compress) {
        // In compress mode: keep signatures, strip function bodies
        const symbols = store.getSymbolsByFile(f.id);
        if (symbols.length > 0) {
          const compressedLines = [`### ${f.path}`];
          for (const s of symbols) {
            compressedLines.push(s.signature ?? `${s.kind} ${s.name}`);
          }
          content = compressedLines.join('\n');
        }
      }

      const fileTokens = estimateTokens(content);
      if (sourceTokens + fileTokens > budgetForSource) {
        // Try to fit a truncated version
        const remaining = budgetForSource - sourceTokens;
        if (remaining > 200) {
          const truncated = content.slice(0, remaining * 4);
          sourceLines.push(`### ${f.path} (truncated)`);
          sourceLines.push('```');
          sourceLines.push(truncated);
          sourceLines.push('```\n');
          sourceFilesIncluded++;
        }
        sourceTruncated = true;
        break;
      }

      sourceLines.push(`### ${f.path}`);
      sourceLines.push('```');
      sourceLines.push(content);
      sourceLines.push('```\n');
      sourceTokens += fileTokens;
      sourceFilesIncluded++;
    }

    if (sourceLines.length > 0) {
      const section =
        format === 'markdown'
          ? `## Source Code\n${sourceLines.join('\n')}\n`
          : format === 'xml'
            ? `<source>\n${sourceLines.join('\n')}\n</source>\n`
            : sourceLines.join('\n');
      addSection('source', section, {
        items_included: sourceFilesIncluded,
        items_dropped: Math.max(0, files.length - sourceFilesIncluded),
        truncated: sourceTruncated,
      });
    }
  }

  // --- Routes (API surface) ---
  if (include.includes('routes')) {
    const routes = store.getAllRoutes();
    if (routes.length > 0) {
      const routeLines = routes
        .filter((r) => r.method !== 'STORE' && r.method !== 'SLICE' && r.method !== 'DISPATCH')
        .slice(0, 100)
        .map((r) => `${r.method} ${r.uri} → ${r.handler}`);

      const section =
        format === 'markdown'
          ? `## API Routes\n| Method | Route | Handler |\n|--------|-------|----------|\n${routes
              .filter((r) => !['STORE', 'SLICE', 'DISPATCH'].includes(r.method))
              .slice(0, 100)
              .map((r) => `| ${r.method} | ${r.uri} | ${r.handler} |`)
              .join('\n')}\n`
          : format === 'xml'
            ? `<routes>\n${routeLines.join('\n')}\n</routes>\n`
            : routeLines.join('\n');
      addSection('routes', section);
    }
  }

  // --- Models (data model) ---
  if (include.includes('models')) {
    const classRows = store.db
      .prepare(`
      SELECT s.name, s.fqn, s.line_start, s.signature, f.path as file_path
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.kind = 'class'
        AND (s.fqn LIKE '%Model%' OR s.fqn LIKE '%Entity%' OR s.fqn LIKE '%Schema%'
          OR f.path LIKE '%model%' OR f.path LIKE '%entity%' OR f.path LIKE '%schema%')
      LIMIT 200
    `)
      .all() as {
      name: string;
      fqn: string | null;
      line_start: number;
      signature: string | null;
      file_path: string;
    }[];

    if (classRows.length > 0) {
      const modelLines = classRows
        .slice(0, 30)
        .map(
          (m) =>
            `- **${m.name}** (${m.file_path}:${m.line_start})${m.signature ? `: ${m.signature}` : ''}`,
        );
      const section =
        format === 'markdown'
          ? `## Data Models\n${modelLines.join('\n')}\n`
          : format === 'xml'
            ? `<models>\n${modelLines.join('\n')}\n</models>\n`
            : modelLines.join('\n');
      addSection('models', section);
    }
  }

  // --- Dependencies (import graph) ---
  if (include.includes('dependencies')) {
    const ranks = getPageRank(store).slice(0, 20);
    if (ranks.length > 0) {
      const depLines = ranks.map(
        (r: any) => `- ${r.file} (importance: ${r.score?.toFixed(3) ?? 'N/A'})`,
      );
      const section =
        format === 'markdown'
          ? `## Key Dependencies (by importance)\n${depLines.join('\n')}\n`
          : format === 'xml'
            ? `<dependencies>\n${depLines.join('\n')}\n</dependencies>\n`
            : depLines.join('\n');
      addSection('dependencies', section);
    }
  }

  // --- Tests ---
  if (include.includes('tests')) {
    const allFiles = store.getAllFiles();
    const testFiles = allFiles.filter(
      (f: any) => /\.(test|spec)\.\w+$/.test(f.path) || f.path.includes('__tests__'),
    );
    if (testFiles.length > 0) {
      const testLines = testFiles.slice(0, 30).map((f: any) => `- ${f.path}`);
      const section =
        format === 'markdown'
          ? `## Test Files (${testFiles.length} total)\n${testLines.join('\n')}\n`
          : format === 'xml'
            ? `<tests count="${testFiles.length}">\n${testLines.join('\n')}\n</tests>\n`
            : testLines.join('\n');
      addSection('tests', section);
    }
  }

  // Footer
  if (format === 'xml') {
    parts.push('</context>');
  }

  const filesIncluded =
    sectionMeta.source?.items_included ??
    (includedSections.includes('source')
      ? getScopeFiles(store, scope, scopePath, query, 20, strategy).length
      : 0);

  const result: PackResult = {
    format,
    content: parts.join('\n'),
    token_count: tokenCount,
    token_budget: maxTokens,
    files_included: filesIncluded,
    sections: includedSections,
  };

  if (options.includeBudgetReport) {
    result.budget_report = {
      strategy,
      total_used: tokenCount,
      total_budget: maxTokens,
      headroom: Math.max(0, maxTokens - tokenCount),
      per_section: sectionMeta,
    };
  }

  return result;
}

// --- Helpers ---

function getAllScopeFiles(
  store: Store,
  scope: string,
  scopePath?: string,
): { id: number; path: string }[] {
  const all = store.getAllFiles() as { id: number; path: string }[];
  if (scope === 'module' && scopePath) {
    return all.filter((f) => f.path.startsWith(scopePath));
  }
  return all;
}

/**
 * Get ranked files for the given scope.
 *
 * Strategy semantics:
 * - most_relevant: feature query rank → PageRank → insertion (default)
 * - core_first:    PageRank ALWAYS wins, regardless of scope. Module/feature scopes
 *                  still narrow the candidate set, then re-rank by PageRank.
 * - compact:       same selection as most_relevant (compact only changes section composition)
 */
function getScopeFiles(
  store: Store,
  scope: string,
  scopePath: string | undefined,
  query: string | undefined,
  limit: number,
  strategy: PackStrategy = 'most_relevant',
): { id: number; path: string }[] {
  const all = store.getAllFiles() as { id: number; path: string }[];

  // Helper: re-rank a candidate set by PageRank descending
  const rerankByPageRank = (candidates: { id: number; path: string }[]) => {
    try {
      const ranks = getPageRank(store);
      const rankMap = new Map(
        ranks.map((r: { file: string; score?: number }) => [r.file, r.score ?? 0]),
      );
      return [...candidates].sort(
        (a, b) => (rankMap.get(b.path) ?? 0) - (rankMap.get(a.path) ?? 0),
      );
    } catch {
      return candidates;
    }
  };

  if (scope === 'module' && scopePath) {
    const filtered = all.filter((f) => f.path.startsWith(scopePath));
    const ordered = strategy === 'core_first' ? rerankByPageRank(filtered) : filtered;
    return ordered.slice(0, limit);
  }

  if (scope === 'feature' && query) {
    // Use FTS search to find relevant files
    const ftsResults = searchFts(store.db, query, limit * 2, 0);
    const fileIds = new Set<number>();
    const files: { id: number; path: string }[] = [];
    for (const r of ftsResults) {
      if (!fileIds.has(r.fileId)) {
        const file = store.getFileById(r.fileId);
        if (file) {
          fileIds.add(r.fileId);
          files.push({ id: file.id, path: file.path });
        }
      }
      if (files.length >= limit) break;
    }
    // core_first overrides feature relevance with structural centrality
    return strategy === 'core_first' ? rerankByPageRank(files).slice(0, limit) : files;
  }

  // Project scope: PageRank for all strategies (it's the only sensible default here)
  return rerankByPageRank(all).slice(0, limit);
}

function buildFileTree(paths: string[]): string {
  const lines: string[] = [];
  const sorted = paths.sort();
  for (const p of sorted.slice(0, 200)) {
    const depth = p.split('/').length - 1;
    const indent = '  '.repeat(Math.min(depth, 6));
    lines.push(`${indent}${path.basename(p)}`);
  }
  if (sorted.length > 200) {
    lines.push(`  ... and ${sorted.length - 200} more files`);
  }
  return lines.join('\n');
}
