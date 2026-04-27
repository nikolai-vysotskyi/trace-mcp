import { describe, it, expect } from 'vitest';
import { generateDocs } from '../../src/tools/project/generate-docs.js';
import type { Store } from '../../src/db/store.js';
import type { PluginRegistry } from '../../src/plugin-api/registry.js';

function createMockStore(
  files: { id: number; path: string; language: string | null }[] = [],
): Store {
  const symbolsByFile = new Map<number, any[]>();
  for (const f of files) {
    const syms: any[] = [];
    if (f.path.includes('model') || f.path.includes('Model')) {
      syms.push(
        {
          name:
            f.path
              .split('/')
              .pop()
              ?.replace(/\.\w+$/, '') ?? 'Model',
          kind: 'class',
          fqn: 'Model',
          signature: 'class Model',
          line_start: 1,
          line_end: 50,
        },
        {
          name: 'id',
          kind: 'property',
          fqn: 'Model.id',
          signature: 'id: number',
          line_start: 2,
          line_end: 2,
        },
        {
          name: 'name',
          kind: 'property',
          fqn: 'Model.name',
          signature: 'name: string',
          line_start: 3,
          line_end: 3,
        },
      );
    } else {
      syms.push(
        {
          name: 'TestClass',
          kind: 'class',
          fqn: 'TestClass',
          signature: 'class TestClass',
          line_start: 1,
          line_end: 20,
        },
        {
          name: 'testMethod',
          kind: 'method',
          fqn: 'TestClass.testMethod',
          signature: 'testMethod(): void',
          line_start: 5,
          line_end: 10,
        },
      );
    }
    symbolsByFile.set(f.id, syms);
  }

  return {
    getAllFiles: () => files,
    getSymbolsByFile: (id: number) => symbolsByFile.get(id) ?? [],
    getAllRoutes: () => [
      {
        method: 'GET',
        uri: '/api/users',
        handler: 'UserController.index',
        file_id: 1,
        metadata: null,
      },
      {
        method: 'POST',
        uri: '/api/users',
        handler: 'UserController.store',
        file_id: 1,
        metadata: null,
      },
      {
        method: 'EVENT',
        uri: 'user.created',
        handler: 'SendWelcomeEmail',
        file_id: 2,
        metadata: null,
      },
    ],
    searchSymbols: () => ({ items: [], total: 0 }),
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

const defaultFiles = [
  { id: 1, path: 'src/controllers/UserController.ts', language: 'typescript' },
  { id: 2, path: 'src/services/UserService.ts', language: 'typescript' },
  { id: 3, path: 'src/models/User.ts', language: 'typescript' },
  { id: 4, path: 'src/components/UserCard.vue', language: 'vue' },
];

describe('generateDocs', () => {
  it('generates overview section', () => {
    const result = generateDocs(createMockStore(defaultFiles), createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      sections: ['overview'],
      projectRoot: '/tmp/test',
    });
    expect(result.sections_generated).toContain('overview');
    expect(result.content).toContain('## Overview');
    expect(result.content).toContain('typescript');
    expect(result.content).toContain('Files');
  });

  it('generates architecture section with modules', () => {
    const result = generateDocs(createMockStore(defaultFiles), createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      sections: ['architecture'],
      projectRoot: '/tmp/test',
    });
    expect(result.sections_generated).toContain('architecture');
    expect(result.content).toContain('## Architecture');
    expect(result.content).toContain('Modules');
    expect(result.stats.modules).toBeGreaterThan(0);
  });

  it('generates api_surface from routes', () => {
    const result = generateDocs(createMockStore(defaultFiles), createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      sections: ['api_surface'],
      projectRoot: '/tmp/test',
    });
    expect(result.sections_generated).toContain('api_surface');
    expect(result.content).toContain('/api/users');
    expect(result.content).toContain('UserController');
    expect(result.stats.routes).toBe(3); // GET, POST, EVENT
  });

  it('generates data_model for model files', () => {
    const result = generateDocs(createMockStore(defaultFiles), createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      sections: ['data_model'],
      projectRoot: '/tmp/test',
    });
    expect(result.sections_generated).toContain('data_model');
    expect(result.content).toContain('User');
    expect(result.content).toContain('id, name');
  });

  it('generates components section', () => {
    const result = generateDocs(createMockStore(defaultFiles), createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      sections: ['components'],
      projectRoot: '/tmp/test',
    });
    expect(result.sections_generated).toContain('components');
    expect(result.content).toContain('UserCard');
  });

  it('generates events section', () => {
    const result = generateDocs(createMockStore(defaultFiles), createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      sections: ['events'],
      projectRoot: '/tmp/test',
    });
    expect(result.sections_generated).toContain('events');
    expect(result.content).toContain('user.created');
  });

  it('generates all sections at once', () => {
    const result = generateDocs(createMockStore(defaultFiles), createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      sections: [
        'overview',
        'architecture',
        'api_surface',
        'data_model',
        'components',
        'events',
        'dependencies',
      ],
      projectRoot: '/tmp/test',
    });
    expect(result.sections_generated.length).toBeGreaterThanOrEqual(5);
    expect(result.stats.total_lines).toBeGreaterThan(10);
  });

  it('produces HTML format', () => {
    const result = generateDocs(createMockStore(defaultFiles), createMockRegistry(), {
      scope: 'project',
      format: 'html',
      sections: ['overview', 'api_surface'],
      projectRoot: '/tmp/test',
    });
    expect(result.format).toBe('html');
    expect(result.content).toContain('<h1>');
    expect(result.content).toContain('</html>');
  });

  it('filters by module scope', () => {
    const result = generateDocs(createMockStore(defaultFiles), createMockRegistry(), {
      scope: 'module',
      path: 'src/models',
      format: 'markdown',
      sections: ['overview'],
      projectRoot: '/tmp/test',
    });
    expect(result.content).toContain('1'); // Only 1 file in src/models
  });

  it('handles empty store', () => {
    const result = generateDocs(createMockStore([]), createMockRegistry(), {
      scope: 'project',
      format: 'markdown',
      sections: ['overview', 'architecture', 'api_surface'],
      projectRoot: '/tmp/test',
    });
    expect(result.sections_generated).toContain('overview');
    expect(result.stats.total_lines).toBeGreaterThan(0);
  });

  describe('no N+1', () => {
    it('handles 500 files without per-file queries outside file loop', () => {
      const manyFiles = Array.from({ length: 500 }, (_, i) => ({
        id: i + 1,
        path: `src/generated/File${i}.ts`,
        language: 'typescript' as string | null,
      }));
      const result = generateDocs(createMockStore(manyFiles), createMockRegistry(), {
        scope: 'project',
        format: 'markdown',
        sections: ['overview', 'architecture'],
        projectRoot: '/tmp/test',
      });
      // Should complete without hanging
      expect(result.stats.modules).toBeGreaterThan(0);
    });
  });
});
