import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import {
  getImplementations,
  getApiSurface,
  getPluginRegistry,
  getTypeHierarchy,
  getDeadExports,
  getDependencyGraph,
  getUntestedExports,
  getUntestedSymbols,
  selfAudit,
} from '../../src/tools/analysis/introspect.js';
import { search } from '../../src/tools/navigation/navigation.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/ts-heritage');

function makeConfig(root: string): TraceMcpConfig {
  return {
    root,
    include: ['**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

// ─── shared setup ───────────────────────────────────────────
let store: Store;
let registry: PluginRegistry;

beforeAll(async () => {
  store = createTestStore();
  registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

  const config = makeConfig(FIXTURE);
  const pipeline = new IndexingPipeline(store, registry, config, FIXTURE);
  await pipeline.indexAll();
});

// ─── get_implementations ────────────────────────────────────

describe('getImplementations', () => {
  it('finds classes that directly implement an interface', () => {
    const result = getImplementations(store, 'Serializable');
    expect(result.target).toBe('Serializable');
    const names = result.implementors.map((i) => i.name);
    expect(names).toContain('JsonSerializer');
  });

  it('finds classes that extend a class implementing an interface', () => {
    // DatabaseRecord extends JsonSerializer and implements Persistable
    const result = getImplementations(store, 'Persistable');
    const names = result.implementors.map((i) => i.name);
    expect(names).toContain('DatabaseRecord');
  });

  it('finds interfaces that extend another interface', () => {
    const result = getImplementations(store, 'Serializable');
    const names = result.implementors.map((i) => i.name);
    // Persistable extends Serializable
    expect(names).toContain('Persistable');
  });

  it('finds classes that extend a base class (extends relation)', () => {
    const result = getImplementations(store, 'JsonSerializer');
    expect(result.implementors.some((i) => i.name === 'DatabaseRecord')).toBe(true);
    expect(result.implementors.find((i) => i.name === 'DatabaseRecord')?.relation).toBe('extends');
  });

  it('finds multiple implementors of Logger', () => {
    const result = getImplementations(store, 'Logger');
    const names = result.implementors.map((i) => i.name);
    expect(names).toContain('ConsoleLogger');
    expect(names).toContain('LoggingRecord');
    expect(result.total).toBeGreaterThanOrEqual(2);
  });

  it('returns empty for unknown interface', () => {
    const result = getImplementations(store, 'NonExistentInterface');
    expect(result.implementors).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('each implementor has expected shape', () => {
    const result = getImplementations(store, 'Logger');
    for (const item of result.implementors) {
      expect(typeof item.symbol_id).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.kind).toBe('string');
      expect(typeof item.file).toBe('string');
      expect(['implements', 'extends']).toContain(item.relation);
    }
  });
});

// ─── get_api_surface ────────────────────────────────────────

describe('getApiSurface', () => {
  it('returns exported symbols grouped by file', () => {
    const result = getApiSurface(store);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.total_symbols).toBeGreaterThan(0);
  });

  it('does NOT include non-exported symbols', () => {
    const result = getApiSurface(store);
    const allNames = result.files.flatMap((f) => f.exports.map((e) => e.name));
    expect(allNames).not.toContain('InternalHelper');
  });

  it('includes exported classes and interfaces', () => {
    const result = getApiSurface(store);
    const allNames = result.files.flatMap((f) => f.exports.map((e) => e.name));
    expect(allNames).toContain('JsonSerializer');
    expect(allNames).toContain('Serializable');
    expect(allNames).toContain('ConsoleLogger');
  });

  it('filters by file pattern', () => {
    const result = getApiSurface(store, 'src/classes.ts');
    expect(result.file_pattern).toBe('src/classes.ts');
    const allNames = result.files.flatMap((f) => f.exports.map((e) => e.name));
    expect(allNames).not.toContain('Serializable'); // from interfaces.ts
    expect(allNames).toContain('JsonSerializer');
  });

  it('each symbol has required fields', () => {
    const result = getApiSurface(store);
    for (const file of result.files) {
      expect(typeof file.file).toBe('string');
      for (const sym of file.exports) {
        expect(typeof sym.symbol_id).toBe('string');
        expect(typeof sym.name).toBe('string');
        expect(typeof sym.kind).toBe('string');
      }
    }
  });
});

// ─── get_plugin_registry ────────────────────────────────────

describe('getPluginRegistry', () => {
  it('lists registered language plugins', () => {
    const activeFrameworks = new Set<string>();
    const result = getPluginRegistry(store, registry, activeFrameworks);
    expect(result.language_plugins.length).toBeGreaterThan(0);
    const names = result.language_plugins.map((p) => p.name);
    expect(names).toContain('typescript-language');
  });

  it('lists framework plugins with active flag', () => {
    const activeFrameworks = new Set(['nestjs']);
    const result = getPluginRegistry(store, registry, activeFrameworks);
    // No framework plugins registered in this test — empty list
    expect(Array.isArray(result.framework_plugins)).toBe(true);
  });

  it('returns all edge types', () => {
    const result = getPluginRegistry(store, registry, new Set());
    expect(result.edge_types.length).toBeGreaterThan(0);
    const edgeNames = result.edge_types.map((e) => e.name);
    expect(edgeNames).toContain('imports');
    expect(edgeNames).toContain('extends');
  });

  it('returns active_frameworks list', () => {
    const activeFrameworks = new Set(['laravel', 'vue']);
    const result = getPluginRegistry(store, registry, activeFrameworks);
    expect(result.active_frameworks).toEqual(['laravel', 'vue']);
  });

  it('each language plugin has required fields', () => {
    const result = getPluginRegistry(store, registry, new Set());
    for (const p of result.language_plugins) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.version).toBe('string');
      expect(typeof p.priority).toBe('number');
      expect(Array.isArray(p.extensions)).toBe(true);
    }
  });
});

// ─── get_type_hierarchy ─────────────────────────────────────

describe('getTypeHierarchy', () => {
  it('finds ancestors of a class (extends chain)', () => {
    // DatabaseRecord extends JsonSerializer → JsonSerializer implements Serializable
    const result = getTypeHierarchy(store, 'DatabaseRecord');
    expect(result.root).toBe('DatabaseRecord');
    expect(result.ancestors.length).toBeGreaterThan(0);
    const ancestorNames = result.ancestors.map((a) => a.name);
    expect(ancestorNames).toContain('JsonSerializer');
    expect(ancestorNames).toContain('Persistable');
  });

  it('finds descendants of an interface', () => {
    const result = getTypeHierarchy(store, 'Serializable');
    expect(result.descendants.length).toBeGreaterThan(0);
    const descNames = result.descendants.map((d) => d.name);
    // JsonSerializer implements Serializable
    expect(descNames).toContain('JsonSerializer');
    // Persistable extends Serializable (interface extends interface)
    expect(descNames).toContain('Persistable');
  });

  it('finds descendants recursively (multi-level)', () => {
    // Serializable → JsonSerializer → DatabaseRecord → LoggingRecord
    const result = getTypeHierarchy(store, 'JsonSerializer');
    const descNames = result.descendants.map((d) => d.name);
    expect(descNames).toContain('DatabaseRecord');
  });

  it('returns empty for unknown type', () => {
    const result = getTypeHierarchy(store, 'NotARealType');
    expect(result.ancestors).toHaveLength(0);
    expect(result.descendants).toHaveLength(0);
  });

  it('each node has required shape', () => {
    const result = getTypeHierarchy(store, 'Logger');
    for (const node of result.descendants) {
      expect(typeof node.name).toBe('string');
      expect(typeof node.kind).toBe('string');
      expect(['extends', 'implements', 'root']).toContain(node.relation);
      expect(Array.isArray(node.children)).toBe(true);
    }
  });
});

// ─── get_dead_exports ───────────────────────────────────────

describe('getDeadExports', () => {
  it('returns dead export analysis', () => {
    const result = getDeadExports(store);
    expect(result.total_exports).toBeGreaterThan(0);
    expect(typeof result.total_dead).toBe('number');
    expect(Array.isArray(result.dead_exports)).toBe(true);
  });

  it('InternalHelper is not in dead exports (it is not exported)', () => {
    const result = getDeadExports(store);
    const deadNames = result.dead_exports.map((d) => d.name);
    expect(deadNames).not.toContain('InternalHelper');
  });

  it('filters by file pattern', () => {
    const result = getDeadExports(store, 'src/interfaces%');
    expect(result.file_pattern).toBe('src/interfaces%');
  });

  it('each dead export has required fields', () => {
    const result = getDeadExports(store);
    for (const item of result.dead_exports) {
      expect(typeof item.symbol_id).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.kind).toBe('string');
      expect(typeof item.file).toBe('string');
    }
  });

  it('does not include symbols from test files', () => {
    const result = getDeadExports(store);
    const testFiles = result.dead_exports.filter(
      (d) =>
        /(?:^|\/)(?:tests?|__tests__|spec)\//.test(d.file) ||
        /\.(?:test|spec)\.[jt]sx?$/.test(d.file),
    );
    expect(testFiles).toHaveLength(0);
  });
});

// ─── ESM import edge resolution ─────────────────────────────

describe('ESM import edge resolution', () => {
  it('creates file→file import edges in the graph', () => {
    // classes.ts imports from interfaces.ts and utils.ts
    const importEdges = store.getEdgesByType('imports');
    expect(importEdges.length).toBeGreaterThan(0);
  });

  it('stores specifiers in edge metadata', () => {
    const importEdges = store.getEdgesByType('imports');
    const withSpecifiers = importEdges.filter((e) => {
      if (!e.metadata) return false;
      const meta =
        typeof e.metadata === 'string'
          ? (JSON.parse(e.metadata) as Record<string, unknown>)
          : e.metadata;
      return Array.isArray(meta['specifiers']) && (meta['specifiers'] as string[]).length > 0;
    });
    expect(withSpecifiers.length).toBeGreaterThan(0);
  });

  it('stores original exported name for aliased imports, not the local alias', () => {
    // classes.ts has: import { fromJSON as parseJSON } from './utils.js'
    // The specifier should be "fromJSON" (original), NOT "parseJSON" (alias)
    const importEdges = store.getEdgesByType('imports');
    const allSpecifiers: string[] = [];
    for (const edge of importEdges) {
      if (!edge.metadata) continue;
      const meta =
        typeof edge.metadata === 'string'
          ? (JSON.parse(edge.metadata) as Record<string, unknown>)
          : edge.metadata;
      const specs = meta['specifiers'];
      if (Array.isArray(specs)) {
        allSpecifiers.push(...(specs as string[]));
      }
    }
    expect(allSpecifiers).toContain('fromJSON');
    expect(allSpecifiers).not.toContain('parseJSON');
  });
});

// ─── get_import_graph ───────────────────────────────────

describe('getDependencyGraph', () => {
  it('shows imports of a file', () => {
    const result = getDependencyGraph(store, 'src/classes.ts');
    expect(result.file).toBe('src/classes.ts');
    expect(result.imports.length).toBeGreaterThan(0);
    const targets = result.imports.map((e) => e.target);
    // classes.ts imports interfaces.ts and utils.ts
    expect(targets.some((t) => t.includes('interfaces'))).toBe(true);
  });

  it('shows imported_by for an imported file', () => {
    const result = getDependencyGraph(store, 'src/interfaces.ts');
    expect(result.imported_by.length).toBeGreaterThan(0);
    const sources = result.imported_by.map((e) => e.source);
    expect(sources.some((s) => s.includes('classes'))).toBe(true);
  });

  it('returns empty for unknown file', () => {
    const result = getDependencyGraph(store, 'nonexistent.ts');
    expect(result.imports).toHaveLength(0);
    expect(result.imported_by).toHaveLength(0);
  });

  it('includes specifiers in edges', () => {
    const result = getDependencyGraph(store, 'src/classes.ts');
    const interfaceImport = result.imports.find((e) => e.target.includes('interfaces'));
    if (interfaceImport) {
      expect(interfaceImport.specifiers.length).toBeGreaterThan(0);
    }
  });
});

// ─── get_untested_exports ───────────────────────────────────

describe('getUntestedExports', () => {
  it('returns untested export analysis', () => {
    const result = getUntestedExports(store);
    expect(result.total_exports).toBeGreaterThan(0);
    expect(typeof result.total_untested).toBe('number');
    expect(Array.isArray(result.untested)).toBe(true);
  });

  it('detects some exports as untested (not all files have test coverage)', () => {
    // Fixture has classes.test.ts (covers classes.ts) but no tests for interfaces.ts/utils.ts
    const result = getUntestedExports(store);
    expect(result.total_untested).toBeGreaterThan(0);
    expect(result.total_untested).toBeLessThanOrEqual(result.total_exports);
  });

  it('each untested item has required fields', () => {
    const result = getUntestedExports(store);
    for (const item of result.untested) {
      expect(typeof item.symbol_id).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.kind).toBe('string');
      expect(typeof item.file).toBe('string');
    }
  });
});

// ─── get_untested_symbols ─────────────────────────────────────

describe('getUntestedSymbols', () => {
  it('returns untested symbol analysis with level classification', () => {
    const result = getUntestedSymbols(store);
    expect(result.total_symbols).toBeGreaterThan(0);
    expect(typeof result.total_untested).toBe('number');
    expect(Array.isArray(result.untested)).toBe(true);
    expect(result.by_level).toBeDefined();
    expect(typeof result.by_level.unreached).toBe('number');
    expect(typeof result.by_level.imported_not_called).toBe('number');
    expect(result.by_level.unreached + result.by_level.imported_not_called).toBe(
      result.total_untested,
    );
  });

  it('covers more symbols than get_untested_exports (includes non-exported)', () => {
    const exportsResult = getUntestedExports(store);
    const symbolsResult = getUntestedSymbols(store);
    // Total analyzed symbols should be >= exported symbols
    expect(symbolsResult.total_symbols).toBeGreaterThanOrEqual(exportsResult.total_exports);
  });

  it('each item has required fields including level', () => {
    const result = getUntestedSymbols(store);
    for (const item of result.untested) {
      expect(typeof item.symbol_id).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.kind).toBe('string');
      expect(typeof item.file).toBe('string');
      expect(['unreached', 'imported_not_called']).toContain(item.level);
    }
  });

  it('respects max_results parameter', () => {
    const full = getUntestedSymbols(store);
    if (full.total_untested > 2) {
      const limited = getUntestedSymbols(store, undefined, 2);
      expect(limited.untested.length).toBe(2);
      expect(limited.total_untested).toBe(full.total_untested); // total stays accurate
    }
  });

  it('sorts unreached before imported_not_called', () => {
    const result = getUntestedSymbols(store);
    const levels = result.untested.map((u) => u.level);
    const firstImported = levels.indexOf('imported_not_called');
    const lastUnreached = levels.lastIndexOf('unreached');
    if (firstImported >= 0 && lastUnreached >= 0) {
      expect(lastUnreached).toBeLessThan(firstImported);
    }
  });
});

// ─── test_covers edges ──────────────────────────────────────

describe('test_covers edges', () => {
  it('creates test_covers edges from test file imports', () => {
    const testCoversEdges = store.getEdgesByType('test_covers');
    expect(testCoversEdges.length).toBeGreaterThan(0);
  });

  it('test_covers edge points from test file to source file', () => {
    const edges = store.getEdgesByType('test_covers');
    for (const edge of edges) {
      const sourceRef = store.getNodeRef(edge.source_node_id);
      const targetRef = store.getNodeRef(edge.target_node_id);
      expect(sourceRef?.nodeType).toBe('file');
      expect(targetRef?.nodeType).toBe('file');

      // Source should be a test file
      if (sourceRef) {
        const f = store.getFileById(sourceRef.refId);
        expect(f?.path).toMatch(/\.(test|spec)\./);
      }
    }
  });
});

// ─── search with heritage filters ───────────────────────────

describe('search with heritage filters', () => {
  it('filters by implements', async () => {
    const result = await search(store, 'class', { implements: 'Serializable' });
    const names = result.items.map((i) => i.symbol.name);
    expect(names).toContain('JsonSerializer');
    // DatabaseRecord does NOT implement Serializable directly
    expect(names).not.toContain('DatabaseRecord');
  });

  it('filters by extends', async () => {
    const result = await search(store, 'class', { extends: 'JsonSerializer' });
    const names = result.items.map((i) => i.symbol.name);
    expect(names).toContain('DatabaseRecord');
    expect(names).not.toContain('JsonSerializer');
  });

  it('returns empty when no match for heritage filter', async () => {
    const result = await search(store, 'class', { implements: 'NonExistentInterface' });
    expect(result.items).toHaveLength(0);
  });
});

// ─── self_audit ─────────────────────────────────────────────

describe('selfAudit', () => {
  it('returns comprehensive audit result', () => {
    const result = selfAudit(store);
    expect(result.summary.total_files).toBeGreaterThan(0);
    expect(result.summary.total_symbols).toBeGreaterThan(0);
    expect(result.summary.total_exports).toBeGreaterThan(0);
    expect(typeof result.summary.dead_exports).toBe('number');
    expect(typeof result.summary.untested_exports).toBe('number');
    expect(typeof result.summary.import_edges).toBe('number');
    expect(typeof result.summary.heritage_edges).toBe('number');
    expect(typeof result.summary.test_covers_edges).toBe('number');
  });

  it('includes dead exports top 10', () => {
    const result = selfAudit(store);
    expect(Array.isArray(result.dead_exports_top10)).toBe(true);
    expect(result.dead_exports_top10.length).toBeLessThanOrEqual(10);
  });

  it('includes dependency hotspots', () => {
    const result = selfAudit(store);
    expect(Array.isArray(result.most_imported_files)).toBe(true);
    expect(Array.isArray(result.most_dependent_files)).toBe(true);
  });

  it('includes test_covers_edges count > 0 (fixture has a test file)', () => {
    const result = selfAudit(store);
    expect(result.summary.test_covers_edges).toBeGreaterThan(0);
  });
});
