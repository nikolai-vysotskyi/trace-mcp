/**
 * TRA-373 — `tools.description_verbosity` / `tools.instructions_verbosity`
 * must shrink the *wire payload*, not just parse.
 *
 * Two guards, mirroring the split used by tests/daemon/sse-pipeline-events.ts:
 *
 *  1. Behavioural: drive a real MCP client over an in-memory transport
 *     through `initialize` + `tools/list` and assert the serialized payload
 *     actually shrinks. A refactor that keeps the config field but stops
 *     applying it to descriptions/instructions fails here.
 *
 *  2. Source guardrail: the daemon builds each session's server inside a
 *     Commander closure in src/cli.ts, which cannot be imported. The bug this
 *     issue reports was that closure passing `managed.config` — loaded once
 *     when the daemon first added the project and never refreshed — so every
 *     session got a tool surface built from a stale config. Parse cli.ts and
 *     fail if the session server is built from anything but a freshly loaded
 *     config.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { TraceMcpConfigSchema, type TraceMcpConfig } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { ProgressState } from '../../src/progress.js';
import { createServer } from '../../src/server/server.js';

type Verbosity = 'full' | 'minimal' | 'none';

interface Measurement {
  toolCount: number;
  wireBytes: number;
  descriptionBytes: number;
  instructionBytes: number;
}

function configFor(verbosity: Verbosity): TraceMcpConfig {
  return TraceMcpConfigSchema.parse({
    tools: {
      preset: 'standard',
      description_verbosity: verbosity,
      instructions_verbosity: verbosity,
    },
  });
}

/** Boot a server at `verbosity` and measure what an MCP client actually receives. */
async function measure(verbosity: Verbosity): Promise<Measurement> {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  const registry = PluginRegistry.createWithDefaults();
  const progress = new ProgressState(db);
  const handle = createServer(store, registry, configFor(verbosity), process.cwd(), progress, {});

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tra-373-probe', version: '1.0.0' });
  try {
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    return {
      toolCount: tools.length,
      wireBytes: JSON.stringify(tools).length,
      descriptionBytes: tools.reduce((sum, t) => sum + (t.description?.length ?? 0), 0),
      instructionBytes: (client.getInstructions() ?? '').length,
    };
  } finally {
    await client.close().catch(() => {});
    handle.dispose();
    db.close();
  }
}

describe('TRA-373: verbosity settings shrink the tools/list wire payload', () => {
  it('full > minimal > none, on descriptions, instructions and total bytes', async () => {
    const full = await measure('full');
    const minimal = await measure('minimal');
    const none = await measure('none');

    // Same surface — verbosity trims content, it must not drop tools.
    expect(full.toolCount).toBeGreaterThan(0);
    expect(minimal.toolCount).toBe(full.toolCount);
    expect(none.toolCount).toBe(full.toolCount);

    // Descriptions are ~57% of the default wire; `none` must strip them.
    expect(none.descriptionBytes).toBeLessThan(full.descriptionBytes * 0.3);
    expect(minimal.descriptionBytes).toBeLessThan(full.descriptionBytes * 0.75);

    // Server instructions (the tool-routing block).
    expect(full.instructionBytes).toBeGreaterThan(1000);
    expect(none.instructionBytes).toBe(0);
    expect(minimal.instructionBytes).toBeLessThan(full.instructionBytes * 0.5);

    // The point of the setting: a materially cheaper session.
    expect(none.wireBytes).toBeLessThan(full.wireBytes * 0.6);
  }, 120_000);
});

describe('TRA-373: the daemon builds each session from a freshly loaded config', () => {
  const cliSource = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts'),
    'utf-8',
  );

  /** Body of `async function createSessionTransport(...)`, up to `await handle.server.connect`. */
  function sessionTransportBody(): string {
    const start = cliSource.indexOf('async function createSessionTransport(');
    expect(start).toBeGreaterThan(-1);
    const end = cliSource.indexOf('await handle.server.connect(transport)', start);
    expect(end).toBeGreaterThan(start);
    return cliSource.slice(start, end);
  }

  it('re-reads the config per session instead of reusing the cached ProjectManager copy', () => {
    const body = sessionTransportBody();
    expect(body).toMatch(/await loadConfig\(projectRoot\)/);
    // The regression: passing the daemon-lifetime cached config to createServer.
    expect(body).not.toMatch(/createServer\(\s*[\s\S]*?managed\.config,[\s\S]*?managed\.progress/);
  });
});
