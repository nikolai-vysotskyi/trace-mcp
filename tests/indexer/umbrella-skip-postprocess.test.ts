/**
 * A non-git umbrella root (a folder of git repos) must be able to skip the
 * full postprocess when nothing changed, the way a git root does via HEAD.
 * Before the nested-heads key, every watcher-overflow reconcile on an
 * umbrella re-resolved the whole graph even with indexed === 0.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { _resetNestedWorktreeCache } from '../../src/registry.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'pipe',
  });

describe('umbrella root postprocess skip', () => {
  it('skips re-resolution when no nested HEAD moved, resolves again after a commit', async () => {
    const umbrella = mkdtempSync(join(tmpdir(), 'trace-umbrella-skip-'));
    const repo = join(umbrella, 'app');
    mkdirSync(repo);
    writeFileSync(join(repo, 'b.ts'), 'export const b = 1;\n');
    writeFileSync(join(repo, 'a.ts'), "import { b } from './b';\nexport const a = b;\n");
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    _resetNestedWorktreeCache();

    const store = new Store(initializeDatabase(':memory:'));
    const config = {
      include: ['**/*.ts'],
      exclude: ['node_modules/**'],
      ignore: { use_gitignore: true, additional_patterns: [] },
    } as unknown as TraceMcpConfig;
    const plugins = new PluginRegistry();
    plugins.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const pipeline = new IndexingPipeline(store, plugins, config, umbrella);
    const resolveSpy = vi.spyOn(
      IndexingPipeline.prototype as unknown as { resolveAllEdges: () => Promise<void> },
      'resolveAllEdges',
    );
    try {
      await pipeline.indexAll(false);
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(store.getStats().totalEdges).toBeGreaterThan(0);

      const unchanged = await pipeline.indexAll(false);
      expect(unchanged.indexed).toBe(0);
      expect(resolveSpy).toHaveBeenCalledTimes(1);

      git(repo, 'commit', '-q', '--allow-empty', '-m', 'move HEAD');
      await pipeline.indexAll(false);
      expect(resolveSpy).toHaveBeenCalledTimes(2);
    } finally {
      resolveSpy.mockRestore();
      rmSync(umbrella, { recursive: true, force: true });
    }
  });
});
