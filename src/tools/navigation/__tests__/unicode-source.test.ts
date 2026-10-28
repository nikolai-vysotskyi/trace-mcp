import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../../config.js';
import { initializeDatabase } from '../../../db/schema.js';
import { Store } from '../../../db/store.js';
import { IndexingPipeline } from '../../../indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../../indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../../plugin-api/registry.js';
import { getContextBundle } from '../context-bundle.js';
import { getSymbol } from '../navigation.js';

describe('indexed Unicode source ranges', () => {
  it.each(['é à ê', 'Привет', '漢字かな', '😀🚀'])(
    'returns exact get_symbol and bundle source after %s',
    async (prefix) => {
      const root = mkdtempSync(join(tmpdir(), 'trace-unicode-source-'));
      const db: Database.Database = initializeDatabase(join(root, 'index.db'));
      const store = new Store(db);
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
      const pipeline = new IndexingPipeline(
        store,
        registry,
        TraceMcpConfigSchema.parse({ root }),
        root,
      );
      try {
        mkdirSync(join(root, 'src'));
        const body = 'export function café() { return "exact"; }';
        writeFileSync(join(root, 'src', 'unicode.ts'), `// ${prefix}\n${body}\n`);
        const indexed = await pipeline.indexFiles(['src/unicode.ts']);
        expect(indexed.errors).toBe(0);
        const file = store.getFile('src/unicode.ts');
        expect(file).toBeTruthy();
        const symbol = store.getSymbolsByFile(file!.id).find((item) => item.name === 'café');
        expect(symbol).toBeTruthy();

        const single = getSymbol(store, root, { symbolId: symbol!.symbol_id });
        expect(single.isOk()).toBe(true);
        expect(single._unsafeUnwrap().source).toBe(body);

        const bundle = getContextBundle(store, root, {
          symbolIds: [symbol!.symbol_id],
          outputFormat: 'markdown',
          tokenBudget: 8000,
        });
        expect(bundle.isOk()).toBe(true);
        expect(bundle._unsafeUnwrap().content).toContain(body.slice('export '.length));
      } finally {
        await pipeline.dispose?.();
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
