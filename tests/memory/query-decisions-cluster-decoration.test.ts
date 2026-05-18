/**
 * Test for P1.1 close-out: query_decisions decorates each returned row with
 * its cluster membership(s) and emits a `clusters_summary` keyed off the
 * unique cluster ids in the page. Decisions not in any cluster carry no
 * `cluster_ids` field (keeps the unclustered-store payload unchanged).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';
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
  const server = {
    tool: (name: string, description: string, _schema: unknown, handler: unknown) => {
      tools.set(name, { description, handler: handler as CapturedTool['handler'] });
    },
  };
  return { server, tools };
}

function buildCtx(store: DecisionStore, projectRoot: string): ServerContext {
  return {
    projectRoot,
    decisionStore: store,
    topoStore: null,
    config: {
      memory: { recall: { timeoutMs: 5000 } },
    } as unknown as ServerContext['config'],
    aiProvider: null as unknown as ServerContext['aiProvider'],
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

describe('query_decisions — cluster decoration (P1.1 close-out)', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/query-cluster-decor';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-cluster-decor-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('decorates rows with cluster_ids and emits clusters_summary', async () => {
    // Seed 5 decisions. 3 will land in cluster A, 2 in cluster B.
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        store.addDecision({
          title: `decision-${i + 1}`,
          content: 'c',
          type: 'tech_choice',
          project_root: projectRoot,
        }).id,
      );
    }
    const clusterA = store.createCluster({
      project_root: projectRoot,
      title: 'Cluster A',
      summary: 'a-topic',
      tags: ['a'],
      primary_type: 'tech_choice',
      decision_ids: ids.slice(0, 3),
    });
    const clusterB = store.createCluster({
      project_root: projectRoot,
      title: 'Cluster B',
      summary: 'b-topic',
      tags: ['b'],
      primary_type: 'tech_choice',
      decision_ids: ids.slice(3, 5),
    });

    const { server, tools } = buildFakeServer();
    registerMemoryTools(server as never, buildCtx(store, projectRoot));
    const tool = tools.get('query_decisions');
    expect(tool).toBeDefined();
    // git_branch:"all" sidesteps any local-branch filter that would
    // otherwise depend on the test runner's working tree.
    const res = await tool!.handler({ git_branch: 'all' });
    const body = parseToolJson(res) as {
      decisions: Array<{ id: number; cluster_ids?: number[] }>;
      clusters_summary?: Array<{ id: number; title: string }>;
      total_results: number;
    };

    expect(body.total_results).toBe(5);
    // Map each id to its decorated cluster_ids for an order-independent
    // assertion; the page is ordered by valid_from DESC by default.
    const byId = new Map<number, number[] | undefined>();
    for (const row of body.decisions) {
      byId.set(row.id, row.cluster_ids);
    }
    for (const id of ids.slice(0, 3)) {
      expect(byId.get(id)).toEqual([clusterA.id]);
    }
    for (const id of ids.slice(3, 5)) {
      expect(byId.get(id)).toEqual([clusterB.id]);
    }

    expect(body.clusters_summary).toBeDefined();
    expect(body.clusters_summary).toHaveLength(2);
    const summaryById = new Map(body.clusters_summary!.map((c) => [c.id, c.title]));
    expect(summaryById.get(clusterA.id)).toBe('Cluster A');
    expect(summaryById.get(clusterB.id)).toBe('Cluster B');
  });

  it('omits cluster_ids on rows that are not in any cluster and omits clusters_summary entirely when no rows are clustered', async () => {
    for (let i = 0; i < 3; i++) {
      store.addDecision({
        title: `solo-${i + 1}`,
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
    }
    const { server, tools } = buildFakeServer();
    registerMemoryTools(server as never, buildCtx(store, projectRoot));
    const tool = tools.get('query_decisions');
    const res = await tool!.handler({ git_branch: 'all' });
    const body = parseToolJson(res) as {
      decisions: Array<Record<string, unknown>>;
      clusters_summary?: unknown;
      total_results: number;
    };
    expect(body.total_results).toBe(3);
    for (const row of body.decisions) {
      expect(row).not.toHaveProperty('cluster_ids');
    }
    expect(body.clusters_summary).toBeUndefined();
  });

  it('sorts cluster_ids ASC when a decision belongs to multiple clusters', async () => {
    const d = store.addDecision({
      title: 'multi',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    const c1 = store.createCluster({
      project_root: projectRoot,
      title: 'C-one',
      summary: 's',
      tags: [],
      primary_type: 'tech_choice',
      decision_ids: [d.id],
    });
    const c2 = store.createCluster({
      project_root: projectRoot,
      title: 'C-two',
      summary: 's',
      tags: [],
      primary_type: 'tech_choice',
      decision_ids: [d.id],
    });
    const { server, tools } = buildFakeServer();
    registerMemoryTools(server as never, buildCtx(store, projectRoot));
    const tool = tools.get('query_decisions');
    const res = await tool!.handler({ git_branch: 'all' });
    const body = parseToolJson(res) as {
      decisions: Array<{ id: number; cluster_ids?: number[] }>;
    };
    const row = body.decisions.find((r) => r.id === d.id);
    expect(row?.cluster_ids).toEqual([c1.id, c2.id].sort((a, b) => a - b));
  });
});
