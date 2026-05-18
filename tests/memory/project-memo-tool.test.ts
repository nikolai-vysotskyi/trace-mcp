/**
 * Integration test for the regenerate_project_memo / get_project_memo MCP
 * tools. Captures the registered handlers from a fake McpServer and exercises
 * them directly with a stubbed aiProvider.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceService } from '../../src/ai/interfaces.js';
import { DecisionStore } from '../../src/memory/decision-store.js';
import type { ServerContext } from '../../src/server/types.js';
import { registerMemoryTools } from '../../src/tools/register/memory.js';

interface CapturedTool {
  description: string;
  handler: (params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function buildFakeServer(): {
  server: unknown;
  tools: Map<string, CapturedTool>;
} {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (name: string, description: string, _schema: unknown, handler: unknown) => {
      tools.set(name, { description, handler: handler as CapturedTool['handler'] });
    },
  };
  return { server, tools };
}

function makeInference(responseText: string): InferenceService {
  return { generate: vi.fn(async () => responseText) };
}

function buildCtx(
  store: DecisionStore,
  projectRoot: string,
  inference: InferenceService | null,
  memoRegenEveryN = 50,
): ServerContext {
  const aiProvider = inference
    ? {
        isAvailable: vi.fn(async () => true),
        inference: () => inference,
      }
    : null;
  return {
    projectRoot,
    decisionStore: store,
    topoStore: null,
    config: {
      memory: {
        recall: { timeoutMs: 5000 },
        memo: { enabled: true, regenerateEveryN: memoRegenEveryN, targetTokens: 350 },
      },
      ai: { provider: 'mock', inference_model: 'mock-model' },
    } as unknown as ServerContext['config'],
    aiProvider: aiProvider as unknown as ServerContext['aiProvider'],
    j: (v: unknown) => JSON.stringify(v),
    store: {} as ServerContext['store'],
    registry: {} as ServerContext['registry'],
    savings: {} as ServerContext['savings'],
    journal: {} as ServerContext['journal'],
    vectorStore: null,
    embeddingService: null,
    reranker: null,
    has: () => false,
    guardPath: () => null,
    jh: (_t: string, v: unknown) => JSON.stringify(v),
    markExplored: () => {},
    progress: null,
    telemetrySink: null,
    rankingLedger: null,
    onPipelineEvent: () => {},
  } as ServerContext;
}

function parseToolJson(res: {
  content: Array<{ type: string; text: string }>;
}): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

const SAMPLE_MEMO = `## Architecture

We layer JWT auth on top of Redis sessions. Migration runs through versioned database scripts.

## Tech stack

PostgreSQL with JSONB. Redis for hot session state.

## Conventions

Tests on every PR.

## In progress

Refresh-token rollout.`;

describe('regenerate_project_memo / get_project_memo', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/memo-tool-test';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-tool-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
    // Seed decisions so the boilerplate guard has anchor tokens.
    store.addDecision({
      title: 'Use JWT auth',
      content: 'short-lived JWTs with refresh tokens.',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    store.addDecision({
      title: 'Redis sessions',
      content: 'Store user sessions in Redis with TTL.',
      type: 'architecture_decision',
      project_root: projectRoot,
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  describe('regenerate_project_memo', () => {
    it('without aiProvider returns a structured error, not a throw', async () => {
      const { server, tools } = buildFakeServer();
      const ctx = buildCtx(store, projectRoot, null, 1);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('regenerate_project_memo')!;
      expect(tool).toBeDefined();
      const res = await tool.handler({ force: true });
      expect(res.isError).toBe(true);
      const body = parseToolJson(res);
      expect(body.error).toBe('no_ai_provider');
      expect(body.regenerated).toBe(false);
      expect(store.getLatestProjectMemo({ project_root: projectRoot })).toBeUndefined();
    });

    it('threshold gates regeneration when force=false and no prior memo exists', async () => {
      const { server, tools } = buildFakeServer();
      // 2 seeded decisions, threshold 50 → under threshold.
      const ctx = buildCtx(store, projectRoot, makeInference(SAMPLE_MEMO), 50);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('regenerate_project_memo')!;
      const res = await tool.handler({});
      const body = parseToolJson(res);
      expect(body.regenerated).toBe(false);
      expect(body.reason).toBe('threshold_not_met');
      expect(body.threshold).toBe(50);
      // No memo created.
      expect(store.getLatestProjectMemo({ project_root: projectRoot })).toBeUndefined();
    });

    it('force=true regenerates even when the threshold is not met', async () => {
      const { server, tools } = buildFakeServer();
      const inference = makeInference(SAMPLE_MEMO);
      const ctx = buildCtx(store, projectRoot, inference, 50);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('regenerate_project_memo')!;
      const res = await tool.handler({ force: true });
      const body = parseToolJson(res);
      expect(body.regenerated).toBe(true);
      const memo = body.memo as { id: number; memo_md: string; version: number };
      expect(memo.memo_md).toContain('Architecture');
      expect(memo.version).toBe(1);
      // Stored.
      const fetched = store.getLatestProjectMemo({ project_root: projectRoot });
      expect(fetched).toBeDefined();
      expect(fetched!.memo_md).toContain('Architecture');
    });

    it('regenerates when threshold IS met without force', async () => {
      const { server, tools } = buildFakeServer();
      const inference = makeInference(SAMPLE_MEMO);
      // Threshold 1 → with 2 seeded decisions we're already over.
      const ctx = buildCtx(store, projectRoot, inference, 1);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('regenerate_project_memo')!;
      const res = await tool.handler({});
      const body = parseToolJson(res);
      expect(body.regenerated).toBe(true);
    });

    it('returns regenerated=false with empty_or_boilerplate when LLM returns nonsense', async () => {
      const { server, tools } = buildFakeServer();
      // Generic boilerplate that shares no input tokens.
      const inference = makeInference(
        '## Architecture\n\nThis project uses good engineering practices.',
      );
      const ctx = buildCtx(store, projectRoot, inference, 1);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('regenerate_project_memo')!;
      const res = await tool.handler({ force: true });
      const body = parseToolJson(res);
      expect(body.regenerated).toBe(false);
      expect(body.reason).toBe('empty_or_boilerplate');
      expect(store.getLatestProjectMemo({ project_root: projectRoot })).toBeUndefined();
    });

    it('bumps version on subsequent regenerations', async () => {
      const { server, tools } = buildFakeServer();
      const inference = makeInference(SAMPLE_MEMO);
      const ctx = buildCtx(store, projectRoot, inference, 1);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('regenerate_project_memo')!;
      await tool.handler({ force: true });
      const res2 = await tool.handler({ force: true });
      const body = parseToolJson(res2);
      const memo = body.memo as { version: number };
      expect(memo.version).toBe(2);
    });
  });

  describe('get_project_memo', () => {
    it('returns memo=null when no memo exists', async () => {
      const { server, tools } = buildFakeServer();
      const ctx = buildCtx(store, projectRoot, null, 1);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('get_project_memo')!;
      const res = await tool.handler({});
      const body = parseToolJson(res);
      expect(body.memo).toBeNull();
    });

    it('returns the latest memo when one exists', async () => {
      store.saveProjectMemo({
        project_root: projectRoot,
        memo_md: 'hello world',
        decisions_at_generation: 2,
        clusters_at_generation: 0,
        estimated_tokens: 3,
      });
      const { server, tools } = buildFakeServer();
      const ctx = buildCtx(store, projectRoot, null, 1);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('get_project_memo')!;
      const res = await tool.handler({});
      const body = parseToolJson(res);
      const memo = body.memo as { memo_md: string; version: number };
      expect(memo.memo_md).toBe('hello world');
      expect(memo.version).toBe(1);
    });

    it('returns history when include_history=true', async () => {
      for (let i = 0; i < 3; i++) {
        store.saveProjectMemo({
          project_root: projectRoot,
          memo_md: `v${i + 1}`,
          decisions_at_generation: 0,
          clusters_at_generation: 0,
          estimated_tokens: 1,
        });
      }
      const { server, tools } = buildFakeServer();
      const ctx = buildCtx(store, projectRoot, null, 1);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('get_project_memo')!;
      const res = await tool.handler({ include_history: true });
      const body = parseToolJson(res);
      const history = body.history as Array<{ version: number }>;
      expect(history).toHaveLength(3);
      expect(history[0].version).toBe(3);
    });
  });
});
