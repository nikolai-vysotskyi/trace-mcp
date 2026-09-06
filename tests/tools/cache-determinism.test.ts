/**
 * TRA-858 — same repo state, same bytes.
 *
 * What this is NOT guarding. TRA-858 was filed on the theory that a
 * wall-clock field inside a tool result invalidates the Anthropic prompt
 * cache "for all subsequent turns in the session". That mechanism does not
 * hold: the cache matches a *prefix*, and a tool result is appended after
 * everything already cached. Two identical calls that answer with different
 * bytes produce two separate messages; neither rewrites the other, and the
 * prefix in front of both is untouched. Nothing is re-written, so nothing is
 * re-paid. The surfaces where a moving byte really does force a cache write
 * are the ones that sit *in* the prefix and get re-sent — the server
 * `instructions` string, and the tool list (which `load_tools` mutates
 * mid-session by design). Those are a separate, measurable question; this
 * file does not answer it.
 *
 * What this IS guarding. A read-only tool that answers the same question
 * with different bytes makes every consumer that diffs or replays its output
 * unreadable: the replay-eval baselines (scripts/replay-eval.ts), the
 * state-trace harness, and a human comparing two runs to see what the index
 * actually changed. That is reason enough to hold the line, and it is the
 * reason stated here so a later run does not re-derive the cache claim from
 * a test name.
 *
 * Method: drives a real MCP `Client` over an in-memory transport (same
 * pattern as tests/server/optional-params-schema-required.test.ts) and calls
 * each tool once against two independent, freshly-booted server instances
 * seeded with identical store state, asserting the serialized text is
 * byte-for-byte identical. Two sessions rather than two calls on one client,
 * because `SessionJournal`'s dedup wrapper (src/server/tool-gate-helpers.ts
 * `handleDuplicate`) deliberately answers a repeat call with a compact stub
 * or an appended `_duplicate_warning` — a token saving that costs nothing in
 * cache terms, for the reason above, and is not what this suite measures.
 *
 * Out of scope, deliberately: tools whose timestamp is the artifact's
 * identity rather than decoration — `generate_insights_report` and
 * `get_suggested_questions` (`generated_at`), `graph_snapshot`
 * (`captured_at`), `embed_repo` (`duration_ms`), and the trend tools whose
 * `date` is the data point. Stripping those would delete information a
 * reader wants and buy nothing.
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
