/**
 * Batch Changes — impact report + PR template generator for package updates.
 *
 * Analyzes which files and symbols would be affected by updating a dependency,
 * and generates a structured impact report with actionable PR description.
 *
 * All data from the existing index — no cross-repo cloning.
 */

import type { Store } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { validationError } from '../errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BatchChangeInput {
  package: string;
  fromVersion?: string;
  toVersion?: string;
  breakingChanges?: string[];
}

interface AffectedFile {
  file: string;
  imports: string[];
  symbols_using: string[];
  line_references: number[];
}

interface BatchChangeResult {
  package: string;
  from_version?: string;
  to_version?: string;
  affected_files: AffectedFile[];
  affected_count: number;
  breaking_changes: string[];
  pr_template: string;
  risk_level: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Analyze the impact of a package update across the codebase.
 * Uses the edge graph to find all files that import the package,
 * and all symbols within those files that reference package exports.
 */
export function planBatchChange(
  store: Store,
  input: BatchChangeInput,
): TraceMcpResult<BatchChangeResult> {
  if (!input.package) {
    return err(validationError('Package name is required'));
  }

  const pkg = input.package;
  const breakingChanges = input.breakingChanges ?? [];

  // Find files that import this package — search edges + symbols
  const importEdges = store.db.prepare(`
    SELECT DISTINCT f.path, f.id as file_id
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.metadata LIKE ?
    ORDER BY f.path
  `).all(`%"module":"${pkg}%`) as { path: string; file_id: number }[];

  // Also search for direct package name references in symbol IDs
  const directRefs = store.db.prepare(`
    SELECT DISTINCT f.path, f.id as file_id
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE (s.symbol_id LIKE ? OR s.fqn LIKE ? OR s.name LIKE ?)
    AND f.path NOT LIKE '%node_modules%'
    AND f.path NOT LIKE '%vendor%'
  `).all(`%${pkg}%`, `%${pkg}%`, `%${pkg}%`) as { path: string; file_id: number }[];

  // Also search for import edges that reference this package
  const edgeImports = store.db.prepare(`
    SELECT DISTINCT f.path, f.id as file_id
    FROM edges e
    JOIN edge_types et ON e.edge_type_id = et.id
    JOIN nodes ns ON e.source_node_id = ns.id AND ns.node_type = 'symbol'
    JOIN symbols ss ON ns.ref_id = ss.id
    JOIN files f ON ss.file_id = f.id
    WHERE et.name IN ('imports', 'requires')
    AND e.metadata LIKE ?
  `).all(`%${pkg}%`) as { path: string; file_id: number }[];

  // Merge and deduplicate
  const fileMap = new Map<string, number>();
  for (const row of [...importEdges, ...directRefs, ...edgeImports]) {
    if (!fileMap.has(row.path)) {
      fileMap.set(row.path, row.file_id);
    }
  }

  // Build affected files detail — batch query symbols per file
  const affectedFiles: AffectedFile[] = [];
  const fileEntries = [...fileMap.entries()];

  // Process files in batch
  for (const [filePath, fileId] of fileEntries) {
    const symbols = store.db.prepare(`
      SELECT name, symbol_id, line_start, metadata
      FROM symbols
      WHERE file_id = ?
    `).all(fileId) as { name: string; symbol_id: string; line_start: number | null; metadata: string | null }[];

    const imports: string[] = [];
    const symbolsUsing: string[] = [];
    const lineRefs: number[] = [];

    for (const sym of symbols) {
      const meta = sym.metadata ? JSON.parse(sym.metadata) : {};
      // Check if this symbol imports the package
      if (meta.module && String(meta.module).includes(pkg)) {
        imports.push(sym.name);
        if (sym.line_start) lineRefs.push(sym.line_start);
      }
      // Check if symbol name references the package
      if (sym.symbol_id.includes(pkg) || sym.name.includes(pkg.split('/').pop() ?? '')) {
        symbolsUsing.push(sym.name);
        if (sym.line_start) lineRefs.push(sym.line_start);
      }
    }

    affectedFiles.push({
      file: filePath,
      imports: [...new Set(imports)],
      symbols_using: [...new Set(symbolsUsing)],
      line_references: [...new Set(lineRefs)].sort((a, b) => a - b),
    });
  }

  // Risk assessment
  const risk = affectedFiles.length > 20
    ? 'high'
    : affectedFiles.length > 5
      ? 'medium'
      : 'low';

  // Generate PR template
  const prTemplate = generatePrTemplate(input, affectedFiles, risk);

  return ok({
    package: pkg,
    from_version: input.fromVersion,
    to_version: input.toVersion,
    affected_files: affectedFiles,
    affected_count: affectedFiles.length,
    breaking_changes: breakingChanges,
    pr_template: prTemplate,
    risk_level: risk,
  });
}

function generatePrTemplate(
  input: BatchChangeInput,
  affected: AffectedFile[],
  risk: string,
): string {
  const lines: string[] = [];

  lines.push(`## Update \`${input.package}\``);
  if (input.fromVersion && input.toVersion) {
    lines.push(`\`${input.fromVersion}\` → \`${input.toVersion}\``);
  }
  lines.push('');

  lines.push('### Impact');
  lines.push(`- **Risk level**: ${risk}`);
  lines.push(`- **Affected files**: ${affected.length}`);
  lines.push('');

  if (input.breakingChanges?.length) {
    lines.push('### Breaking Changes');
    for (const bc of input.breakingChanges) {
      lines.push(`- ${bc}`);
    }
    lines.push('');
  }

  if (affected.length > 0) {
    lines.push('### Affected Files');
    const shown = affected.slice(0, 20);
    for (const af of shown) {
      const refs = af.line_references.length > 0
        ? ` (lines: ${af.line_references.join(', ')})`
        : '';
      lines.push(`- \`${af.file}\`${refs}`);
      if (af.imports.length > 0) {
        lines.push(`  - Imports: ${af.imports.join(', ')}`);
      }
    }
    if (affected.length > 20) {
      lines.push(`- ... and ${affected.length - 20} more files`);
    }
    lines.push('');
  }

  lines.push('### Checklist');
  lines.push('- [ ] Update package version in manifest');
  lines.push('- [ ] Run full test suite');
  if (input.breakingChanges?.length) {
    lines.push('- [ ] Address all breaking changes listed above');
  }
  lines.push('- [ ] Verify affected files compile correctly');
  lines.push('- [ ] Manual smoke test for critical paths');

  return lines.join('\n');
}
