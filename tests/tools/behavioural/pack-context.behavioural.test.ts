/**
 * Behavioural coverage for `packContext()`. Hand-builds an in-memory Store
 * with a few files + symbols and asserts the documented PackResult contract:
 * shape, format switching, token budget, scope=module narrowing, compress.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { packContext } from '../../../src/tools/refactoring/pack-context.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
  registry: PluginRegistry;
  projectRoot: string;
}

function seed(): Fixture {
  const store = createTestStore();
  const registry = new PluginRegistry();

  const authFile = store.insertFile('src/auth/provider.ts', 'typescript', 'h-auth', 400);
  store.insertSymbol(authFile, {
    symbolId: 'src/auth/provider.ts::AuthProvider#class',
    name: 'AuthProvider',
    kind: 'class',
    fqn: 'AuthProvider',
    byteStart: 0,
    byteEnd: 150,
    lineStart: 1,
    lineEnd: 12,
    signature: 'class AuthProvider',
  });
  store.insertSymbol(authFile, {
    symbolId: 'src/auth/provider.ts::login#method',
    name: 'login',
    kind: 'method',
    fqn: 'AuthProvider.login',
    byteStart: 160,
    byteEnd: 260,
    lineStart: 14,
    lineEnd: 22,
    signature: 'login(user: string, pass: string): Promise<Token>',
  });

  const utilFile = store.insertFile('src/utils/format.ts', 'typescript', 'h-fmt', 200);
  store.insertSymbol(utilFile, {
    symbolId: 'src/utils/format.ts::formatCurrency#function',
    name: 'formatCurrency',
    kind: 'function',
    fqn: 'formatCurrency',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 5,
    signature: 'function formatCurrency(amount: number): string',
  });

  return { store, registry, projectRoot: '/tmp/fake-proj' };
}

describe('packContext() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('returns shape { content, format, token_count, token_budget, files_included, sections }', () => {
    const result = packContext(ctx.store, ctx.registry, {
      scope: 'project',
      format: 'markdown',
      maxTokens: 5_000,
      include: ['file_tree', 'outlines'],
      compress: false,
      projectRoot: ctx.projectRoot,
    });
    expect(typeof result.content).toBe('string');
    expect(typeof result.format).toBe('string');
    expect(typeof result.token_count).toBe('number');
    expect(result.token_budget).toBe(5_000);
    expect(typeof result.files_included).toBe('number');
    expect(Array.isArray(result.sections)).toBe(true);
  });

  it('respects max_tokens — token_count stays under budget', () => {
    const result = packContext(ctx.store, ctx.registry, {
      scope: 'project',
      format: 'markdown',
      maxTokens: 500,
      include: ['file_tree', 'outlines'],
      compress: false,
      projectRoot: ctx.projectRoot,
    });
    expect(result.token_count).toBeLessThanOrEqual(500);
  });

  it("format='markdown' returns markdown-style headers", () => {
    const result = packContext(ctx.store, ctx.registry, {
      scope: 'project',
      format: 'markdown',
      maxTokens: 5_000,
      include: ['file_tree', 'outlines'],
      compress: false,
      projectRoot: ctx.projectRoot,
    });
    expect(result.format).toBe('markdown');
    // markdown header from the impl: "# Context Pack: project"
    expect(result.content).toContain('# Context Pack: project');
  });

  it("format='xml' returns XML-style tags", () => {
    const result = packContext(ctx.store, ctx.registry, {
      scope: 'project',
      format: 'xml',
      maxTokens: 5_000,
      include: ['file_tree', 'outlines'],
      compress: false,
      projectRoot: ctx.projectRoot,
    });
    expect(result.format).toBe('xml');
    expect(result.content).toContain('<context scope="project"');
  });

  it("scope='module' + path narrows file_tree to the subdir", () => {
    const result = packContext(ctx.store, ctx.registry, {
      scope: 'module',
      path: 'src/auth',
      format: 'markdown',
      maxTokens: 5_000,
      include: ['file_tree', 'outlines'],
      compress: false,
      projectRoot: ctx.projectRoot,
    });
    expect(result.content).toContain('src/auth');
    // utility file outside the scope must not appear in the tree
    expect(result.content).not.toContain('src/utils/format.ts');
  });

  it("strategy='compact' forces compression (drops the heavy 'source' section)", () => {
    const result = packContext(ctx.store, ctx.registry, {
      scope: 'project',
      format: 'markdown',
      maxTokens: 5_000,
      include: ['outlines', 'source'],
      compress: false,
      projectRoot: ctx.projectRoot,
      strategy: 'compact',
    });
    // compact strategy strips 'source' from the include set
    expect(result.sections).not.toContain('source');
    // outlines still surface signatures
    expect(result.content).toContain('class AuthProvider');
  });
});
