/**
 * Tests for the postprocess level knob on the indexing pipeline.
 *
 * The contract:
 *   - default postprocess level is 'full'
 *   - 'minimal' skips LSP enrichment + env-var scan + git history snapshots
 *   - 'none' also skips edge resolution (raw symbol pass only)
 *   - the level is surfaced on IndexingResult so callers know what ran
 *
 * We assert the contract via spies on the pipeline's private phase methods.
 * The methods are private, but the tests reach in via the prototype to keep
 * the production class clean.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import type { TraceMcpConfig } from '../../src/config.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'trace-postproc-'));
  writeFileSync(join(root, 'package.json'), '{"name":"x","version":"0"}');
  writeFileSync(join(root, 'src.ts'), 'export const x = 1;\n');
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  const registry = new PluginRegistry();
  const config = {
    include: ['**/*.ts'],
    exclude: ['node_modules/**'],
    ignore: { use_gitignore: true, additional_patterns: [] },
  } as unknown as TraceMcpConfig;
  const pipeline = new IndexingPipeline(store, registry, config, root);
  return { root, store, registry, config, pipeline };
}

function cleanup(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

describe('IndexingPipeline postprocess level', () => {
  it('reports postprocess="full" by default', async () => {
    const { root, pipeline } = fixture();
    try {
      const r = await pipeline.indexAll(true);
      expect(r.postprocess).toBe('full');
    } finally {
      cleanup(root);
    }
  });

  it('skips LSP + env scan when postprocess="minimal"', async () => {
    const { root, pipeline } = fixture();
    try {
      const lspSpy = vi
        .spyOn(
          IndexingPipeline.prototype as unknown as { runLspEnrichment: () => Promise<void> },
          'runLspEnrichment',
        )
        .mockResolvedValue();
      const envSpy = vi
        .spyOn(
          IndexingPipeline.prototype as unknown as { indexEnvFiles: () => Promise<void> },
          'indexEnvFiles',
        )
        .mockResolvedValue();
      const resolveSpy = vi
        .spyOn(
          IndexingPipeline.prototype as unknown as { resolveAllEdges: () => Promise<void> },
          'resolveAllEdges',
        )
        .mockResolvedValue();

      const r = await pipeline.indexAll(true, { postprocess: 'minimal' });
      expect(r.postprocess).toBe('minimal');
      expect(lspSpy).not.toHaveBeenCalled();
      expect(envSpy).not.toHaveBeenCalled();
      // Edge resolution still runs in 'minimal'.
      expect(resolveSpy).toHaveBeenCalled();

      lspSpy.mockRestore();
      envSpy.mockRestore();
      resolveSpy.mockRestore();
    } finally {
      cleanup(root);
    }
  });

  it('skips edge resolution + LSP + env when postprocess="none"', async () => {
    const { root, pipeline } = fixture();
    try {
      const lspSpy = vi
        .spyOn(
          IndexingPipeline.prototype as unknown as { runLspEnrichment: () => Promise<void> },
          'runLspEnrichment',
        )
        .mockResolvedValue();
      const envSpy = vi
        .spyOn(
          IndexingPipeline.prototype as unknown as { indexEnvFiles: () => Promise<void> },
          'indexEnvFiles',
        )
        .mockResolvedValue();
      const resolveSpy = vi
        .spyOn(
          IndexingPipeline.prototype as unknown as { resolveAllEdges: () => Promise<void> },
          'resolveAllEdges',
        )
        .mockResolvedValue();

      const r = await pipeline.indexAll(true, { postprocess: 'none' });
      expect(r.postprocess).toBe('none');
      expect(lspSpy).not.toHaveBeenCalled();
      expect(envSpy).not.toHaveBeenCalled();
      expect(resolveSpy).not.toHaveBeenCalled();

      lspSpy.mockRestore();
      envSpy.mockRestore();
      resolveSpy.mockRestore();
    } finally {
      cleanup(root);
    }
  });
});
