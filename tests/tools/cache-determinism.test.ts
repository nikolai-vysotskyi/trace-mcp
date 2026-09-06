/**
 * TRA-858 — prompt-cache determinism.
 *
 * Anthropic prompt caching keys off byte-identical prefixes. A tool that
 * embeds wall-clock data (`generated_at`, `duration_ms`, request ids) in an
 * otherwise-static response busts the cache on every repeated call, even
 * when the underlying repo state hasn't changed — turning a cheap cache
 * read into a full-price cache write for that block and everything after
 * it in the conversation.
 *
 * This drives a real MCP `Client` over an in-memory transport (same
 * pattern as tests/server/optional-params-schema-required.test.ts) and
 * calls each tool once against two independent, freshly-booted server
 * instances seeded with identical store state, asserting the serialized
 * text is byte-for-byte identical.
 *
 * Deliberately two independent sessions rather than two calls on one
 * client: `SessionJournal`'s dedup/duplicate-warning wrapper (see
 * src/server/tool-gate-helpers.ts `handleDuplicate`) intentionally rewrites
 * a *second* call to the same tool+args within one session into either a
 * compact stub or a response with `_duplicate_warning` appended — a
 * separate, deliberate token-savings mechanism, not the bug this suite
 * targets. That mechanism itself is a real cache-busting source (a repeat
 * call is defined to return different bytes) — see the TRA-858 closing
 * comment for why it's flagged for Lead Engineer rather than changed here.
 *
 * Scope: a representative sample of read-only, repeatedly-called tools
 * (search/navigation/health-report surface), not every advertised tool.
 * Tools that are inherently one-shot/mutating by design (`embed_repo`,
 * `graph_snapshot`) legitimately return real timing/point-in-time data and
 * are out of scope — see the TRA-858 closing comment for why.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { enableFts5Triggers } from '../../src/db/schema.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { ProgressState } from '../../src/progress.js';
import { createServer } from '../../src/server/server.js';

async function bootServer() {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  enableFts5Triggers(db);

  const fileA = store.insertFile('src/a.ts', 'typescript', 'h-a', 400);
  store.insertSymbol(fileA, {
    symbolId: 'src/a.ts::doA#function',
    name: 'doA',
    kind: 'function',
    fqn: 'doA',
    byteStart: 0,
    byteEnd: 40,
    lineStart: 1,
    lineEnd: 5,
    signature: 'function doA()',
    metadata: { exported: 1 },
  });
  const fileB = store.insertFile('src/b.ts', 'typescript', 'h-b', 300);
  store.insertSymbol(fileB, {
    symbolId: 'src/b.ts::doB#function',
    name: 'doB',
    kind: 'function',
    fqn: 'doB',
    byteStart: 0,
    byteEnd: 40,
    lineStart: 1,
    lineEnd: 5,
    signature: 'function doB()',
    metadata: { exported: 1 },
  });

  const registry = PluginRegistry.createWithDefaults();
  const progress = new ProgressState(db);
  const config = TraceMcpConfigSchema.parse({ tools: { preset: 'full' } });
  const handle = createServer(store, registry, config, process.cwd(), progress, {});

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tra-858-determinism-probe', version: '1.0.0' });
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    symbolId: 'src/a.ts::doA#function',
    async dispose() {
      await client.close().catch(() => {});
      handle.dispose();
      db.close();
    },
  };
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const block = content.find((c) => c.type === 'text');
  if (!block?.text) throw new Error('tool call returned no text content');
  return block.text;
}

describe('TRA-858: identical repo state produces byte-identical tool output', () => {
  const cases: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'self_audit', args: {} },
    { name: 'get_project_map', args: { summary_only: true } },
    { name: 'get_suggested_questions', args: {} },
    { name: 'generate_insights_report', args: {} },
    { name: 'search', args: { query: 'doA' } },
    { name: 'get_outline', args: { path: 'src/a.ts' } },
    { name: 'get_symbol', args: { symbol_id: 'src/a.ts::doA#function' } },
  ];

  for (const { name, args } of cases) {
    it(`${name} is byte-identical across two independent sessions`, async () => {
      const a = await bootServer();
      const b = await bootServer();
      try {
        const first = await a.client.callTool({ name, arguments: args });
        const second = await b.client.callTool({ name, arguments: args });
        expect(text(second)).toBe(text(first));
      } finally {
        await a.dispose();
        await b.dispose();
      }
    });
  }
});
