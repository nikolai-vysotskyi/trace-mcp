import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCorpus, CorpusBuildError } from '../../src/memory/corpus-builder.js';
import { CorpusStore } from '../../src/memory/corpus-store.js';

// We mock packContext to keep these tests focused on the builder's
// orchestration logic (validation, overwrite, manifest shape, persistence).
// Full pack-pipeline behaviour is covered by pack-context's own tests.
vi.mock('../../src/tools/refactoring/pack-context.js', () => ({
  packContext: vi.fn(),
}));
import { packContext } from '../../src/tools/refactoring/pack-context.js';

const mockPack = vi.mocked(packContext);

describe('buildCorpus', () => {
  let tmpRoot: string;
  let corpora: CorpusStore;

  // The builder doesn't actually touch Store / PluginRegistry — packContext
  // does. The mock above bypasses that layer entirely so we can pass
  // sentinel values.
  // biome-ignore lint/suspicious/noExplicitAny: test-only sentinel
  const fakeStore = {} as any;
  // biome-ignore lint/suspicious/noExplicitAny: test-only sentinel
  const fakeRegistry = {} as any;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-builder-test-'));
    corpora = new CorpusStore({ rootDir: tmpRoot });
    mockPack.mockReset();
    mockPack.mockReturnValue({
      format: 'markdown',
      content: '# packed body',
      token_count: 1234,
      token_budget: 50_000,
      files_included: 7,
      sections: ['outlines', 'source'],
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('builds a feature-scoped corpus and persists manifest + body', () => {
    const manifest = buildCorpus(
      { store: fakeStore, registry: fakeRegistry, corpora },
      {
        name: 'auth',
        projectRoot: '/repo',
        scope: 'feature',
        featureQuery: 'authentication',
      },
    );

    expect(manifest.name).toBe('auth');
    expect(manifest.scope).toBe('feature');
    expect(manifest.featureQuery).toBe('authentication');
    expect(manifest.fileCount).toBe(7);
    expect(manifest.estimatedTokens).toBe(1234);
    expect(manifest.tokenBudget).toBe(50_000);
    expect(manifest.packStrategy).toBe('most_relevant');

    expect(corpora.exists('auth')).toBe(true);
    expect(corpora.loadPackedBody('auth')).toContain('# packed body');
  });

  it('rejects invalid corpus names before calling packContext', () => {
    expect(() =>
      buildCorpus(
        { store: fakeStore, registry: fakeRegistry, corpora },
        { name: '../escape', projectRoot: '/repo', scope: 'project' },
      ),
    ).toThrow();
    expect(mockPack).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an existing corpus by default', () => {
    buildCorpus(
      { store: fakeStore, registry: fakeRegistry, corpora },
      { name: 'auth', projectRoot: '/repo', scope: 'project' },
    );

    expect(() =>
      buildCorpus(
        { store: fakeStore, registry: fakeRegistry, corpora },
        { name: 'auth', projectRoot: '/repo', scope: 'project' },
      ),
    ).toThrow(CorpusBuildError);
  });

  it('overwrite=true preserves createdAt and updates updatedAt', async () => {
    const first = buildCorpus(
      { store: fakeStore, registry: fakeRegistry, corpora },
      { name: 'auth', projectRoot: '/repo', scope: 'project' },
    );
    // Force the clock to advance.
    await new Promise((r) => setTimeout(r, 10));

    const second = buildCorpus(
      { store: fakeStore, registry: fakeRegistry, corpora },
      { name: 'auth', projectRoot: '/repo', scope: 'project', overwrite: true },
    );

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  it('rejects scope=module without modulePath', () => {
    expect(() =>
      buildCorpus(
        { store: fakeStore, registry: fakeRegistry, corpora },
        { name: 'mod', projectRoot: '/repo', scope: 'module' },
      ),
    ).toThrow(/modulePath/);
  });

  it('rejects scope=feature without featureQuery', () => {
    expect(() =>
      buildCorpus(
        { store: fakeStore, registry: fakeRegistry, corpora },
        { name: 'feat', projectRoot: '/repo', scope: 'feature' },
      ),
    ).toThrow(/featureQuery/);
  });

  it('throws when packContext yields empty content', () => {
    mockPack.mockReturnValueOnce({
      format: 'markdown',
      content: '   ',
      token_count: 0,
      token_budget: 1000,
      files_included: 0,
      sections: [],
    });
    expect(() =>
      buildCorpus(
        { store: fakeStore, registry: fakeRegistry, corpora },
        { name: 'empty', projectRoot: '/repo', scope: 'project' },
      ),
    ).toThrow(CorpusBuildError);
    expect(corpora.exists('empty')).toBe(false);
  });

  it('forwards strategy + tokenBudget to packContext', () => {
    buildCorpus(
      { store: fakeStore, registry: fakeRegistry, corpora },
      {
        name: 'compact',
        projectRoot: '/repo',
        scope: 'project',
        tokenBudget: 8_000,
        packStrategy: 'compact',
      },
    );
    expect(mockPack).toHaveBeenCalledWith(
      fakeStore,
      fakeRegistry,
      expect.objectContaining({
        scope: 'project',
        maxTokens: 8_000,
        strategy: 'compact',
        format: 'markdown',
        projectRoot: '/repo',
      }),
    );
  });
});
