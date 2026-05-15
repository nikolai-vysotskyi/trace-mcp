/**
 * Behavioural coverage for `buildCorpus()`. Seeds an in-memory Store with a
 * couple of files + symbols, points CorpusStore at a tmp rootDir, and asserts
 * the documented contract: manifest persistence, scope routing (project /
 * module / feature), token-budget propagation, and the overwrite/duplicate
 * error path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCorpus, CorpusBuildError } from '../../../src/memory/corpus-builder.js';
import { CorpusStore } from '../../../src/memory/corpus-store.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import type { Store } from '../../../src/db/store.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../../test-utils.js';

interface Fixture {
  store: Store;
  registry: PluginRegistry;
  corpora: CorpusStore;
  rootDir: string;
  projectRoot: string;
}

function seed(): Fixture {
  const rootDir = createTmpDir('trace-mcp-build-corpus-');
  const corpora = new CorpusStore({ rootDir });

  const store = createTestStore();
  const registry = new PluginRegistry();
  const projectRoot = '/tmp/fake-proj';

  // src/auth — bait for scope=module and scope=feature queries.
  const authFile = store.insertFile('src/auth/provider.ts', 'typescript', 'h-auth', 300);
  store.insertSymbol(authFile, {
    symbolId: 'src/auth/provider.ts::AuthProvider#class',
    name: 'AuthProvider',
    kind: 'class',
    fqn: 'AuthProvider',
    byteStart: 0,
    byteEnd: 120,
    lineStart: 1,
    lineEnd: 10,
    signature: 'class AuthProvider',
  });
  store.insertSymbol(authFile, {
    symbolId: 'src/auth/provider.ts::login#method',
    name: 'login',
    kind: 'method',
    fqn: 'AuthProvider.login',
    byteStart: 130,
    byteEnd: 220,
    lineStart: 12,
    lineEnd: 18,
    signature: 'login(user: string, pass: string): Promise<Token>',
  });

  // src/utils — a different module so scope=module narrows.
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

  return { store, registry, corpora, rootDir, projectRoot };
}

describe('buildCorpus() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    removeTmpDir(ctx.rootDir);
  });

  it('creates a project-scope corpus and persists the manifest', () => {
    const manifest = buildCorpus(
      { store: ctx.store, registry: ctx.registry, corpora: ctx.corpora },
      { name: 'my-proj', projectRoot: ctx.projectRoot, scope: 'project' },
    );
    expect(manifest.name).toBe('my-proj');
    expect(manifest.scope).toBe('project');
    expect(manifest.projectRoot).toBe(ctx.projectRoot);
    expect(typeof manifest.estimatedTokens).toBe('number');

    // Round-trip through the store
    expect(ctx.corpora.exists('my-proj')).toBe(true);
    const reloaded = ctx.corpora.load('my-proj');
    expect(reloaded?.name).toBe('my-proj');
    expect(ctx.corpora.loadPackedBody('my-proj')).not.toBeNull();
  });

  it('scope=module + module_path narrows to that subdir', () => {
    const manifest = buildCorpus(
      { store: ctx.store, registry: ctx.registry, corpora: ctx.corpora },
      {
        name: 'auth-only',
        projectRoot: ctx.projectRoot,
        scope: 'module',
        modulePath: 'src/auth',
      },
    );
    expect(manifest.scope).toBe('module');
    expect(manifest.modulePath).toBe('src/auth');
    const body = ctx.corpora.loadPackedBody('auth-only') ?? '';
    expect(body).toContain('src/auth');
  });

  it('scope=feature + feature_query records the query in the manifest', () => {
    const manifest = buildCorpus(
      { store: ctx.store, registry: ctx.registry, corpora: ctx.corpora },
      {
        name: 'feat-auth',
        projectRoot: ctx.projectRoot,
        scope: 'feature',
        featureQuery: 'authentication login provider',
      },
    );
    expect(manifest.scope).toBe('feature');
    expect(manifest.featureQuery).toBe('authentication login provider');
  });

  it('respects token_budget — estimatedTokens stays under the budget', () => {
    const manifest = buildCorpus(
      { store: ctx.store, registry: ctx.registry, corpora: ctx.corpora },
      {
        name: 'tight',
        projectRoot: ctx.projectRoot,
        scope: 'project',
        tokenBudget: 2_000,
      },
    );
    expect(manifest.tokenBudget).toBe(2_000);
    expect(manifest.estimatedTokens).toBeLessThanOrEqual(2_000);
  });

  it('duplicate name without overwrite throws CorpusBuildError', () => {
    buildCorpus(
      { store: ctx.store, registry: ctx.registry, corpora: ctx.corpora },
      { name: 'dup', projectRoot: ctx.projectRoot, scope: 'project' },
    );
    expect(() =>
      buildCorpus(
        { store: ctx.store, registry: ctx.registry, corpora: ctx.corpora },
        { name: 'dup', projectRoot: ctx.projectRoot, scope: 'project' },
      ),
    ).toThrow(CorpusBuildError);
  });

  it('overwrite=true replaces an existing corpus without throwing', () => {
    buildCorpus(
      { store: ctx.store, registry: ctx.registry, corpora: ctx.corpora },
      { name: 'replaceable', projectRoot: ctx.projectRoot, scope: 'project' },
    );
    const second = buildCorpus(
      { store: ctx.store, registry: ctx.registry, corpora: ctx.corpora },
      {
        name: 'replaceable',
        projectRoot: ctx.projectRoot,
        scope: 'project',
        overwrite: true,
        description: 'second pass',
      },
    );
    expect(second.description).toBe('second pass');
  });

  it('scope=module without modulePath surfaces a CorpusBuildError', () => {
    expect(() =>
      buildCorpus(
        { store: ctx.store, registry: ctx.registry, corpora: ctx.corpora },
        { name: 'no-path', projectRoot: ctx.projectRoot, scope: 'module' },
      ),
    ).toThrow(CorpusBuildError);
  });
});
