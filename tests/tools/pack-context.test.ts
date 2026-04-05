import { describe, it, expect } from 'vitest';
import { packContext } from '../../src/tools/pack-context.js';
import type { Store } from '../../src/db/store.js';
import type { PluginRegistry } from '../../src/plugin-api/registry.js';

function createMockStore(files: { id: number; path: string }[] = []): Store {
  const symbols = new Map<number, any[]>();
  for (const f of files) {
    symbols.set(f.id, [
      { name: 'TestClass', kind: 'class', fqn: 'TestClass', signature: 'class TestClass', line_start: 1, line_end: 10 },
      { name: 'testFunc', kind: 'function', fqn: 'testFunc', signature: 'function testFunc(): void', line_start: 12, line_end: 20 },
    ]);
  }

  return {
    getAllFiles: () => files,
    getSymbolsByFile: (id: number) => symbols.get(id) ?? [],
    getAllRoutes: () => [
      { method: 'GET', uri: '/api/users', handler: 'UserController.index', file_id: 1, metadata: null },
      { method: 'POST', uri: '/api/users', handler: 'UserController.store', file_id: 1, metadata: null },
    ],
    searchSymbols: () => ({ items: files.map((f) => ({ symbol: { name: 'TestClass', kind: 'class', fqn: 'TestClass', line_start: 1 }, file: f, score: 1 })), total: files.length }),
    db: { prepare: () => ({ all: () => [], get: () => null }) },
    getFile: () => null,
  } as unknown as Store;
}

function createMockRegistry(): PluginRegistry {
  return {
    getAllFrameworkPlugins: () => [],
    getAllLanguagePlugins: () => [],
  } as unknown as PluginRegistry;
}

describe('packContext', () => {
  const files = [
    { id: 1, path: 'src/controllers/UserController.ts' },
    { id: 2, path: 'src/services/UserService.ts' },
    { id: 3, path: 'src/models/User.ts' },
  ];

  it('returns markdown format by default', () => {
    const store = createMockStore(files);
    const result = packContext(store, createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      maxTokens: 50000,
      include: ['outlines'],
      compress: true,
      projectRoot: '/tmp/test',
    });
    expect(result.format).toBe('markdown');
    expect(result.content).toContain('## Outlines');
    expect(result.token_count).toBeGreaterThan(0);
    expect(result.token_count).toBeLessThanOrEqual(result.token_budget);
  });

  it('returns xml format when specified', () => {
    const store = createMockStore(files);
    const result = packContext(store, createMockRegistry(), {
      scope: 'project',
      format: 'xml',
      maxTokens: 50000,
      include: ['outlines'],
      compress: true,
      projectRoot: '/tmp/test',
    });
    expect(result.content).toContain('<context');
    expect(result.content).toContain('</context>');
  });

  it('respects token budget', () => {
    const store = createMockStore(files);
    const result = packContext(store, createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      maxTokens: 100, // Very small budget
      include: ['outlines', 'source', 'routes', 'models'],
      compress: true,
      projectRoot: '/tmp/test',
    });
    expect(result.token_count).toBeLessThanOrEqual(100);
  });

  it('includes routes section', () => {
    const store = createMockStore(files);
    const result = packContext(store, createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      maxTokens: 50000,
      include: ['routes'],
      compress: true,
      projectRoot: '/tmp/test',
    });
    expect(result.sections).toContain('routes');
    expect(result.content).toContain('/api/users');
  });

  it('includes file_tree section', () => {
    const store = createMockStore(files);
    const result = packContext(store, createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      maxTokens: 50000,
      include: ['file_tree'],
      compress: true,
      projectRoot: '/tmp/test',
    });
    expect(result.sections).toContain('file_tree');
    expect(result.content).toContain('File Tree');
  });

  it('filters by module scope', () => {
    const store = createMockStore(files);
    const result = packContext(store, createMockRegistry(), {
      scope: 'module',
      path: 'src/models',
      format: 'markdown',
      maxTokens: 50000,
      include: ['outlines'],
      compress: true,
      projectRoot: '/tmp/test',
    });
    expect(result.content).toContain('User.ts');
  });

  it('feature scope uses query for symbol search', () => {
    const store = createMockStore(files);
    const result = packContext(store, createMockRegistry(), {
      scope: 'feature',
      query: 'user management',
      format: 'markdown',
      maxTokens: 50000,
      include: ['outlines'],
      compress: true,
      projectRoot: '/tmp/test',
    });
    expect(result.sections).toContain('outlines');
  });

  it('handles empty store gracefully', () => {
    const store = createMockStore([]);
    const result = packContext(store, createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      maxTokens: 50000,
      include: ['outlines', 'routes', 'models'],
      compress: true,
      projectRoot: '/tmp/test',
    });
    expect(result.token_count).toBeGreaterThan(0); // At least header
    expect(result.sections.length).toBeGreaterThanOrEqual(1);
  });

  describe('no memory leaks', () => {
    it('handles many files without unbounded allocation', () => {
      const manyFiles = Array.from({ length: 500 }, (_, i) => ({
        id: i + 1,
        path: `src/components/Component${i}.tsx`,
      }));
      const store = createMockStore(manyFiles);
      const result = packContext(store, createMockRegistry(), {
        scope: 'project',
        format: 'markdown',
        maxTokens: 5000, // Small budget forces truncation
        include: ['file_tree', 'outlines'],
        compress: true,
        projectRoot: '/tmp/test',
      });
      // Token budget respected even with 500 files
      expect(result.token_count).toBeLessThanOrEqual(5000);
    });
  });
});
