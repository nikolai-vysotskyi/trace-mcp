import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript.js';
import { getImplementations, getApiSurface, getPluginRegistry, getTypeHierarchy, getDeadExports } from '../../src/tools/introspect.js';
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
  const db = initializeDatabase(':memory:');
  store = new Store(db);
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
});
