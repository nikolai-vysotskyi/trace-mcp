/**
 * TRA-4: get_outline used to return a bare NOT_FOUND for a file that exists
 * on disk but hasn't been indexed yet (new/renamed file, cold start) — the
 * documented driver of a 46% full-Read fallback rate. It should instead
 * parse the file on demand (same single-file path `register_edit` uses) and
 * return the real outline, and it should only fall back to a structured
 * `reason` + `hint` error for a path that genuinely doesn't exist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TypeScriptLanguagePlugin } from '../../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import type { ServerContext } from '../../../src/server/types.js';
import { registerLookupTools } from '../../../src/tools/register/navigation/lookup-tools.js';
import { createTestStore } from '../../test-utils.js';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

interface CapturedTool {
  name: string;
  handler: Handler;
}

function makeCapturingServer(): { server: unknown; captured: CapturedTool[] } {
  const captured: CapturedTool[] = [];
  const server = {
    tool: (
      name: string,
      _description: string,
      _shape: Record<string, z.ZodTypeAny>,
      handler: Handler,
    ) => {
      captured.push({ name, handler });
    },
  };
  return { server, captured };
}

describe('get_outline — auto-index on NOT_FOUND (TRA-4)', () => {
  let tmpDir: string;
  let outline: Handler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-outline-'));
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'fresh.ts'),
      'export function freshlyWritten(): number {\n  return 1;\n}\n',
    );

    const store = createTestStore();
    // Non-empty index so get_outline exercises the real NOT_FOUND path
    // instead of the separate "index is totally empty" regex fallback.
    store.insertFile('src/other.ts', 'typescript', 'seed-hash', 10);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

    const ctx = {
      store,
      registry,
      config: {
        root: tmpDir,
        include: ['src/**/*.ts'],
        exclude: [],
        db: { path: ':memory:' },
        plugins: [],
      },
      projectRoot: tmpDir,
      guardPath: () => null,
      j: (v: unknown) => JSON.stringify(v),
      jh: (_tool: string, v: unknown) => JSON.stringify(v),
      markExplored: () => undefined,
      decisionStore: null,
      rankingLedger: null,
    } as unknown as ServerContext;

    const { server, captured } = makeCapturingServer();
    registerLookupTools(server as never, ctx);
    outline = captured.find((t) => t.name === 'get_outline')!.handler;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses an unindexed but existing file on demand instead of returning NOT_FOUND', async () => {
    const res = await outline({ path: 'src/fresh.ts' });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.error).toBeUndefined();
    expect(body._auto_indexed).toBe(true);
    expect(body.symbols.some((s: { name: string }) => s.name === 'freshlyWritten')).toBe(true);
  });

  it('returns a structured reason + hint (not bare NOT_FOUND) for a genuinely absent path', async () => {
    const res = await outline({ path: 'src/does-not-exist.ts' });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.reason).toBe('not_found');
    expect(typeof body.error.help).toBe('string');
    expect(body.error.help.length).toBeGreaterThan(0);
  });
});
