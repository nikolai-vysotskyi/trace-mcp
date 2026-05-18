/**
 * Verifies the `recordHitsAsync` wiring in `registerMemoryTools` actually
 * fires when the read-side surfaces (query_decisions, get_decision_timeline,
 * get_wake_up) return rows. The hit recorder runs through `queueMicrotask`,
 * so each test awaits a microtask flush before reading hit_count.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      memory: { recall: { timeoutMs: 5000 }, heat: { enabled: true } },
    } as unknown as ServerContext['config'],
    aiProvider: {
      isAvailable: vi.fn(async () => false),
      inference: () => ({ generate: vi.fn(async () => '[]') }),
    } as unknown as ServerContext['aiProvider'],
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

async function flushMicrotasks(): Promise<void> {
  // queueMicrotask resolves immediately; await Promise.resolve twice for safety.
  await Promise.resolve();
  await Promise.resolve();
}

describe('memory tools — heat hit-tracking wiring', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/heat-wiring-test';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heat-wiring-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  function seedThree(): number[] {
    return [
      store.addDecision({
        title: 'd1',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id,
      store.addDecision({
        title: 'd2',
        content: 'c',
        type: 'architecture_decision',
        project_root: projectRoot,
      }).id,
      store.addDecision({
        title: 'd3',
        content: 'c',
        type: 'preference',
        project_root: projectRoot,
      }).id,
    ];
  }

  it('query_decisions increments hit_count for every returned row', async () => {
    const ids = seedThree();
    const { server, tools } = buildFakeServer();
    const ctx = buildCtx(store, projectRoot);
    registerMemoryTools(server as never, ctx);
    const tool = tools.get('query_decisions')!;
    expect(tool).toBeDefined();
    await tool.handler({});
    await flushMicrotasks();
    for (const id of ids) {
      const row = store.getDecision(id)!;
      expect(row.hit_count).toBe(1);
      expect(row.last_hit_at).not.toBeNull();
    }
  });

  it('get_decision_timeline increments hit_count for every returned row', async () => {
    const ids = seedThree();
    const { server, tools } = buildFakeServer();
    const ctx = buildCtx(store, projectRoot);
    registerMemoryTools(server as never, ctx);
    const tool = tools.get('get_decision_timeline')!;
    await tool.handler({});
    await flushMicrotasks();
    for (const id of ids) {
      expect(store.getDecision(id)!.hit_count).toBe(1);
    }
  });

  it('get_wake_up records hits on dynamic rows only (recent_decisions + in_progress)', async () => {
    // tech_choice / preference rows land in recent_decisions (dynamic).
    // architecture_decision rows land in stable.architecture and convention
    // rows land in stable.conventions — both are stable surfaces that the
    // wake-up handler intentionally skips for hit accounting (always-shown
    // noise, per the spec).
    const dynamicId1 = store.addDecision({
      title: 'tech choice',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
    }).id;
    const dynamicId2 = store.addDecision({
      title: 'preference',
      content: 'c',
      type: 'preference',
      project_root: projectRoot,
    }).id;
    const stableArchId = store.addDecision({
      title: 'arch',
      content: 'c',
      type: 'architecture_decision',
      project_root: projectRoot,
    }).id;
    // Discovery lands in in_progress (also dynamic).
    const inProgressId = store.addDecision({
      title: 'discovery thing',
      content: 'c',
      type: 'discovery',
      project_root: projectRoot,
    }).id;

    const { server, tools } = buildFakeServer();
    const ctx = buildCtx(store, projectRoot);
    registerMemoryTools(server as never, ctx);
    const tool = tools.get('get_wake_up')!;
    await tool.handler({ auto_mine: false });
    await flushMicrotasks();

    // Dynamic rows: hit.
    expect(store.getDecision(dynamicId1)!.hit_count).toBeGreaterThanOrEqual(1);
    expect(store.getDecision(dynamicId2)!.hit_count).toBeGreaterThanOrEqual(1);
    expect(store.getDecision(inProgressId)!.hit_count).toBeGreaterThanOrEqual(1);
    // Stable architecture row: NOT hit (always-shown noise per spec).
    expect(store.getDecision(stableArchId)!.hit_count).toBe(0);
  });

  it('heat disabled — config.memory.heat.enabled=false — skips hit writes', async () => {
    const ids = seedThree();
    const { server, tools } = buildFakeServer();
    const ctx = buildCtx(store, projectRoot);
    // Override heat to disabled. Cast through unknown because the test config
    // type is intentionally a partial.
    (ctx.config as unknown as { memory: { heat: { enabled: boolean } } }).memory.heat.enabled =
      false;
    registerMemoryTools(server as never, ctx);
    const tool = tools.get('query_decisions')!;
    await tool.handler({});
    await flushMicrotasks();
    for (const id of ids) {
      expect(store.getDecision(id)!.hit_count).toBe(0);
    }
  });
});
