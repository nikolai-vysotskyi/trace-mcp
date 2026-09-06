/**
 * Contract test for the Notebook `get_symbol` cell's argument shaping
 * (TRA-1064): the cell's field key must match the argument name the daemon's
 * `get_symbol` tool actually reads (`symbol_id`), not `fqn` — nearly every
 * symbol's `fqn` column is NULL, so sending the id under the wrong key
 * produced NOT_FOUND on a perfectly valid id. This drives the real
 * request-building code in defaultNotebookClient (not a mock of it) through
 * a fake daemon that answers exactly like the real one recorded in
 * tests/fixtures/wire/*.json — success for `symbol_id`, NOT_FOUND for `fqn`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_BY_NAME, defaultNotebookClient } from '../notebook-runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wireDir = path.resolve(here, '../../../../../../tests/fixtures/wire');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(wireDir, name), 'utf-8'));
}

const root = '/some/project';
const SESSION_ID = 'test-session';

/** Fakes the initialize -> notifications/initialized -> tools/call dance,
 * routing the tools/call response by the arguments actually sent — same
 * branching the real daemon does based on which argument key it receives. */
function stubDaemon(respond: (args: Record<string, unknown>) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.method === 'initialize') {
        return {
          ok: true,
          headers: new Headers({ 'mcp-session-id': SESSION_ID }),
          text: async () => '',
        } as unknown as Response;
      }
      if (body.method === 'notifications/initialized') {
        return { ok: true, text: async () => '' } as unknown as Response;
      }
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      const result = respond(args);
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
        }),
      } as unknown as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Notebook get_symbol cell — argument key (TRA-1064)', () => {
  it('is defined to send `symbol_id`, not `fqn`', () => {
    expect(TOOL_BY_NAME.get_symbol.fields.map((f) => f.key)).toEqual(['symbol_id']);
  });

  it("resolves a real symbol_id against the daemon's actual get_symbol contract", async () => {
    const success = loadFixture('get_symbol.json');
    const notFound = loadFixture('get_symbol_wrong_arg_not_found.json');
    stubDaemon((args) => (args.symbol_id ? success : notFound));

    // Build args the way the UI does: one entry per field, keyed by field.key.
    const field = TOOL_BY_NAME.get_symbol.fields[0];
    const args = { [field.key]: 'src/daemon/project-manager.ts::ProjectManager#class' };

    const result = await defaultNotebookClient.callTool('get_symbol', args, root);
    expect(result).toEqual(success);
  });

  it('reproduces the recorded NOT_FOUND when the id is sent under `fqn` instead', async () => {
    const success = loadFixture('get_symbol.json');
    const notFound = loadFixture('get_symbol_wrong_arg_not_found.json');
    stubDaemon((args) => (args.symbol_id ? success : notFound));

    // The client doesn't unwrap MCP's `isError` into a thrown JS error (a
    // separate, pre-existing gap — Notebook.tsx renders whatever resolves),
    // so this resolves to the recorded NOT_FOUND payload rather than throwing.
    const result = await defaultNotebookClient.callTool(
      'get_symbol',
      { fqn: 'src/daemon/project-manager.ts::ProjectManager#class' },
      root,
    );
    expect(result).toEqual(notFound);
  });
});
