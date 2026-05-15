/**
 * Behavioural coverage for the `search_text` MCP tool registration in
 * `src/tools/register/advanced.ts`. Exercises the two `grouping` shapes
 * (flat | by_file) plus schema validation. The handler is captured via a
 * stub server so we drive the exact closure that ships in production
 * without paying the cost of a full MCP transport.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { initializeDatabase } from '../../../db/schema.js';
import { Store } from '../../../db/store.js';
import { registerAdvancedTools } from '../advanced.js';
import type { ServerContext } from '../../../server/types.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface CapturedTool {
  name: string;
  description: string;
  schemaShape: Record<string, z.ZodTypeAny>;
  handler: Handler;
}

interface Fixture {
  store: Store;
  projectRoot: string;
  tool: CapturedTool;
}

function seedFixture(): Fixture {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-search-text-grouping-'));
  const aPath = path.join(projectRoot, 'src/a.ts');
  const bPath = path.join(projectRoot, 'src/b.ts');
  fs.mkdirSync(path.dirname(aPath), { recursive: true });
  fs.writeFileSync(
    aPath,
    ['function findMe() {', '  // findMe hit 2', '  return findMe;', '}', 'const tail = 1;'].join(
      '\n',
    ),
  );
  fs.writeFileSync(
    bPath,
    ['function other() {', '  return 1;', '}', 'const findMe = 42;'].join('\n'),
  );

  const store = new Store(initializeDatabase(':memory:'));
  store.insertFile('src/a.ts', 'typescript', 'h1', fs.statSync(aPath).size);
  store.insertFile('src/b.ts', 'typescript', 'h2', fs.statSync(bPath).size);

  const captured: CapturedTool[] = [];
  const fakeServer = {
    tool: (
      name: string,
      description: string,
      schemaShape: Record<string, z.ZodTypeAny>,
      handler: Handler,
    ) => {
      captured.push({ name, description, schemaShape, handler });
    },
  } as unknown as Parameters<typeof registerAdvancedTools>[0];

  const ctx = {
    store,
    projectRoot,
    config: {},
    j: (v: unknown) => JSON.stringify(v),
    jh: (_tool: string, v: unknown) => JSON.stringify(v),
    guardPath: () => null,
    onPipelineEvent: () => {},
    markExplored: () => {},
  } as unknown as ServerContext;

  registerAdvancedTools(fakeServer, ctx);
  const tool = captured.find((t) => t.name === 'search_text');
  if (!tool) throw new Error('search_text tool was not registered');
  return { store, projectRoot, tool };
}

function cleanup(fixture: Fixture): void {
  fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
}

async function call(
  tool: CapturedTool,
  args: Record<string, unknown>,
): Promise<{ raw: string; parsed: unknown }> {
  const schema = z.object(tool.schemaShape);
  const validated = schema.parse(args) as Record<string, unknown>;
  const out = await tool.handler(validated);
  const raw = out.content[0].text;
  return { raw, parsed: JSON.parse(raw) };
}

describe('search_text — grouping', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = seedFixture();
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it('flat (default) returns matches[] array', async () => {
    const { parsed } = await call(fixture.tool, { query: 'findMe' });
    const payload = parsed as { matches: unknown[]; total_matches: number };
    expect(Array.isArray(payload.matches)).toBe(true);
    expect(payload.matches.length).toBeGreaterThan(0);
    expect(payload.total_matches).toBe(payload.matches.length);
    expect((payload as Record<string, unknown>).files).toBeUndefined();
  });

  it('by_file groups hits under files with line-ordered hits', async () => {
    const { parsed: flat } = await call(fixture.tool, { query: 'findMe' });
    const { parsed: grouped } = await call(fixture.tool, { query: 'findMe', grouping: 'by_file' });
    const flatPayload = flat as {
      matches: Array<{
        file: string;
        line: number;
        column: number;
        match: string;
        context: string[];
        language: string | null;
      }>;
      total_matches: number;
    };
    const groupedPayload = grouped as {
      files: Array<{
        file: string;
        language: string | null;
        hits: Array<{ line: number; column: number; match: string; context: string[] }>;
      }>;
      total_matches: number;
    };

    expect(Array.isArray(groupedPayload.files)).toBe(true);
    expect((groupedPayload as Record<string, unknown>).matches).toBeUndefined();
    expect(groupedPayload.total_matches).toBe(flatPayload.total_matches);

    for (const f of groupedPayload.files) {
      for (let i = 1; i < f.hits.length; i++) {
        const prev = f.hits[i - 1];
        const cur = f.hits[i];
        expect(prev.line < cur.line || (prev.line === cur.line && prev.column <= cur.column)).toBe(
          true,
        );
      }
    }

    const reconstructed = groupedPayload.files.flatMap((f) =>
      f.hits.map((h) => ({
        file: f.file,
        language: f.language,
        line: h.line,
        column: h.column,
        match: h.match,
        context: h.context,
      })),
    );
    const sortKey = (m: { file: string; line: number; column: number }) =>
      `${m.file}:${m.line}:${m.column}`;
    const sortedFlat = [...flatPayload.matches].sort((a, b) =>
      sortKey(a).localeCompare(sortKey(b)),
    );
    const sortedReconstructed = [...reconstructed].sort((a, b) =>
      sortKey(a).localeCompare(sortKey(b)),
    );
    expect(sortedReconstructed).toEqual(sortedFlat);
  });

  it('invalid grouping value is rejected by the schema', async () => {
    const schema = z.object(fixture.tool.schemaShape);
    expect(() => schema.parse({ query: 'x', grouping: 'invalid' })).toThrow();
  });
});
