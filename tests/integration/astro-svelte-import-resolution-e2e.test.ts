/**
 * Astro/Svelte cross-file import resolution E2E (TRA-451).
 *
 * Unlike Go/Java/Rust/C/C++/Ruby, Astro and Svelte needed no new resolver
 * pass. Both plugins already emit `imports` edges with plain filesystem-path
 * specifiers — Astro's frontmatter/`<script>` blocks are re-parsed with the
 * same tree-sitter helper TypeScript uses, Svelte's regex plugin already
 * writes `module` specifiers into the shape `resolveEsmImportEdges` expects —
 * so the only gap was that neither language was in `ESM_IMPORT_LANGUAGES`,
 * which made the pass skip every file of that language outright. These tests
 * pin: an Astro file's own `.astro` and `.ts` imports, a Svelte file's own
 * `.svelte` and `.ts` imports, and the pre-existing direction (a `.ts` file
 * importing a `.svelte`/`.astro` component) that already worked before this
 * change.
 *
 * Uses an on-disk fixture (like split-imports.test.ts) rather than
 * `createTmpFixture`: `resolveEsmImportEdges` resolves specifiers through
 * oxc-resolver, which returns realpath'd targets, and `os.tmpdir()` is a
 * symlink on some hosts — the realpath'd target then falls outside
 * `state.rootPath` and the edge is (wrongly) treated as external.
 */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { AstroLanguagePlugin } from '../../src/indexer/plugins/language/astro/index.js';
import { SvelteLanguagePlugin } from '../../src/indexer/plugins/language/svelte/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const fixturePath = path.resolve(__dirname, '../fixtures/astro-svelte-imports');

function importTargets(store: Store, sourcePath: string): Set<string> {
  const file = store.getFile(sourcePath);
  if (!file) return new Set();
  const nodeId = store.getNodeId('file', file.id);
  if (nodeId == null) return new Set();
  const targets = new Set<string>();
  for (const edge of store.getOutgoingEdges(nodeId)) {
    if (edge.edge_type_name !== 'imports') continue;
    const ref = store.getNodeRef(edge.target_node_id);
    if (ref?.nodeType === 'file') targets.add(store.getFileById(ref.refId)?.path ?? '');
  }
  return targets;
}

describe('Astro/Svelte import resolution E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new AstroLanguagePlugin());
    registry.registerLanguagePlugin(new SvelteLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.astro', '**/*.svelte', '**/*.ts'],
      exclude: ['node_modules/**'],
    });

    await new IndexingPipeline(store, registry, config, fixturePath).indexAll();
  });

  it('resolves a Svelte component import to another Svelte file', () => {
    expect(importTargets(store, 'src/components/Parent.svelte')).toContain(
      'src/components/Child.svelte',
    );
  });

  it('resolves a Svelte script import to a TypeScript file', () => {
    expect(importTargets(store, 'src/components/Parent.svelte')).toContain('src/lib/util.ts');
  });

  it('resolves an Astro frontmatter import to another Astro file', () => {
    expect(importTargets(store, 'src/pages/index.astro')).toContain('src/layouts/Layout.astro');
  });

  it('resolves an Astro frontmatter import to a TypeScript file', () => {
    expect(importTargets(store, 'src/pages/index.astro')).toContain('src/lib/util.ts');
  });

  it('still resolves a TypeScript import into a Svelte/Astro component (pre-existing direction)', () => {
    const targets = importTargets(store, 'src/consumer.ts');
    expect(targets).toContain('src/components/Parent.svelte');
    expect(targets).toContain('src/pages/index.astro');
  });
});
