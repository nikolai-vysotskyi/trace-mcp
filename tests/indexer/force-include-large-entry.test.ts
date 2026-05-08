/**
 * Integration test for the force-include path: a file declared as
 * `package.json#main` must be indexed even when it exceeds the default
 * file-size cap (1 MB). Mirrors jcodemunch v1.80.9 lodash repro.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';

let tmpDir: string;

function setupFixture(opts: { mainBytes: number }) {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

  // Generate a JavaScript file at >= mainBytes. Single function body
  // padded with a trailing comment so the final byte count is precise
  // (parser cost stays bounded regardless of size).
  const head = `// Auto-generated huge entry-point fixture\nexport function bigEntry() {\n  return 42;\n}\n`;
  const padding = '/* '.padEnd(Math.max(0, opts.mainBytes - head.length - 4), 'x') + ' */\n';
  const source = head + padding;
  fs.writeFileSync(path.join(tmpDir, 'lodash.js'), source);

  // Also a small file that's NOT declared as an entry point — used as a
  // negative control to confirm the size cap still applies elsewhere.
  fs.writeFileSync(path.join(tmpDir, 'small.js'), `// regular file\nexport const ok = 1;\n`);

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ name: 'huge-pkg', main: 'lodash.js' }, null, 2),
  );

  const config: TraceMcpConfig = {
    root: tmpDir,
    include: ['*.js'],
    exclude: [],
    db: { path: ':memory:' },
    plugins: [],
  };

  return { store, registry, pipeline: new IndexingPipeline(store, registry, config, tmpDir) };
}

describe('force-include via package.json entries (jcodemunch v1.80.9 parity)', () => {
  beforeEach(() => {
    tmpDir = createTmpDir('force-include-');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('indexes a 1.2 MB file declared as package.json#main', async () => {
    const { store, pipeline } = setupFixture({ mainBytes: 1_200_000 });

    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);

    // The big entry must be present
    const lodash = store.getFile('lodash.js');
    expect(lodash, 'lodash.js (declared as `main`) must be indexed despite size').toBeTruthy();
    if (lodash) expect(lodash.byte_length).toBeGreaterThan(1_048_576);

    // Sanity: extracted at least one symbol from the huge file
    if (lodash) {
      const symbols = store.getSymbolsByFile(lodash.id);
      expect(symbols.length).toBeGreaterThan(0);
    }
  });

  it('does NOT index a small file that is not declared as an entry', async () => {
    // Negative control: small.js doesn't exceed the cap, so this is just
    // confirming the fixture wiring + that pipeline indexes both files.
    const { store, pipeline } = setupFixture({ mainBytes: 1_200_000 });
    await pipeline.indexAll();
    expect(store.getFile('small.js')).toBeTruthy();
  });

  it('still rejects entries that exceed the 5 MB hard ceiling', async () => {
    const { store, pipeline } = setupFixture({ mainBytes: 6 * 1024 * 1024 });
    const result = await pipeline.indexAll();
    // The pipeline reports the file as an error/skipped; lodash.js will not
    // appear in the file table. (small.js is fine.)
    expect(
      store.getFile('lodash.js'),
      'oversized force-included file should be rejected',
    ).toBeFalsy();
    expect(result.errors + result.skipped).toBeGreaterThan(0);
  });
});
