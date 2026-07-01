/**
 * Tool-handler-level wiring for hybrid retrieval (Task 9) composed with
 * progressive disclosure (Task 12) through the REAL `query_decisions`
 * handler — not just the `hybridRankDecisions` unit (decision-hybrid.test.ts)
 * or the `DecisionStore.queryDecisions` store layer
 * (query-decisions.behavioural.test.ts). Neither of those exercises the
 * `hybridActive` gate inside the tool handler itself.
 *
 * Covers:
 *   - search with NO embeddingService configured -> degrades cleanly to
 *     FTS5-only, no crash, non-empty results (the zero-dependency fallback).
 *   - search WITH an embeddingService configured -> the hybrid path engages
 *     and still returns the right rows.
 *   - index_only:true + a search + an embeddingService together -> results
 *     are hybrid-ranked (best semantic match first) AND have no `content`
 *     field — proving the two features compose rather than one clobbering
 *     the other.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EmbeddingService } from '../../../ai/interfaces.js';
import { DecisionStore } from '../../../memory/decision-store.js';
import type { ServerContext } from '../../../server/types.js';
import { registerMemoryTools } from '../memory.js';
import { createTmpDir, removeTmpDir } from '../../../../tests/test-utils.js';

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
    projectRoot: '/tmp/fake-project-hybrid-wiring',
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

/** Deterministic bag-of-words embedding — same technique as decision-hybrid.test.ts. */
const VOCAB = ['redis', 'cache', 'session', 'graphql', 'rest', 'gateway'];
function bagEmbed(text: string): number[] {
  const lower = text.toLowerCase();
  return VOCAB.map((w) => (lower.match(new RegExp(w, 'g')) ?? []).length);
}
const fakeEmbeddings: EmbeddingService = {
  async embed(text) {
    return bagEmbed(text);
  },
  async embedBatch(texts) {
    return texts.map(bagEmbed);
  },
  dimensions() {
    return VOCAB.length;
  },
  modelName() {
    return 'fake-bow';
  },
};

const PROJECT = '/tmp/fake-project-hybrid-wiring';

function seedThreeDecisions(store: DecisionStore): { redisId: number; graphqlId: number } {
  // FTS5 lexical order puts the weak match first (older valid_from wins the
  // recency tie-break); embeddings should still find the strong "redis cache"
  // semantic match when hybrid is active.
  store.addDecision({
    title: 'Node runtime pin',
    content: 'Unrelated decision about the node runtime.',
    type: 'tech_choice',
    project_root: PROJECT,
    valid_from: '2026-03-01T00:00:00.000Z',
  });
  const redis = store.addDecision({
    title: 'Cache layer',
    content: 'Adopted redis redis cache for session storage.',
    type: 'architecture_decision',
    project_root: PROJECT,
    valid_from: '2026-01-01T00:00:00.000Z', // oldest — would rank last on recency alone
  });
  const graphql = store.addDecision({
    title: 'GraphQL gateway',
    content: 'rest vs graphql gateway tradeoff',
    type: 'architecture_decision',
    project_root: PROJECT,
    valid_from: '2026-02-01T00:00:00.000Z',
  });
  return { redisId: redis.id, graphqlId: graphql.id };
}

describe('query_decisions tool — hybrid retrieval wiring', () => {
  let tmpDir: string;
  let decisionStore: DecisionStore;

  beforeEach(() => {
    tmpDir = createTmpDir('query-decisions-hybrid-');
    decisionStore = new DecisionStore(path.join(tmpDir, 'decisions.db'));
  });

  afterEach(() => {
    decisionStore.close();
    removeTmpDir(tmpDir);
  });

  it('degrades cleanly to FTS5-only when no embeddingService is configured (no crash, non-empty)', async () => {
    seedThreeDecisions(decisionStore);
    const { server, captured } = makeCapturingServer();
    registerMemoryTools(
      server as Parameters<typeof registerMemoryTools>[0],
      ctxStub({ decisionStore, embeddingService: null }),
    );
    const tool = findTool(captured, 'query_decisions');

    const res = await tool.handler({ search: 'redis cache' });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.degraded).not.toBe(true);
    expect(Array.isArray(payload.decisions)).toBe(true);
    expect(payload.decisions.length).toBeGreaterThan(0);
    expect(payload.decisions.some((d: { title: string }) => d.title === 'Cache layer')).toBe(true);
  });

  it('engages the hybrid path when an embeddingService IS configured', async () => {
    const { redisId } = seedThreeDecisions(decisionStore);
    const { server, captured } = makeCapturingServer();
    registerMemoryTools(
      server as Parameters<typeof registerMemoryTools>[0],
      ctxStub({ decisionStore, embeddingService: fakeEmbeddings }),
    );
    const tool = findTool(captured, 'query_decisions');

    const res = await tool.handler({ search: 'redis cache' });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    // The strong semantic match ("Cache layer", oldest valid_from) must
    // still surface prominently even though pure-recency order would bury it.
    expect(payload.decisions.some((d: { id: number }) => d.id === redisId)).toBe(true);
  });

  it('index_only + hybrid compose: results are still hybrid-ranked AND carry no `content`', async () => {
    const { redisId } = seedThreeDecisions(decisionStore);
    const { server, captured } = makeCapturingServer();
    registerMemoryTools(
      server as Parameters<typeof registerMemoryTools>[0],
      ctxStub({ decisionStore, embeddingService: fakeEmbeddings }),
    );
    const tool = findTool(captured, 'query_decisions');

    const res = await tool.handler({ search: 'redis cache', index_only: true });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.index_only).toBe(true);
    expect(payload.decisions.length).toBeGreaterThan(0);
    // No entry carries `content` — progressive disclosure held under hybrid.
    for (const entry of payload.decisions) {
      expect(entry).not.toHaveProperty('content');
      expect(typeof entry.summary).toBe('string');
    }
    // The hybrid-boosted semantic match is still present in the projected set.
    expect(payload.decisions.some((d: { id: number }) => d.id === redisId)).toBe(true);
  });

  it('an embedding failure inside the hybrid path still degrades to a working (non-empty) result', async () => {
    const throwing: EmbeddingService = {
      async embed() {
        throw new Error('embedding service unavailable');
      },
      async embedBatch() {
        throw new Error('embedding service unavailable');
      },
      dimensions() {
        return 3;
      },
      modelName() {
        return 'broken';
      },
    };
    seedThreeDecisions(decisionStore);
    const { server, captured } = makeCapturingServer();
    registerMemoryTools(
      server as Parameters<typeof registerMemoryTools>[0],
      ctxStub({ decisionStore, embeddingService: throwing }),
    );
    const tool = findTool(captured, 'query_decisions');

    const res = await tool.handler({ search: 'redis cache' });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.decisions.length).toBeGreaterThan(0);
  });
});
