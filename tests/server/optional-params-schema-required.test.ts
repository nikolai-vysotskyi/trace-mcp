/**
 * TRA-962 — `get_change_impact({ file_path })` alone (no symbol_id) worked
 * fine against the raw handler, but the JSON Schema published to MCP clients
 * via `tools/list` listed `file_path` AND `symbol_id` as `required`, even
 * though both are optional in the zod schema and at runtime.
 *
 * Root cause: `optionalNonEmptyString`/`optionalEnum` were built as
 * `z.preprocess(coerce, inner.optional())` — the `.optional()` lived *inside*
 * the preprocess pipe. The MCP SDK's zod-v4 JSON Schema conversion renders a
 * tool's `inputSchema` from the *input* side of that pipe, which has no way
 * to express "optional" for an arbitrary transform, so every field built
 * this way published as `required` regardless of its real optionality.
 *
 * This drives a real MCP `Client` over an in-memory transport — the same way
 * an external client sees the server — rather than calling the registered
 * zod schema or the tool handler directly, since the discrepancy only shows
 * up in what's advertised over the wire.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { ProgressState } from '../../src/progress.js';
import { createServer } from '../../src/server/server.js';

async function bootServer() {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);

  const targetFile = store.insertFile('src/target.ts', 'typescript', 'h-target', 200);
  store.insertSymbol(targetFile, {
    symbolId: 'src/target.ts::Target#function',
    name: 'Target',
    kind: 'function',
    fqn: 'Target',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 10,
  });

  const registry = PluginRegistry.createWithDefaults();
  const progress = new ProgressState(db);
  const config = TraceMcpConfigSchema.parse({ tools: { preset: 'full' } });
  const handle = createServer(store, registry, config, process.cwd(), progress, {});

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tra-962-probe', version: '1.0.0' });
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async dispose() {
      await client.close().catch(() => {});
      handle.dispose();
      db.close();
    },
  };
}

describe('TRA-962: published inputSchema.required matches real optionality', () => {
  it('get_change_impact does not list file_path/symbol_id as required', async () => {
    const { client, dispose } = await bootServer();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'get_change_impact');
      expect(tool).toBeDefined();
      const required = (tool?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
      expect(required).not.toContain('file_path');
      expect(required).not.toContain('symbol_id');
      expect(required).not.toContain('fqn');
      expect(required).not.toContain('symbol_ids');
    } finally {
      await dispose();
    }
  });

  it('calling with only file_path over the real transport succeeds (no NOT_FOUND on an empty id)', async () => {
    const { client, dispose } = await bootServer();
    try {
      const result = await client.callTool({
        name: 'get_change_impact',
        arguments: { file_path: 'src/target.ts' },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      expect(text).not.toMatch(/'' is not in the index/);
      const parsed = JSON.parse(text);
      expect(parsed.target?.path).toBe('src/target.ts');
    } finally {
      await dispose();
    }
  });

  // Confirms the fix lives in the shared helper, not a get_change_impact-only
  // patch: get_symbol takes the same optional symbol_id/fqn pair and had the
  // identical drift before the fix (both fields are optional — either one
  // alone is a valid, complete call).
  it('get_symbol also does not list symbol_id/fqn as required', async () => {
    const { client, dispose } = await bootServer();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'get_symbol');
      expect(tool).toBeDefined();
      const required = (tool?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
      expect(required).not.toContain('symbol_id');
      expect(required).not.toContain('fqn');
    } finally {
      await dispose();
    }
  });
});
