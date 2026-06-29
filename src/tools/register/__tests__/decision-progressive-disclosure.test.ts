/**
 * Wiring tests for progressive disclosure (Task 12):
 *   - query_decisions { index_only: true } omits `content`, keeps a `summary`.
 *   - get_decision { id } returns the full row including `content`.
 *
 * Handlers are captured via a fake `server.tool(...)` the same way
 * registry-toon.test.ts does.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DecisionStore } from '../../../memory/decision-store.js';
import type { ServerContext } from '../../../server/types.js';
import { registerMemoryTools } from '../memory.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../../../../tests/test-utils.js';

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
    tool: (name: string, _d: string, _s: Record<string, z.ZodTypeAny>, handler: Handler) => {
      captured.push({ name, handler });
    },
  };
  return { server, captured };
}

function findTool(captured: CapturedTool[], name: string): CapturedTool {
  const tool = captured.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} was not registered`);
  return tool;
}

function ctxStub(overrides: Record<string, unknown>): ServerContext {
  return {
    projectRoot: '/tmp/fake-project',
    config: { memory: { heat: { enabled: false } } },
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
    jh: (_t: string, v: unknown) => JSON.stringify(v),
    markExplored: () => undefined,
    onPipelineEvent: () => undefined,
    ...overrides,
  } as unknown as ServerContext;
}

describe('progressive disclosure wiring', () => {
  let tmpDir: string;
  let decisionStore: DecisionStore;
  let captured: CapturedTool[];
  let createdId: number;

  beforeEach(() => {
    tmpDir = createTmpDir('progressive-disclosure-');
    decisionStore = new DecisionStore(path.join(tmpDir, 'decisions.db'));
    const row = decisionStore.addDecision({
      title: 'Adopt argon2id',
      content:
        'Switched from bcrypt to argon2id. This second sentence is the bulky body ' +
        'that progressive disclosure should keep out of the index payload.',
      type: 'tech_choice',
      project_root: '/tmp/fake-project',
      tags: ['auth'],
      valid_from: '2024-01-01T00:00:00.000Z',
    });
    createdId = row.id;

    const store = createTestStore();
    const { server, captured: cap } = makeCapturingServer();
    registerMemoryTools(
      server as Parameters<typeof registerMemoryTools>[0],
      ctxStub({ store, decisionStore }),
    );
    captured = cap;
  });

  afterEach(() => {
    decisionStore.close();
    removeTmpDir(tmpDir);
  });

  it('query_decisions index_only omits content and includes a summary', async () => {
    const tool = findTool(captured, 'query_decisions');
    const res = await tool.handler({ index_only: true });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.index_only).toBe(true);
    expect(payload.decisions).toHaveLength(1);
    const entry = payload.decisions[0];
    expect(entry).not.toHaveProperty('content');
    expect(entry.id).toBe(createdId);
    expect(entry.title).toBe('Adopt argon2id');
    expect(typeof entry.summary).toBe('string');
    expect(entry.summary).not.toContain('bulky body');
  });

  it('query_decisions default (no index_only) still includes content', async () => {
    const tool = findTool(captured, 'query_decisions');
    const res = await tool.handler({});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.decisions[0]).toHaveProperty('content');
    expect(payload).not.toHaveProperty('index_only');
  });

  it('get_decision returns the full row including content', async () => {
    const tool = findTool(captured, 'get_decision');
    const res = await tool.handler({ id: createdId });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.decision.id).toBe(createdId);
    expect(payload.decision.content).toContain('argon2id');
  });

  it('get_decision returns an error for an unknown id', async () => {
    const tool = findTool(captured, 'get_decision');
    const res = await tool.handler({ id: 999999 });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toContain('999999');
  });
});
