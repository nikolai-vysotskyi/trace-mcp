/**
 * pack_context — intelligent repo context packing for external LLMs.
 *
 * Unlike Repomix (flat dump), this uses the dependency graph to:
 * - Rank files by PageRank importance
 * - Group by detected communities/modules
 * - Fit within a token budget
 * - Include structured metadata (routes, models, components)
 */

import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import { getPageRank } from './graph-analysis.js';
import { getProjectMap } from './project.js';
import { buildProjectContext } from '../indexer/project-context.js';
import fs from 'node:fs';
import path from 'node:path';

interface PackOptions {
  scope: 'project' | 'module' | 'feature';
  path?: string;
  query?: string;
  format: 'xml' | 'markdown' | 'json';
  maxTokens: number;
  include: string[];
  compress: boolean;
  projectRoot: string;
}

interface PackResult {
  format: string;
  content: string;
  token_count: number;
  token_budget: number;
  files_included: number;
  sections: string[];
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
  const {
    scope, path: scopePath, query, format, maxTokens, include, compress, projectRoot,
  } = options;

  const parts: string[] = [];
  const includedSections: string[] = [];
  let tokenCount = 0;

  const addSection = (name: string, content: string): boolean => {
    const tokens = estimateTokens(content);
    if (tokenCount + tokens > maxTokens) return false;
    parts.push(content);
    tokenCount += tokens;
    includedSections.push(name);
    return true;
  };

  // Header
  if (format === 'markdown') {
    addSection('header', `# Context Pack: ${scope}${scopePath ? ` (${scopePath})` : ''}${query ? ` — "${query}"` : ''}\n`);
  } else if (format === 'xml') {
    addSection('header', `<context scope="${scope}"${scopePath ? ` path="${scopePath}"` : ''}${query ? ` query="${query}"` : ''}>\n`);
  }

  // --- File Tree ---
  if (include.includes('file_tree')) {
    const files = getAllScopeFiles(store, scope, scopePath);
    const tree = buildFileTree(files.map((f) => f.path));
    const section = format === 'markdown'
      ? `## File Tree\n\`\`\`\n${tree}\n\`\`\`\n`
      : format === 'xml'
        ? `<file_tree>\n${tree}\n</file_tree>\n`
        : tree;
    addSection('file_tree', section);
  }

  // --- Outlines (symbol signatures) ---
  if (include.includes('outlines')) {
    const files = getScopeFiles(store, scope, scopePath, query, 30);
    const outlineLines: string[] = [];
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
      if (estimateTokens(outlineLines.join('\n')) + tokenCount > maxTokens * 0.8) break;
    }
    const section = format === 'markdown'
      ? `## Outlines\n${outlineLines.join('\n')}\n`
      : format === 'xml'
        ? `<outlines>\n${outlineLines.join('\n')}\n</outlines>\n`
        : outlineLines.join('\n');
    addSection('outlines', section);
  }

  // --- Source Code (key files) ---
  if (include.includes('source')) {
    const files = getScopeFiles(store, scope, scopePath, query, 20);
    const sourceLines: string[] = [];
    const budgetForSource = Math.floor((maxTokens - tokenCount) * 0.9);
    let sourceTokens = 0;

    for (const f of files) {
      const absPath = path.join(projectRoot, f.path);
      if (!fs.existsSync(absPath)) continue;

      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch { continue; }

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
        }
        break;
      }

      sourceLines.push(`### ${f.path}`);
      sourceLines.push('```');
      sourceLines.push(content);
      sourceLines.push('```\n');
      sourceTokens += fileTokens;
    }

    if (sourceLines.length > 0) {
      const section = format === 'markdown'
        ? `## Source Code\n${sourceLines.join('\n')}\n`
        : format === 'xml'
          ? `<source>\n${sourceLines.join('\n')}\n</source>\n`
          : sourceLines.join('\n');
      addSection('source', section);
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

      const section = format === 'markdown'
        ? `## API Routes\n| Method | Route | Handler |\n|--------|-------|----------|\n${routes.filter((r) => !['STORE', 'SLICE', 'DISPATCH'].includes(r.method)).slice(0, 100).map((r) => `| ${r.method} | ${r.uri} | ${r.handler} |`).join('\n')}\n`
        : format === 'xml'
          ? `<routes>\n${routeLines.join('\n')}\n</routes>\n`
          : routeLines.join('\n');
      addSection('routes', section);
    }
  }

  // --- Models (data model) ---
  if (include.includes('models')) {
    const symbols = store.searchSymbols('', { kind: 'class' }, 200, 0);
    const models = symbols.items.filter((s) =>
      s.symbol.kind === 'class' && (
        s.symbol.fqn?.includes('Model') ||
        s.symbol.fqn?.includes('Entity') ||
        s.symbol.fqn?.includes('Schema') ||
        s.file.path.includes('model') ||
        s.file.path.includes('entity') ||
        s.file.path.includes('schema')
      ),
    );

    if (models.length > 0) {
      const modelLines = models.slice(0, 30).map((m) =>
        `- **${m.symbol.name}** (${m.file.path}:${m.symbol.line_start})${m.symbol.signature ? `: ${m.symbol.signature}` : ''}`,
      );
      const section = format === 'markdown'
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
      const depLines = ranks.map((r: any) =>
        `- ${r.file} (importance: ${r.score?.toFixed(3) ?? 'N/A'})`,
      );
      const section = format === 'markdown'
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
    const testFiles = allFiles.filter((f: any) =>
      /\.(test|spec)\.\w+$/.test(f.path) || f.path.includes('__tests__'),
    );
    if (testFiles.length > 0) {
      const testLines = testFiles.slice(0, 30).map((f: any) => `- ${f.path}`);
      const section = format === 'markdown'
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

  const filesIncluded = includedSections.includes('source')
    ? getScopeFiles(store, scope, scopePath, query, 20).length
    : 0;

  return {
    format,
    content: parts.join('\n'),
    token_count: tokenCount,
    token_budget: maxTokens,
    files_included: filesIncluded,
    sections: includedSections,
  };
}

// --- Helpers ---

function getAllScopeFiles(store: Store, scope: string, scopePath?: string): { id: number; path: string }[] {
  const all = store.getAllFiles() as { id: number; path: string }[];
  if (scope === 'module' && scopePath) {
    return all.filter((f) => f.path.startsWith(scopePath));
  }
  return all;
}

/** Get ranked files for the given scope. Uses PageRank for project scope, path filter for module. */
function getScopeFiles(
  store: Store,
  scope: string,
  scopePath: string | undefined,
  query: string | undefined,
  limit: number,
): { id: number; path: string }[] {
  const all = store.getAllFiles() as { id: number; path: string }[];

  if (scope === 'module' && scopePath) {
    return all.filter((f) => f.path.startsWith(scopePath)).slice(0, limit);
  }

  if (scope === 'feature' && query) {
    // Use search to find relevant files
    const results = store.searchSymbols(query, {}, limit, 0);
    const fileIds = new Set<number>();
    const files: { id: number; path: string }[] = [];
    for (const r of results.items) {
      if (!fileIds.has(r.file.id)) {
        fileIds.add(r.file.id);
        files.push({ id: r.file.id, path: r.file.path });
      }
    }
    return files;
  }

  // Project scope: rank by PageRank
  try {
    const ranks = getPageRank(store);
    const rankMap = new Map(ranks.map((r: any) => [r.file, r]));
    return all
      .sort((a, b) => ((rankMap.get(b.path) as any)?.score ?? 0) - ((rankMap.get(a.path) as any)?.score ?? 0))
      .slice(0, limit);
  } catch {
    return all.slice(0, limit);
  }
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
