/**
 * TRA-1098: `register_edit`'s `_duplication_warnings` must not re-report the
 * same similarity on every edit, and must not lose a real one to do it.
 *
 * The check ran over every symbol in the reindexed file, so an agent editing
 * one file forty times in a session was told forty times about five
 * similarities that predated the session. Measured on this repo that was
 * 84-87% of the whole response (239-330 of 290-380 tokens), on the fourth
 * busiest tool in the product.
 *
 * The first attempt at this snapshotted the file's symbols before reindexing
 * and reported only what was new. Review found the race that breaks it: a
 * single edit fires three reindex paths (watcher, PostToolUse hook,
 * `register_edit`) with skew documented at over 500ms in
 * `recent-reindex-cache.ts`, so if another path indexes first the "pre-edit"
 * snapshot is already post-edit and the genuinely new symbol is filtered out
 * as pre-existing — silently. The third test below is that race, and it is the
 * reason the shipped fix memoises what was *reported* instead of reading the
 * store.
 *
 * The tool is inline-registered, so this drives the real handler through
 * `McpServer._registeredTools` (same approach as
 * `search-with-mode-dispatch.test.ts`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { __resetRecentReindexCache } from '../../src/indexer/recent-reindex-cache.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { resetDuplicationMemo } from '../../src/tools/analysis/duplication-memo.js';
import { registerCoreTools } from '../../src/tools/register/core.js';
import { createTestStore } from '../test-utils.js';

interface Warning {
  message: string;
  duplicate_symbol_id: string;
}

const DUPLICATE_BODY =
  '(items: number[]): number {\n  return items.reduce((sum, n) => sum + n, 0);\n}\n';

let root: string;
let call: (filePath: string) => Promise<{ _duplication_warnings?: Warning[] }>;
/** Simulates the watcher / PostToolUse hook winning the race to reindex. */
let reindexOutOfBand: (filePath: string) => Promise<void>;

beforeEach(async () => {
  resetDuplicationMemo();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-register-edit-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'src/a.ts'),
    `export function computeTotalPrice${DUPLICATE_BODY}`,
  );
  fs.writeFileSync(
    path.join(root, 'src/b.ts'),
    `export function computeTotalPriceB${DUPLICATE_BODY}`,
  );

  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const config = TraceMcpConfigSchema.parse({ root, include: ['src/**/*.ts'], exclude: [] });
  const pipeline = new IndexingPipeline(store, registry, config, root);
  await pipeline.indexAll(true);
  reindexOutOfBand = async (filePath) => {
    await pipeline.indexFiles([filePath]);
  };

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
    // Two calls on one file inside the 2s dedup TTL take the `skipped_recent`
    // exit and never reach the duplication check at all. Real sessions are
    // slower than this test; clear it so each call exercises the real path.
    __resetRecentReindexCache();
    const res = (await tools.register_edit.handler({ file_path: filePath }, {})) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(res.content[0].text);
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Append a genuine cross-file duplicate of `src/a.ts`'s symbol to `src/b.ts`. */
function introduceDuplicate(): void {
  fs.appendFileSync(
    path.join(root, 'src/b.ts'),
    `\nexport function computeTotalPrice${DUPLICATE_BODY}`,
  );
}

describe('register_edit — a duplication warning is reported once, not on every edit', () => {
  it('reports a similarity the first time and stays silent on the next edit', async () => {
    const first = await call('src/a.ts');
    expect((first._duplication_warnings ?? []).length).toBeGreaterThan(0);

    // Same file, nothing new: the agent has already read this.
    const second = await call('src/a.ts');
    expect(second._duplication_warnings).toBeUndefined();
  });

  it('still warns when a later edit introduces a duplicate it has not reported', async () => {
    await call('src/b.ts');
    introduceDuplicate();

    const out = await call('src/b.ts');
    const warnings = out._duplication_warnings ?? [];
    expect(warnings.length).toBeGreaterThan(0);
    // Only the pair it has not seen — `computeTotalPriceB` was reported above.
    for (const w of warnings) expect(w.message).toContain('"computeTotalPrice"');
    expect(warnings.some((w) => w.duplicate_symbol_id.includes('src/a.ts'))).toBe(true);
  });

  it('warns even when another reindex path indexed the edit first', async () => {
    await call('src/b.ts');
    introduceDuplicate();
    // The watcher or the PostToolUse hook gets there before the agent's call.
    // A store-diffing implementation reports nothing here; this one must not.
    await reindexOutOfBand('src/b.ts');

    const out = await call('src/b.ts');
    const warnings = out._duplication_warnings ?? [];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.message.includes('"computeTotalPrice"'))).toBe(true);
  });
});
