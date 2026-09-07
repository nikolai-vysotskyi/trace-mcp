/**
 * TRA-1098: `register_edit`'s `_duplication_warnings` must describe symbols the
 * edit *introduced*, not everything in the file that resembles something else.
 *
 * Before this, the check ran over every symbol in the reindexed file, so an
 * agent editing the same file forty times in a session was told forty times
 * about five similarities that predated the session. Measured on this repo, it
 * was 84-87% of the whole `register_edit` response (239-330 of 290-380 tokens)
 * — and `register_edit` is the fourth busiest tool by call volume.
 *
 * The tool is inline-registered, so this drives the real handler through
 * `McpServer._registeredTools` (same approach as
 * `search-with-mode-dispatch.test.ts`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { registerCoreTools } from '../../src/tools/register/core.js';
import { createTestStore } from '../test-utils.js';

interface Warning {
  message: string;
  duplicate_symbol_id: string;
}

let root: string;
let call: (filePath: string) => Promise<{ _duplication_warnings?: Warning[] }>;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-register-edit-'));
  fs.mkdirSync(path.join(root, 'src'));
  // `computeTotalPrice` exists in both files from the start: a pre-existing
  // similarity the agent did not just create.
  fs.writeFileSync(
    path.join(root, 'src/a.ts'),
    'export function computeTotalPrice(items: number[]): number {\n' +
      '  return items.reduce((sum, n) => sum + n, 0);\n}\n',
  );
  fs.writeFileSync(
    path.join(root, 'src/b.ts'),
    'export function computeTotalPriceB(items: number[]): number {\n' +
      '  return items.reduce((sum, n) => sum + n, 0);\n}\n',
  );

  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const config = TraceMcpConfigSchema.parse({
    root,
    include: ['src/**/*.ts'],
    exclude: [],
  });
  await new IndexingPipeline(store, registry, config, root).indexAll(true);

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerCoreTools(server, {
    store,
    registry,
    config,
    projectRoot: root,
    guardPath: () => null,
    j: (v: unknown) => JSON.stringify(v),
    jh: (_tool: string, v: unknown) => JSON.stringify(v),
    journal: { record: () => {} },
    vectorStore: null,
    embeddingService: null,
    progress: null,
    decisionStore: null,
  } as unknown as Parameters<typeof registerCoreTools>[1]);

  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (a: unknown, b: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;
  call = async (filePath) => {
    const res = (await tools.register_edit.handler({ file_path: filePath }, {})) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(res.content[0].text);
  };
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('register_edit — duplication warnings cover only what the edit introduced', () => {
  it('says nothing about a similarity that already existed before the edit', async () => {
    const out = await call('src/a.ts');
    expect(out._duplication_warnings).toBeUndefined();
  });

  it('still warns when the edit introduces a symbol that duplicates existing logic', async () => {
    fs.appendFileSync(
      path.join(root, 'src/b.ts'),
      '\nexport function computeTotalPrice(items: number[]): number {\n' +
        '  return items.reduce((sum, n) => sum + n, 0);\n}\n',
    );
    const out = await call('src/b.ts');
    const warnings = out._duplication_warnings ?? [];
    expect(warnings.length).toBeGreaterThan(0);
    // Every warning must be about the symbol this edit added, not about
    // `computeTotalPriceB`, which was there before.
    for (const w of warnings) expect(w.message).toContain('"computeTotalPrice"');
    expect(warnings.some((w) => w.duplicate_symbol_id.includes('src/a.ts'))).toBe(true);
  });
});
