import { beforeEach, describe, expect, test } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';

/**
 * getStats().totalRoutes used to mix HTTP routes, MCP TOOL/RESOURCE/PROMPT
 * synthetic rows, and TEST/TEST_ROUTE/TEST_COMPONENT fixtures. On non-HTTP
 * projects (e.g. an MCP server) that made `totalRoutes` dominated by test
 * fixtures and meaningless. The metric is now split into three buckets so the
 * headline `totalRoutes` is a clean HTTP signal.
 */
describe('IndexStats — route bucket split', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    store.insertFile('src/routes.ts', 'typescript', 'h1', 100);
  });

  test('counts only HTTP methods toward totalRoutes', () => {
    store.insertRoute({ uri: '/api/users', method: 'GET', filePath: 'src/routes.ts' });
    store.insertRoute({ uri: '/api/users', method: 'POST', filePath: 'src/routes.ts' });
    store.insertRoute({ uri: '/api/users/:id', method: 'DELETE', filePath: 'src/routes.ts' });

    const stats = store.getStats();
    expect(stats.totalRoutes).toBe(3);
    expect(stats.totalResourceRoutes).toBe(0);
    expect(stats.totalTestFixtureRoutes).toBe(0);
  });

  test('routes synthetic resource methods to totalResourceRoutes', () => {
    store.insertRoute({ uri: 'mcp:tool:search', method: 'TOOL', filePath: 'src/routes.ts' });
    store.insertRoute({ uri: 'mcp:resource:x', method: 'RESOURCE', filePath: 'src/routes.ts' });
    store.insertRoute({ uri: 'cli:serve', method: 'CLI', filePath: 'src/routes.ts' });
    store.insertRoute({ uri: 'job:reindex', method: 'JOB', filePath: 'src/routes.ts' });

    const stats = store.getStats();
    expect(stats.totalRoutes).toBe(0);
    expect(stats.totalResourceRoutes).toBe(4);
    expect(stats.totalTestFixtureRoutes).toBe(0);
  });

  test('routes TEST* methods to totalTestFixtureRoutes', () => {
    store.insertRoute({ uri: 'fixture:1', method: 'TEST', filePath: 'src/routes.ts' });
    store.insertRoute({ uri: 'fixture:2', method: 'TEST_ROUTE', filePath: 'src/routes.ts' });
    store.insertRoute({ uri: 'fixture:3', method: 'TEST_COMPONENT', filePath: 'src/routes.ts' });

    const stats = store.getStats();
    expect(stats.totalRoutes).toBe(0);
    expect(stats.totalResourceRoutes).toBe(0);
    expect(stats.totalTestFixtureRoutes).toBe(3);
  });

  test('mixed bag — buckets partition correctly', () => {
    store.insertRoute({ uri: '/api/x', method: 'GET', filePath: 'src/routes.ts' });
    store.insertRoute({ uri: 'mcp:tool:search', method: 'TOOL', filePath: 'src/routes.ts' });
    store.insertRoute({ uri: 'fixture:1', method: 'TEST', filePath: 'src/routes.ts' });
    store.insertRoute({ uri: 'fixture:2', method: 'TEST_ROUTE', filePath: 'src/routes.ts' });

    const stats = store.getStats();
    expect(stats.totalRoutes).toBe(1);
    expect(stats.totalResourceRoutes).toBe(1);
    expect(stats.totalTestFixtureRoutes).toBe(2);
  });
});
