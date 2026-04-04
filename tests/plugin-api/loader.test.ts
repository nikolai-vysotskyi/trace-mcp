import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadExternalPlugins } from '../../src/plugin-api/loader.js';
import { createTestHarness } from '../../src/plugin-api/test-harness.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';

let tmpDir: string;

describe('loadExternalPlugins', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-plugin-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a plugin from a relative path with default object export', async () => {
    const pluginCode = `
export default {
  manifest: { name: 'test-plugin', version: '1.0.0', priority: 100 },
  supportedExtensions: ['.custom'],
  extractSymbols(filePath, content) {
    return { value: { status: 'ok', symbols: [] } };
  },
};
`;
    fs.writeFileSync(path.join(tmpDir, 'my-plugin.mjs'), pluginCode);

    const plugins = await loadExternalPlugins(['./my-plugin.mjs'], tmpDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.manifest.name).toBe('test-plugin');
  });

  it('loads a plugin from a factory function export', async () => {
    const pluginCode = `
export default function() {
  return {
    manifest: { name: 'factory-plugin', version: '1.0.0', priority: 50 },
    supportedExtensions: ['.xyz'],
    extractSymbols(filePath, content) {
      return { value: { status: 'ok', symbols: [] } };
    },
  };
}
`;
    fs.writeFileSync(path.join(tmpDir, 'factory-plugin.mjs'), pluginCode);

    const plugins = await loadExternalPlugins(['./factory-plugin.mjs'], tmpDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.manifest.name).toBe('factory-plugin');
  });

  it('skips plugins with no default export', async () => {
    const pluginCode = `export const name = 'not-a-plugin';\n`;
    fs.writeFileSync(path.join(tmpDir, 'bad.mjs'), pluginCode);

    const plugins = await loadExternalPlugins(['./bad.mjs'], tmpDir);
    expect(plugins).toHaveLength(0);
  });

  it('skips plugins that fail to load', async () => {
    const plugins = await loadExternalPlugins(['./nonexistent.mjs'], tmpDir);
    expect(plugins).toHaveLength(0);
  });

  it('skips plugins that do not conform to the interface', async () => {
    const pluginCode = `export default { foo: 'bar' };\n`;
    fs.writeFileSync(path.join(tmpDir, 'invalid.mjs'), pluginCode);

    const plugins = await loadExternalPlugins(['./invalid.mjs'], tmpDir);
    expect(plugins).toHaveLength(0);
  });
});

describe('createTestHarness', () => {
  it('indexes a file and returns symbols', async () => {
    const plugin = new PhpLanguagePlugin();
    const harness = createTestHarness(plugin);

    const phpCode = `<?php\nclass Foo {\n  public function bar(): void {}\n}\n`;
    const result = await harness.indexFile('test.php', phpCode);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.symbols.length).toBeGreaterThan(0);

    const symbols = harness.getSymbols();
    expect(symbols.length).toBeGreaterThan(0);

    const fooClass = symbols.find((s) => s.name === 'Foo');
    expect(fooClass).toBeDefined();
    expect(fooClass!.kind).toBe('class');
  });

  it('returns file ID for indexed files', async () => {
    const plugin = new PhpLanguagePlugin();
    const harness = createTestHarness(plugin);

    await harness.indexFile('src/Test.php', '<?php class Test {}');
    const fileId = harness.getFileId('src/Test.php');
    expect(fileId).toBeDefined();
    expect(typeof fileId).toBe('number');
  });
});
