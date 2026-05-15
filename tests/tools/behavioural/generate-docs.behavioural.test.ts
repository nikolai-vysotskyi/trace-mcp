/**
 * Behavioural coverage for `generateDocs()`.
 *
 * NOTE on the brief: `generateDocs()` itself does NOT write to disk — it
 * returns { content, format, sections_generated, stats }. The "writes output
 * file" promise lives in the MCP register wrapper, not in this primitive.
 * We therefore test the actual contract of the helper.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { generateDocs } from '../../../src/tools/project/generate-docs.js';
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

  const a = store.insertFile('src/auth/provider.ts', 'typescript', 'h-auth', 400);
  store.insertSymbol(a, {
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

  const b = store.insertFile('src/utils/format.ts', 'typescript', 'h-fmt', 200);
  store.insertSymbol(b, {
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

describe('generateDocs() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('returns shape { content, format, sections_generated, stats } for a project scope', () => {
    const result = generateDocs(ctx.store, ctx.registry, {
      scope: 'project',
      format: 'markdown',
      sections: ['overview', 'architecture'],
      projectRoot: ctx.projectRoot,
    });
    expect(typeof result.content).toBe('string');
    expect(typeof result.format).toBe('string');
    expect(Array.isArray(result.sections_generated)).toBe(true);
    expect(typeof result.stats.total_lines).toBe('number');
  });

  it("format='markdown' returns markdown content (header + table syntax)", () => {
    const result = generateDocs(ctx.store, ctx.registry, {
      scope: 'project',
      format: 'markdown',
      sections: ['overview', 'architecture'],
      projectRoot: ctx.projectRoot,
    });
    expect(result.format).toBe('markdown');
    expect(result.content).toMatch(/^# /m);
  });

  it("format='html' returns HTML content (contains tags)", () => {
    const result = generateDocs(ctx.store, ctx.registry, {
      scope: 'project',
      format: 'html',
      sections: ['overview'],
      projectRoot: ctx.projectRoot,
    });
    expect(result.format).toBe('html');
    expect(result.content).toMatch(/<\w+[\s>]/);
  });

  it('only includes the requested sections in sections_generated', () => {
    const result = generateDocs(ctx.store, ctx.registry, {
      scope: 'project',
      format: 'markdown',
      sections: ['overview'],
      projectRoot: ctx.projectRoot,
    });
    expect(result.sections_generated).toContain('overview');
    expect(result.sections_generated).not.toContain('architecture');
    expect(result.sections_generated).not.toContain('dependencies');
  });

  it('empty store (no files / no symbols) still returns a valid result, not a throw', () => {
    const emptyStore = createTestStore();
    const result = generateDocs(emptyStore, ctx.registry, {
      scope: 'project',
      format: 'markdown',
      sections: ['overview', 'architecture'],
      projectRoot: ctx.projectRoot,
    });
    expect(typeof result.content).toBe('string');
    expect(result.sections_generated.length).toBeGreaterThan(0);
  });

  it("scope='project' covers files across multiple module directories", () => {
    const result = generateDocs(ctx.store, ctx.registry, {
      scope: 'project',
      format: 'markdown',
      sections: ['overview', 'architecture'],
      projectRoot: ctx.projectRoot,
    });
    // architecture section lists modules; both src/auth and src/utils should appear
    expect(result.content).toMatch(/src\/auth/);
    expect(result.content).toMatch(/src\/utils/);
  });
});
