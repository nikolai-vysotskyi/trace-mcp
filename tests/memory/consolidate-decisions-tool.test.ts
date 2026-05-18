/**
 * Integration test for the consolidate_decisions MCP tool.
 * Captures the registered handler from a fake McpServer and exercises it
 * directly with a stubbed aiProvider.
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

function buildFakeServer(): { server: unknown; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (name: string, description: string, _schema: unknown, handler: unknown) => {
      tools.set(name, { description, handler: handler as CapturedTool['handler'] });
    },
  };
  return { server, tools };
}

function makeInference(responseText: string | ((prompt: string) => string)): InferenceService & {
  generate: ReturnType<typeof vi.fn>;
} {
  return {
    generate: vi.fn(async (prompt: string) =>
      typeof responseText === 'function' ? responseText(prompt) : responseText,
    ),
  };
}

function buildCtx(
  store: DecisionStore,
  projectRoot: string,
  inference: InferenceService | null,
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
      memory: { recall: { timeoutMs: 5000 } },
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

describe('consolidate_decisions tool', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/consolidate-tool-test';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-tool-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  function seedFiveWithTwoDuplicates(): {
    a: number;
    aDup: number;
    b: number;
    bDup: number;
    c: number;
  } {
    const a = store.addDecision({
      title: 'Use JWT for authentication',
      content: 'Bearer tokens, 15-minute access window, 30-day refresh.',
      type: 'tech_choice',
      project_root: projectRoot,
    }).id;
    const aDup = store.addDecision({
      title: 'Use JWT for auth',
      content: 'JWT bearer with refresh tokens.',
      type: 'tech_choice',
      project_root: projectRoot,
    }).id;
    const b = store.addDecision({
      title: 'Store sessions in Redis',
      content: 'Redis with 24h TTL.',
      type: 'architecture_decision',
      project_root: projectRoot,
    }).id;
    const bDup = store.addDecision({
      title: 'Sessions live in Redis',
      content: 'Use Redis for ephemeral session state.',
      type: 'architecture_decision',
      project_root: projectRoot,
    }).id;
    const c = store.addDecision({
      title: 'Postgres as primary database',
      content: 'Single Postgres cluster, no sharding initially.',
      type: 'tech_choice',
      project_root: projectRoot,
    }).id;
    return { a, aDup, b, bDup, c };
  }

  it('without aiProvider returns a structured error', async () => {
    const { server, tools } = buildFakeServer();
    const ctx = buildCtx(store, projectRoot, null);
    registerMemoryTools(server as never, ctx);
    const tool = tools.get('consolidate_decisions')!;
    expect(tool).toBeDefined();
    const res = await tool.handler({});
    expect(res.isError).toBe(true);
    const body = parseToolJson(res);
    expect(body.error).toBe('no_ai_provider');
    expect(body.evaluated).toBe(0);
    expect(body.verdicts).toEqual([]);
    expect(body.applied_count).toBe(0);
  });

  it('dry_run=true (default) emits verdicts without mutating the store', async () => {
    const { server, tools } = buildFakeServer();
    const ids = seedFiveWithTwoDuplicates();
    // Stub the LLM to merge `a` into `aDup` whenever called with a prompt
    // that mentions JWT.
    const inference = makeInference((prompt) => {
      if (prompt.includes('JWT')) {
        // The newest row is queried first (recency order). When the subject
        // is aDup, the candidate is `a`. Otherwise, no merge.
        return JSON.stringify([{ existing_id: ids.a, verdict: 'merge_into_existing' }]);
      }
      if (prompt.includes('Redis')) {
        return JSON.stringify([{ existing_id: ids.b, verdict: 'merge_into_existing' }]);
      }
      return '[]';
    });
    const ctx = buildCtx(store, projectRoot, inference);
    registerMemoryTools(server as never, ctx);
    const tool = tools.get('consolidate_decisions')!;
    const res = await tool.handler({ dry_run: true });
    const body = parseToolJson(res);

    expect(body.dry_run).toBe(true);
    expect(body.applied_count).toBe(0);
    expect(Array.isArray(body.verdicts)).toBe(true);
    expect((body.verdicts as unknown[]).length).toBeGreaterThanOrEqual(1);
    // Store unchanged: all five rows still active.
    expect(store.getDecision(ids.a)?.valid_until).toBeNull();
    expect(store.getDecision(ids.aDup)?.valid_until).toBeNull();
    expect(store.getDecision(ids.b)?.valid_until).toBeNull();
    expect(store.getDecision(ids.bDup)?.valid_until).toBeNull();
    expect(store.getDecision(ids.c)?.valid_until).toBeNull();
  });

  it('dry_run=false applies merges (subject is invalidated, existing updated)', async () => {
    const { server, tools } = buildFakeServer();
    const ids = seedFiveWithTwoDuplicates();
    const inference = makeInference((prompt) => {
      if (prompt.includes('JWT')) {
        return JSON.stringify([{ existing_id: ids.a, verdict: 'merge_into_existing' }]);
      }
      return '[]';
    });
    const ctx = buildCtx(store, projectRoot, inference);
    registerMemoryTools(server as never, ctx);
    const tool = tools.get('consolidate_decisions')!;
    const res = await tool.handler({ dry_run: false });
    const body = parseToolJson(res);

    expect(body.dry_run).toBe(false);
    expect(body.applied_count).toBeGreaterThanOrEqual(1);
    // Existing row `a` should now contain merged content.
    const merged = store.getDecision(ids.a);
    expect(merged?.content).toContain('[merged]');
    // At least one of the JWT-titled rows is now invalidated.
    const aDup = store.getDecision(ids.aDup);
    expect(aDup?.valid_until).not.toBeNull();
  });

  it('honors max_decisions as a cost guard', async () => {
    const { server, tools } = buildFakeServer();
    seedFiveWithTwoDuplicates();
    const inference = makeInference('[]');
    const ctx = buildCtx(store, projectRoot, inference);
    registerMemoryTools(server as never, ctx);
    const tool = tools.get('consolidate_decisions')!;
    const res = await tool.handler({ dry_run: true, max_decisions: 2 });
    const body = parseToolJson(res);
    // evaluated includes subjects we processed (with or without candidates).
    expect(body.evaluated).toBeLessThanOrEqual(2);
  });

  it('returns evaluated=0 when scope is empty', async () => {
    const { server, tools } = buildFakeServer();
    const inference = makeInference('[]');
    const ctx = buildCtx(store, projectRoot, inference);
    registerMemoryTools(server as never, ctx);
    const tool = tools.get('consolidate_decisions')!;
    const res = await tool.handler({});
    const body = parseToolJson(res);
    expect(body.evaluated).toBe(0);
    expect(body.verdicts).toEqual([]);
  });

  it('keep_separate verdicts (empty LLM response) leave the store intact', async () => {
    const { server, tools } = buildFakeServer();
    const ids = seedFiveWithTwoDuplicates();
    const inference = makeInference('[]');
    const ctx = buildCtx(store, projectRoot, inference);
    registerMemoryTools(server as never, ctx);
    const tool = tools.get('consolidate_decisions')!;
    const res = await tool.handler({ dry_run: false });
    const body = parseToolJson(res);
    expect(body.applied_count).toBe(0);
    // All rows still active.
    for (const id of Object.values(ids)) {
      expect(store.getDecision(id)?.valid_until).toBeNull();
    }
  });

  it('exposes the verdict shape expected by callers', async () => {
    const { server, tools } = buildFakeServer();
    const ids = seedFiveWithTwoDuplicates();
    const inference = makeInference((prompt) => {
      if (prompt.includes('JWT')) {
        return JSON.stringify([{ existing_id: ids.a, verdict: 'replace_existing' }]);
      }
      return '[]';
    });
    const ctx = buildCtx(store, projectRoot, inference);
    registerMemoryTools(server as never, ctx);
    const tool = tools.get('consolidate_decisions')!;
    const res = await tool.handler({ dry_run: true });
    const body = parseToolJson(res);
    const verdicts = body.verdicts as Array<Record<string, unknown>>;
    expect(verdicts.length).toBeGreaterThanOrEqual(1);
    const first = verdicts[0];
    expect(typeof first.subject_id).toBe('number');
    expect(Array.isArray(first.affected_ids)).toBe(true);
    expect(typeof first.applied).toBe('boolean');
    const verdict = first.verdict as Record<string, unknown>;
    expect(typeof verdict.kind).toBe('string');
  });
});
