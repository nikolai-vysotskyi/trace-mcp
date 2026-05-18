/**
 * Integration test for the build_decision_clusters / get_decision_clusters /
 * get_cluster_decisions MCP tools. Captures the registered handlers from a
 * fake McpServer and exercises them directly with a stubbed aiProvider.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';
import type { InferenceService } from '../../src/ai/interfaces.js';
import { registerMemoryTools } from '../../src/tools/register/memory.js';
import type { ServerContext } from '../../src/server/types.js';

interface CapturedTool {
  description: string;
  handler: (params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function buildFakeServer(): { server: unknown; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  // Minimal stub matching the shape registerMemoryTools touches.
  const server = {
    tool: (name: string, description: string, _schema: unknown, handler: unknown) => {
      tools.set(name, { description, handler: handler as CapturedTool['handler'] });
    },
  };
  return { server, tools };
}

function makeInference(responseText: string): InferenceService {
  return {
    generate: vi.fn(async () => responseText),
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
    // Unused-but-required fields stubbed minimally — these tools never touch them.
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

describe('build_decision_clusters / get_decision_clusters / get_cluster_decisions', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/cluster-tools-test';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-tools-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  function seedDecisions(): { authIds: number[]; deployIds: number[] } {
    const authIds = [
      store.addDecision({
        title: 'Use JWT auth',
        content: 'short-lived JWTs with refresh tokens.',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id,
      store.addDecision({
        title: 'Sessions in Redis',
        content: 'Store user sessions in Redis with TTL.',
        type: 'architecture_decision',
        project_root: projectRoot,
      }).id,
    ];
    const deployIds = [
      store.addDecision({
        title: 'Blue-green deploys',
        content: 'Two prod environments, swap traffic on deploy.',
        type: 'architecture_decision',
        project_root: projectRoot,
      }).id,
      store.addDecision({
        title: 'GitHub Actions CI',
        content: 'CI on every PR via GitHub Actions.',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id,
    ];
    return { authIds, deployIds };
  }

  function fakeClusterResponse(
    authIds: number[],
    deployIds: number[],
    titles: { auth?: string; deploy?: string } = {},
  ): string {
    const arr = [
      {
        title: titles.auth ?? 'Authentication',
        summary: 'Auth + session handling decisions.',
        tags: ['auth', 'security'],
        decision_ids: authIds,
        primary_type: 'tech_choice',
      },
      {
        title: titles.deploy ?? 'Deployment',
        summary: 'How we ship code.',
        tags: ['deploy', 'ci'],
        decision_ids: deployIds,
        primary_type: 'architecture_decision',
      },
    ];
    return JSON.stringify(arr);
  }

  describe('build_decision_clusters', () => {
    it('without aiProvider returns a structured error, not a throw', async () => {
      const { server, tools } = buildFakeServer();
      const ctx = buildCtx(store, projectRoot, null);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('build_decision_clusters')!;
      expect(tool).toBeDefined();
      const res = await tool.handler({});
      expect(res.isError).toBe(true);
      const body = parseToolJson(res);
      expect(body.error).toBe('no_ai_provider');
      expect(typeof body.message).toBe('string');
      // No clusters were created.
      expect(store.countClusters({ project_root: projectRoot })).toBe(0);
    });

    it('dry_run=true computes but does not write', async () => {
      const { server, tools } = buildFakeServer();
      const { authIds, deployIds } = seedDecisions();
      const inference = makeInference(fakeClusterResponse(authIds, deployIds));
      const ctx = buildCtx(store, projectRoot, inference);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('build_decision_clusters')!;
      const res = await tool.handler({ dry_run: true });
      const body = parseToolJson(res);
      expect(body.dry_run).toBe(true);
      expect(body.created).toBe(0);
      expect(body.updated).toBe(0);
      expect(Array.isArray(body.clusters)).toBe(true);
      expect((body.clusters as unknown[]).length).toBe(2);
      // Real store unchanged.
      expect(store.countClusters({ project_root: projectRoot })).toBe(0);
    });

    it('first run creates clusters', async () => {
      const { server, tools } = buildFakeServer();
      const { authIds, deployIds } = seedDecisions();
      const inference = makeInference(fakeClusterResponse(authIds, deployIds));
      const ctx = buildCtx(store, projectRoot, inference);
      registerMemoryTools(server as never, ctx);
      const tool = tools.get('build_decision_clusters')!;
      const res = await tool.handler({});
      const body = parseToolJson(res);
      expect(body.created).toBe(2);
      expect(body.updated).toBe(0);
      expect(body.total_after).toBe(2);
      expect(store.countClusters({ project_root: projectRoot })).toBe(2);
    });

    it('second run with same titles merges into existing rows (updated count)', async () => {
      const { server, tools } = buildFakeServer();
      const { authIds, deployIds } = seedDecisions();
      const inference1 = makeInference(fakeClusterResponse(authIds, deployIds));
      const ctx1 = buildCtx(store, projectRoot, inference1);
      registerMemoryTools(server as never, ctx1);
      await tools.get('build_decision_clusters')!.handler({});
      expect(store.countClusters({ project_root: projectRoot })).toBe(2);

      // Second-run server with a fresh handler closure. Same titles → merged.
      const { server: server2, tools: tools2 } = buildFakeServer();
      const inference2 = makeInference(fakeClusterResponse(authIds, deployIds));
      const ctx2 = buildCtx(store, projectRoot, inference2);
      registerMemoryTools(server2 as never, ctx2);
      const res = await tools2.get('build_decision_clusters')!.handler({});
      const body = parseToolJson(res);
      expect(body.created).toBe(0);
      expect(body.updated).toBe(2);
      expect(body.removed).toBe(0);
      expect(store.countClusters({ project_root: projectRoot })).toBe(2);
    });

    it('force=true drops scope clusters and rebuilds', async () => {
      const { server, tools } = buildFakeServer();
      const { authIds, deployIds } = seedDecisions();
      const inference = makeInference(fakeClusterResponse(authIds, deployIds));
      const ctx = buildCtx(store, projectRoot, inference);
      registerMemoryTools(server as never, ctx);
      await tools.get('build_decision_clusters')!.handler({});
      expect(store.countClusters({ project_root: projectRoot })).toBe(2);

      // Force rebuild with totally different titles so the merge path can't fire.
      const { server: server2, tools: tools2 } = buildFakeServer();
      const inference2 = makeInference(
        fakeClusterResponse(authIds, deployIds, { auth: 'Identity layer', deploy: 'Release flow' }),
      );
      const ctx2 = buildCtx(store, projectRoot, inference2);
      registerMemoryTools(server2 as never, ctx2);
      const res = await tools2.get('build_decision_clusters')!.handler({ force: true });
      const body = parseToolJson(res);
      expect(body.removed).toBe(2);
      expect(body.created).toBe(2);
      expect(body.updated).toBe(0);
      expect(store.countClusters({ project_root: projectRoot })).toBe(2);
    });
  });

  describe('get_decision_clusters', () => {
    it('returns FTS-filtered results with previews', async () => {
      const { server, tools } = buildFakeServer();
      const { authIds, deployIds } = seedDecisions();
      const inference = makeInference(fakeClusterResponse(authIds, deployIds));
      const ctx = buildCtx(store, projectRoot, inference);
      registerMemoryTools(server as never, ctx);
      await tools.get('build_decision_clusters')!.handler({});

      const res = await tools.get('get_decision_clusters')!.handler({ search: 'auth*' });
      const body = parseToolJson(res);
      expect(body.total).toBe(1);
      const clusters = body.clusters as Array<Record<string, unknown>>;
      expect(clusters[0].title).toBe('Authentication');
      expect(Array.isArray(clusters[0].decisions_preview)).toBe(true);
      expect((clusters[0].decisions_preview as string[]).length).toBeGreaterThan(0);
      expect((clusters[0].tags as string[]).sort()).toEqual(['auth', 'security']);
    });

    it('returns all clusters when no search is provided', async () => {
      const { server, tools } = buildFakeServer();
      const { authIds, deployIds } = seedDecisions();
      const inference = makeInference(fakeClusterResponse(authIds, deployIds));
      const ctx = buildCtx(store, projectRoot, inference);
      registerMemoryTools(server as never, ctx);
      await tools.get('build_decision_clusters')!.handler({});
      const res = await tools.get('get_decision_clusters')!.handler({});
      const body = parseToolJson(res);
      expect(body.total).toBe(2);
    });
  });

  describe('get_cluster_decisions', () => {
    it('returns the cluster header + member decisions', async () => {
      const { server, tools } = buildFakeServer();
      const { authIds, deployIds } = seedDecisions();
      const inference = makeInference(fakeClusterResponse(authIds, deployIds));
      const ctx = buildCtx(store, projectRoot, inference);
      registerMemoryTools(server as never, ctx);
      await tools.get('build_decision_clusters')!.handler({});
      const listRes = await tools.get('get_decision_clusters')!.handler({});
      const list = parseToolJson(listRes);
      const firstId = (list.clusters as Array<{ id: number }>)[0].id;

      const res = await tools.get('get_cluster_decisions')!.handler({ id: firstId });
      const body = parseToolJson(res);
      expect(body.cluster).not.toBeNull();
      const cluster = body.cluster as Record<string, unknown>;
      expect(cluster.id).toBe(firstId);
      expect(Array.isArray(body.decisions)).toBe(true);
      expect((body.decisions as unknown[]).length).toBeGreaterThan(0);
    });

    it('returns cluster: null for an unknown id', async () => {
      const { server, tools } = buildFakeServer();
      const inference = makeInference('[]');
      const ctx = buildCtx(store, projectRoot, inference);
      registerMemoryTools(server as never, ctx);
      const res = await tools.get('get_cluster_decisions')!.handler({ id: 99999 });
      const body = parseToolJson(res);
      expect(body.cluster).toBeNull();
      expect(body.decisions).toEqual([]);
    });
  });
});
