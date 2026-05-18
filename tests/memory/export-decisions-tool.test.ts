/**
 * End-to-end tests for the `export_decisions` MCP tool. Uses a capturing
 * server stub (mirrors registry-toon.test.ts) to invoke the handler
 * without spinning up the full MCP runtime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DecisionStore } from '../../src/memory/decision-store.js';
import type { ServerContext } from '../../src/server/types.js';
import { registerMemoryTools } from '../../src/tools/register/memory.js';

type Handler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface CapturedTool {
  name: string;
  description: string;
  schemaShape: Record<string, z.ZodTypeAny>;
  handler: Handler;
}

function makeCapturingServer(): { server: unknown; captured: CapturedTool[] } {
  const captured: CapturedTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schemaShape: Record<string, z.ZodTypeAny>,
      handler: Handler,
    ) => {
      captured.push({ name, description, schemaShape, handler });
    },
  };
  return { server, captured };
}

function baseCtxStub(overrides: Record<string, unknown>): ServerContext {
  const stub = {
    projectRoot: '/proj',
    config: {},
    registry: { getAllFrameworkPlugins: () => [] },
    embeddingService: null,
    vectorStore: null,
    reranker: null,
    rankingLedger: null,
    decisionStore: null,
    telemetrySink: null,
    topoStore: null,
    progress: null,
    aiProvider: null,
    journal: null,
    savings: { getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }) },
    has: () => false,
    guardPath: () => null,
    j: (v: unknown) => JSON.stringify(v),
    jh: (_tool: string, v: unknown) => JSON.stringify(v),
    markExplored: () => undefined,
    onPipelineEvent: () => undefined,
    ...overrides,
  };
  return stub as unknown as ServerContext;
}

describe('export_decisions MCP tool', () => {
  let tmpDir: string;
  let store: DecisionStore;
  let tool: CapturedTool;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-tool-'));
    store = new DecisionStore(path.join(tmpDir, 'decisions.db'));
    store.addDecision({
      title: 'Adopt CQRS for orders',
      content: 'Separate read/write paths so reporting does not block checkout.',
      type: 'architecture_decision',
      project_root: '/proj',
      tags: ['cqrs', 'orders'],
    });
    store.addDecision({
      title: 'Use ULID for IDs',
      content: 'Sortable, URL-safe, no central coordinator.',
      type: 'tech_choice',
      project_root: '/proj',
      tags: ['ids'],
    });

    const { server, captured } = makeCapturingServer();
    registerMemoryTools(
      server as Parameters<typeof registerMemoryTools>[0],
      baseCtxStub({ decisionStore: store, config: { memory: { heat: { enabled: false } } } }),
    );
    const found = captured.find((t) => t.name === 'export_decisions');
    if (!found) throw new Error('export_decisions tool was not registered');
    tool = found;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns JSONL by default with parsed scope metadata', async () => {
    const res = await tool.handler({}, {});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.format).toBe('jsonl');
    expect(payload.count).toBe(2);
    expect(payload.scope.project_root).toBe('/proj');
    expect(payload.scope.include_invalidated).toBe(false);
    const lines = payload.content.split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(typeof parsed.title).toBe('string');
      expect(Array.isArray(parsed.tags)).toBe(true);
    }
  });

  it('renders markdown when requested', async () => {
    const res = await tool.handler({ format: 'markdown' }, {});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.format).toBe('markdown');
    expect(payload.count).toBe(2);
    expect(payload.content).toContain('## Adopt CQRS for orders');
    expect(payload.content).toContain('# tech_choice');
  });

  it('honours the type filter', async () => {
    const res = await tool.handler({ type: 'tech_choice' }, {});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.scope.type).toBe('tech_choice');
  });

  it('rejects limit values above EXPORT_LIMIT_MAX at the schema layer', () => {
    const schema = z.object(tool.schemaShape);
    const tooLarge = schema.safeParse({ limit: 999_999 });
    expect(tooLarge.success).toBe(false);
    const inRange = schema.safeParse({ limit: 100 });
    expect(inRange.success).toBe(true);
  });

  it('reports an empty content string when nothing matches', async () => {
    const res = await tool.handler({ service_name: 'no-such-service' }, {});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.count).toBe(0);
    expect(payload.content).toBe('');
  });
});
