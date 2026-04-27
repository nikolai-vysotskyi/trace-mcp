/**
 * generate_docs — auto-generate project documentation from the code graph.
 *
 * Uses indexed symbols, routes, models, components, and dependency data
 * to produce structured documentation in markdown or HTML.
 */

import type { Store } from '../../db/store.js';
import { buildProjectContext } from '../../indexer/project-context.js';
import type { PluginRegistry } from '../../plugin-api/registry.js';
import {
  getCouplingMetrics,
  getDependencyCycles,
  getPageRank,
} from '../analysis/graph-analysis.js';
import { getProjectMap } from './project.js';

type DocSection =
  | 'overview'
  | 'architecture'
  | 'api_surface'
  | 'data_model'
  | 'components'
  | 'events'
  | 'dependencies';

interface GenerateDocsOptions {
  scope: 'project' | 'module' | 'directory';
  path?: string;
  format: 'markdown' | 'html';
  sections: DocSection[];
  projectRoot: string;
}

interface GenerateDocsResult {
  content: string;
  format: string;
  sections_generated: string[];
  stats: {
    total_lines: number;
    modules?: number;
    routes?: number;
    models?: number;
    components?: number;
  };
}

export function generateDocs(
  store: Store,
  registry: PluginRegistry,
  options: GenerateDocsOptions,
): GenerateDocsResult {
  const { scope, path: scopePath, format, sections, projectRoot } = options;
  const parts: string[] = [];
  const generated: string[] = [];
  const stats: GenerateDocsResult['stats'] = { total_lines: 0 };

  const allFiles = store.getAllFiles() as { id: number; path: string; language: string | null }[];
  const scopeFiles =
    scope === 'project'
      ? allFiles
      : allFiles.filter((f) => scopePath && f.path.startsWith(scopePath));

  // --- Overview ---
  if (sections.includes('overview')) {
    const ctx = buildProjectContext(projectRoot);
    const map = safe(() => getProjectMap(store, registry, true, ctx), null);

    parts.push(`# Project: ${projectRoot.split('/').pop() ?? 'Unknown'}\n`);
    parts.push('## Overview\n');

    // Languages
    const langs = new Map<string, number>();
    for (const f of scopeFiles) {
      const lang = f.language ?? 'unknown';
      langs.set(lang, (langs.get(lang) ?? 0) + 1);
    }
    const langStr = [...langs.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([l, c]) => `${l} (${c})`)
      .join(', ');

    parts.push(`- **Languages**: ${langStr}`);
    parts.push(`- **Files**: ${scopeFiles.length}`);

    // Symbol counts
    const symbolCounts = new Map<string, number>();
    for (const f of scopeFiles) {
      const syms = store.getSymbolsByFile(f.id);
      for (const s of syms) {
        symbolCounts.set(s.kind, (symbolCounts.get(s.kind) ?? 0) + 1);
      }
    }
    const totalSymbols = [...symbolCounts.values()].reduce((a, b) => a + b, 0);
    parts.push(
      `- **Symbols**: ${totalSymbols} (${[...symbolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${v} ${k}s`)
        .join(', ')})`,
    );

    if (map) {
      parts.push(`- **Frameworks**: ${JSON.stringify((map as any).frameworks ?? [])}`);
    }
    parts.push('');
    generated.push('overview');
  }

  // --- Architecture ---
  if (sections.includes('architecture')) {
    parts.push('## Architecture\n');

    // Module detection via directory grouping
    const modules = new Map<string, { files: number; symbols: string[] }>();
    for (const f of scopeFiles) {
      const parts2 = f.path.split('/');
      const module = parts2.length >= 2 ? parts2.slice(0, 2).join('/') : parts2[0];
      const mod = modules.get(module) ?? { files: 0, symbols: [] };
      mod.files++;
      const syms = store.getSymbolsByFile(f.id);
      for (const s of syms) {
        if (['class', 'interface', 'trait'].includes(s.kind) && mod.symbols.length < 5) {
          mod.symbols.push(s.name);
        }
      }
      modules.set(module, mod);
    }

    parts.push('### Modules (auto-detected)\n');
    parts.push('| Module | Files | Key Symbols |');
    parts.push('|--------|-------|-------------|');
    const sortedModules = [...modules.entries()].sort((a, b) => b[1].files - a[1].files);
    for (const [mod, info] of sortedModules.slice(0, 30)) {
      parts.push(`| ${mod} | ${info.files} | ${info.symbols.join(', ') || '—'} |`);
    }
    stats.modules = modules.size;
    parts.push('');

    // Coupling summary
    const coupling = safe(() => getCouplingMetrics(store), []);
    if (coupling.length > 0) {
      const unstable = coupling.filter((c: any) => c.assessment === 'unstable').length;
      parts.push(`### Stability\n- ${coupling.length} files analyzed, ${unstable} unstable\n`);
    }

    // Cycles
    const cycles = safe(() => getDependencyCycles(store), []);
    if (cycles.length > 0) {
      parts.push(`### Dependency Cycles: ${cycles.length}\n`);
      for (const c of cycles.slice(0, 5)) {
        parts.push(`- ${c.join(' → ')}`);
      }
      parts.push('');
    }

    // Mermaid dependency flow
    const ranks = safe(() => getPageRank(store), []);
    if (ranks.length >= 3) {
      parts.push('### Dependency Flow\n');
      parts.push('```mermaid');
      parts.push('graph LR');
      const topFiles = ranks.slice(0, 10);
      const seen = new Set<string>();
      for (const r of topFiles) {
        const file = (r as any).file ?? '';
        const shortName =
          file
            .split('/')
            .pop()
            ?.replace(/\.\w+$/, '') ?? file;
        if (!seen.has(shortName)) {
          seen.add(shortName);
          parts.push(`  ${shortName}`);
        }
      }
      parts.push('```\n');
    }

    generated.push('architecture');
  }

  // --- API Surface ---
  if (sections.includes('api_surface')) {
    const routes = store
      .getAllRoutes()
      .filter((r: any) => !['STORE', 'SLICE', 'DISPATCH'].includes(r.method));

    if (routes.length > 0) {
      parts.push('## API Surface\n');
      parts.push('| Method | Route | Handler |');
      parts.push('|--------|-------|---------|');
      for (const r of routes.slice(0, 100)) {
        parts.push(`| ${r.method} | ${r.uri} | ${r.handler} |`);
      }
      if (routes.length > 100) {
        parts.push(`\n*...and ${routes.length - 100} more routes*`);
      }
      stats.routes = routes.length;
      parts.push('');
      generated.push('api_surface');
    }
  }

  // --- Data Model ---
  if (sections.includes('data_model')) {
    // Find model/entity classes
    const modelFiles = scopeFiles.filter((f) => /model|entity|schema|migration/i.test(f.path));

    const models: { name: string; file: string; fields: string[] }[] = [];
    for (const f of modelFiles) {
      const syms = store.getSymbolsByFile(f.id);
      for (const s of syms) {
        if (['class', 'interface'].includes(s.kind)) {
          const children = syms.filter(
            (c: any) =>
              c.kind === 'property' &&
              c.line_start > s.line_start &&
              c.line_start < (s.line_end ?? Infinity),
          );
          models.push({
            name: s.name,
            file: f.path,
            fields: children.map((c: any) => c.name),
          });
        }
      }
    }

    if (models.length > 0) {
      parts.push('## Data Model\n');
      for (const m of models.slice(0, 30)) {
        parts.push(`### ${m.name}`);
        parts.push(`- **File**: ${m.file}`);
        if (m.fields.length > 0) {
          parts.push(`- **Fields**: ${m.fields.join(', ')}`);
        }
        parts.push('');
      }
      stats.models = models.length;
      generated.push('data_model');
    }
  }

  // --- Components ---
  if (sections.includes('components')) {
    const componentFiles = scopeFiles.filter(
      (f) => /\.(vue|tsx|jsx)$/.test(f.path) || f.path.includes('component'),
    );

    if (componentFiles.length > 0) {
      parts.push('## Components\n');
      for (const f of componentFiles.slice(0, 50)) {
        const syms = store.getSymbolsByFile(f.id);
        const main = syms.find((s: any) => ['component', 'class', 'function'].includes(s.kind));
        parts.push(`- **${main?.name ?? f.path.split('/').pop()}** — ${f.path}`);
      }
      if (componentFiles.length > 50) {
        parts.push(`\n*...and ${componentFiles.length - 50} more components*`);
      }
      stats.components = componentFiles.length;
      parts.push('');
      generated.push('components');
    }
  }

  // --- Events ---
  if (sections.includes('events')) {
    const routes = store.getAllRoutes();
    const events = routes.filter((r: any) =>
      ['EVENT', 'LISTENER', 'SIGNAL', 'TASK'].includes(r.method),
    );

    if (events.length > 0) {
      parts.push('## Events\n');
      parts.push('| Type | Name | Handler |');
      parts.push('|------|------|---------|');
      for (const e of events.slice(0, 50)) {
        parts.push(`| ${e.method} | ${e.uri} | ${e.handler} |`);
      }
      parts.push('');
      generated.push('events');
    }
  }

  // --- Dependencies ---
  if (sections.includes('dependencies')) {
    const ranks = safe(() => getPageRank(store), []);
    if (ranks.length > 0) {
      parts.push('## Key Dependencies (by importance)\n');
      for (const r of ranks.slice(0, 20)) {
        parts.push(`- ${(r as any).file} (score: ${(r as any).score?.toFixed(3) ?? 'N/A'})`);
      }
      parts.push('');
      generated.push('dependencies');
    }
  }

  const content = parts.join('\n');
  stats.total_lines = content.split('\n').length;

  // Convert to HTML if requested
  const finalContent = format === 'html' ? markdownToBasicHtml(content) : content;

  return {
    content: finalContent,
    format,
    sections_generated: generated,
    stats,
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Minimal markdown → HTML conversion (headings, tables, lists, code blocks) */
function markdownToBasicHtml(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Documentation</title></head><body>',
  ];
  let inCode = false;
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        html.push('</pre>');
        inCode = false;
      } else {
        html.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(escapeHtml(line));
      continue;
    }
    if (line.startsWith('|') && line.endsWith('|')) {
      if (!inTable) {
        html.push('<table>');
        inTable = true;
      }
      if (line.includes('---')) continue; // separator row
      const cells = line
        .split('|')
        .filter(Boolean)
        .map((c) => c.trim());
      html.push(`<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`);
      continue;
    }
    if (inTable) {
      html.push('</table>');
      inTable = false;
    }
    if (line.startsWith('# ')) html.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    else if (line.startsWith('## ')) html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    else if (line.startsWith('### ')) html.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
    else if (line.startsWith('- ')) html.push(`<li>${escapeHtml(line.slice(2))}</li>`);
    else if (line.trim()) html.push(`<p>${escapeHtml(line)}</p>`);
  }

  if (inTable) html.push('</table>');
  if (inCode) html.push('</pre>');
  html.push('</body></html>');
  return html.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
