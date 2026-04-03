import { initializeDatabase } from '../db/schema.js';
import { Store, type SymbolRow, type EdgeRow } from '../db/store.js';
import { PluginRegistry } from './registry.js';
import type { LanguagePlugin, FrameworkPlugin, FileParseResult } from './types.js';
import { executeLanguagePlugin, executeFrameworkExtractNodes } from './executor.js';

export interface PluginTestHarness {
  store: Store;
  registry: PluginRegistry;
  indexFile(path: string, content: string): Promise<FileParseResult | null>;
  getSymbols(): SymbolRow[];
  getEdges(): EdgeRow[];
  getFileId(path: string): number | undefined;
}

/**
 * Create an in-memory test harness for testing plugins in isolation.
 * Provides a Store, Registry, and helpers for indexing files and inspecting results.
 */
export function createTestHarness(
  plugin: LanguagePlugin | FrameworkPlugin,
): PluginTestHarness {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  const registry = new PluginRegistry();

  const isLanguagePlugin = 'supportedExtensions' in plugin;
  if (isLanguagePlugin) {
    registry.registerLanguagePlugin(plugin as LanguagePlugin);
  } else {
    registry.registerFrameworkPlugin(plugin as FrameworkPlugin);
  }

  return {
    store,
    registry,

    async indexFile(filePath: string, content: string): Promise<FileParseResult | null> {
      const buf = Buffer.from(content, 'utf-8');

      if (isLanguagePlugin) {
        const result = await executeLanguagePlugin(plugin as LanguagePlugin, filePath, buf);
        if (result.isErr()) return null;

        const parsed = result.value;
        const fileId = store.insertFile(filePath, parsed.language ?? 'unknown', null, buf.length);
        if (parsed.symbols.length > 0) {
          store.insertSymbols(fileId, parsed.symbols);
        }
        return parsed;
      }

      // Framework plugin: extractNodes
      const fwPlugin = plugin as FrameworkPlugin;
      if (!fwPlugin.extractNodes) return null;

      const ext = filePath.slice(filePath.lastIndexOf('.') + 1);
      const result = await executeFrameworkExtractNodes(fwPlugin, filePath, buf, ext);
      if (result.isErr() || !result.value) return null;

      const parsed = result.value;
      const fileId = store.insertFile(filePath, parsed.language ?? ext, null, buf.length);
      if (parsed.symbols.length > 0) {
        store.insertSymbols(fileId, parsed.symbols);
      }
      return parsed;
    },

    getSymbols(): SymbolRow[] {
      const files = store.getAllFiles();
      const symbols: SymbolRow[] = [];
      for (const f of files) {
        symbols.push(...store.getSymbolsByFile(f.id));
      }
      return symbols;
    },

    getEdges(): EdgeRow[] {
      return db.prepare('SELECT * FROM edges').all() as EdgeRow[];
    },

    getFileId(filePath: string): number | undefined {
      return store.getFile(filePath)?.id;
    },
  };
}
