/**
 * E2E reproduction and rate check on an anonymized /tmp fixture (TRA-2981).
 *
 * Verifies that:
 * 1. Fast errors in get_symbol, get_outline, find_usages are expected NOT_FOUND / ambiguous misses (100%),
 *    not resolution crashes (0%).
 * 2. Emitted journal entries have diagnostic classification attached to params_summary without sensitive leaks.
 * 3. The fixture root in /tmp is cleaned up cleanly.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from '../server.js';
import { Store } from '../../db/store.js';
import { initializeDatabase } from '../../db/schema.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import type { TraceMcpConfig } from '../../config.js';
import type { JournalEntryCallbackData } from '../journal-broadcast.js';

describe('TRA-2981 E2E fast error classes on /tmp fixture', () => {
  let tmpDir: string;
  let dbPath: string;
  let rawDb: ReturnType<typeof initializeDatabase>;
  let store: Store;
  let registry: PluginRegistry;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let client: Client;
  let emittedJournal: JournalEntryCallbackData[] = [];
  let serverHandle: ReturnType<typeof createServer>;

  beforeEach(async () => {
    emittedJournal = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tra-2981-fixture-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

    // File 1: src/alpha.ts with function alpha() and function sharedName()
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'alpha.ts'),
      'export function alpha(): string { return "alpha"; }\nexport function sharedName(): number { return 1; }\n',
    );
    // File 2: src/beta.ts with function beta() and function sharedName()
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'beta.ts'),
      'export function beta(): string { return "beta"; }\nexport function sharedName(): number { return 2; }\n',
    );

    dbPath = path.join(tmpDir, 'index.db');
    rawDb = initializeDatabase(dbPath);
    store = new Store(rawDb);

    // Populate index with the files and symbols
    const f1 = store.insertFile('src/alpha.ts', 'typescript', 'h1', 100);
    store.insertSymbols(f1, [
      {
        name: 'alpha',
        kind: 'function',
        byteStart: 0,
        byteEnd: 51,
        lineStart: 1,
        lineEnd: 1,
        symbolId: 'src/alpha.ts::alpha#function',
        signature: 'export function alpha(): string',
      },
      {
        name: 'sharedName',
        kind: 'function',
        byteStart: 52,
        byteEnd: 110,
        lineStart: 2,
        lineEnd: 2,
        symbolId: 'src/alpha.ts::sharedName#function',
        signature: 'export function sharedName(): number',
      },
    ]);

    const f2 = store.insertFile('src/beta.ts', 'typescript', 'h2', 100);
    store.insertSymbols(f2, [
      {
        name: 'beta',
        kind: 'function',
        byteStart: 0,
        byteEnd: 49,
        lineStart: 1,
        lineEnd: 1,
        symbolId: 'src/beta.ts::beta#function',
        signature: 'export function beta(): string',
      },
      {
        name: 'sharedName',
        kind: 'function',
        byteStart: 50,
        byteEnd: 108,
        lineStart: 2,
        lineEnd: 2,
        symbolId: 'src/beta.ts::sharedName#function',
        signature: 'export function sharedName(): number',
      },
    ]);

    registry = PluginRegistry.createWithDefaults();
    const config = { tools: { preset: 'full' } } as TraceMcpConfig;

    serverHandle = createServer(store, registry, config, tmpDir, undefined, {
      sessionId: 'sess-tra-2981',
      onJournalEntry: (entry) => {
        emittedJournal.push(entry);
      },
    });

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await serverHandle.server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    try {
      await client?.close();
    } catch {}
    try {
      await serverHandle?.server?.close();
    } catch {}
    try {
      rawDb?.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('correctly classifies fast error classes and measures error rate', async () => {
    // 1. Missing symbol lookup -> fast NOT_FOUND:unknown_symbol
    const missingSymRes = (await client.callTool({
      name: 'get_symbol',
      arguments: { symbol_id: 'useRedirectCheckout' },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(missingSymRes.isError).toBe(true);
    const missingSymBody = JSON.parse(missingSymRes.content[0].text);
    expect(missingSymBody.error.code).toBe('NOT_FOUND');
    expect(missingSymBody.error.reason).toBe('unknown_symbol');

    // 2. Ambiguous symbol lookup -> fast NOT_FOUND:ambiguous
    const ambigRes = (await client.callTool({
      name: 'get_symbol',
      arguments: { symbol_id: 'sharedName' },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(ambigRes.isError).toBe(true);
    const ambigBody = JSON.parse(ambigRes.content[0].text);
    expect(ambigBody.error.code).toBe('NOT_FOUND');
    expect(ambigBody.error.suggestions).toBeDefined();

    // 3. Valid symbol lookup -> success (isError undefined/false)
    const validSymRes = await client.callTool({
      name: 'get_symbol',
      arguments: { symbol_id: 'src/alpha.ts::alpha#function' },
    });
    expect(validSymRes.isError).toBeFalsy();

    // 4. Missing outline path -> fast NOT_FOUND:not_found
    const missingOutlineRes = (await client.callTool({
      name: 'get_outline',
      arguments: { path: 'nonexistent/file.ts' },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(missingOutlineRes.isError).toBe(true);
    const missingOutlineBody = JSON.parse(missingOutlineRes.content[0].text);
    expect(missingOutlineBody.error.code).toBe('NOT_FOUND');
    expect(missingOutlineBody.error.reason).toBe('not_found');

    // 5. Valid outline path -> success
    const validOutlineRes = await client.callTool({
      name: 'get_outline',
      arguments: { path: 'src/alpha.ts' },
    });
    expect(validOutlineRes.isError).toBeFalsy();

    // 6. Missing usage symbol -> fast NOT_FOUND
    const missingUsageRes = await client.callTool({
      name: 'find_usages',
      arguments: { symbol_id: 'nonexistent_symbol' },
    });
    expect(missingUsageRes.isError).toBe(true);

    // 7. Valid usage lookup on existing symbol with 0 edges -> success with indexed_no_edges
    const validUsageRes = await client.callTool({
      name: 'find_usages',
      arguments: { symbol_id: 'src/alpha.ts::alpha#function' },
    });
    expect(validUsageRes.isError).toBeFalsy();

    // Check emitted journal entries
    expect(emittedJournal).toHaveLength(7);

    const errorEntries = emittedJournal.filter((e) => e.is_error);
    expect(errorEntries).toHaveLength(4);

    // Verify error classification in params_summary:
    const missingSymEntry = emittedJournal.find((e) =>
      e.params_summary.includes('useRedirectCheckout'),
    );
    expect(missingSymEntry?.params_summary).toBe(
      'get_symbol useRedirectCheckout [NOT_FOUND:unknown_symbol]',
    );

    const ambigEntry = emittedJournal.find((e) => e.params_summary.includes('sharedName'));
    expect(ambigEntry?.params_summary).toBe('get_symbol sharedName [NOT_FOUND:ambiguous]');

    const missingOutlineEntry = emittedJournal.find((e) =>
      e.params_summary.includes('nonexistent/file.ts'),
    );
    expect(missingOutlineEntry?.params_summary).toBe(
      'get_outline nonexistent/file.ts [NOT_FOUND:not_found]',
    );

    const missingUsageEntry = emittedJournal.find((e) =>
      e.params_summary.includes('nonexistent_symbol'),
    );
    expect(missingUsageEntry?.params_summary).toBe('find_usages nonexistent_symbol [NOT_FOUND]');

    // All errors had latency < 100ms (fast rejects)
    for (const e of errorEntries) {
      expect(e.latency_ms).toBeLessThan(100);
      expect(e.result_count).toBe(0);
    }

    // Verify that successful calls have no classification tag
    const successEntries = emittedJournal.filter((e) => !e.is_error);
    expect(successEntries).toHaveLength(3);
    for (const s of successEntries) {
      expect(s.params_summary).not.toContain('[');
    }
  });
});
