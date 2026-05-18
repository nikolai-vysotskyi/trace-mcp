/**
 * Integration test for the P2.5 `tune_decision_weights` MCP tool. Captures
 * the registered handler from a fake McpServer and exercises it directly.
 *
 * The test re-points TRACE_MCP_HOME to a per-test tmp dir before importing
 * any modules so saveWeights/loadWeights never touch the real
 * ~/.trace-mcp/confidence_weights.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

// Point TRACE_MCP_DATA_DIR at a process-scoped tmp dir *before* any module
// that reads the env var is imported. Vitest evaluates the test file top-down
// so an import below the env mutation sees the new value (each test file
// gets its own worker context, so this doesn't leak across files).
const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-tool-home-'));
process.env.TRACE_MCP_DATA_DIR = sharedHome;

const { DecisionStore } = await import('../../src/memory/decision-store.js');
const { registerMemoryTools } = await import('../../src/tools/register/memory.js');
const { WEIGHTS_PATH, DEFAULT_WEIGHTS } = await import('../../src/memory/confidence-tuner.js');
const { resetCachedWeights } = await import('../../src/memory/decision-confidence.js');
type ServerContext = import('../../src/server/types.js').ServerContext;

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

function buildCtx(store: InstanceType<typeof DecisionStore>, projectRoot: string): ServerContext {
  return {
    projectRoot,
    decisionStore: store,
    topoStore: null,
    config: {
      memory: {
        recall: { timeoutMs: 5000 },
        weight_tuning: { enabled: true, min_events: 25 },
      },
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

/**
 * Seed N approved + N rejected decisions into the store and toggle each one
 * so the review log accumulates 2N events. Approvals carry a code reference
 * + high-signal type so the fitter has signal to learn.
 */
function seedReviewEvents(
  store: InstanceType<typeof DecisionStore>,
  projectRoot: string,
  n: number,
) {
  for (let i = 0; i < n; i++) {
    const d = store.addDecision({
      title: `approved-${i}`,
      content: 'a'.repeat(250),
      type: 'architecture_decision',
      project_root: projectRoot,
      file_path: `src/file-${i}.ts`,
      tags: ['x'],
      review_status: 'pending',
    });
    store.setReviewStatus(d.id, 'approved');
  }
  for (let i = 0; i < n; i++) {
    const d = store.addDecision({
      title: `rejected-${i}`,
      content: 'short',
      type: 'preference',
      project_root: projectRoot,
      review_status: 'pending',
    });
    store.setReviewStatus(d.id, 'rejected');
  }
}

describe('tune_decision_weights tool', () => {
  const projectRoot = '/projects/tune-tool-test';
  let store: InstanceType<typeof DecisionStore>;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-tool-db-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
    resetCachedWeights();
    // Clean any leftover weights file from prior tests.
    if (fs.existsSync(WEIGHTS_PATH)) fs.unlinkSync(WEIGHTS_PATH);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(WEIGHTS_PATH)) fs.unlinkSync(WEIGHTS_PATH);
    resetCachedWeights();
  });

  afterAll(() => {
    fs.rmSync(sharedHome, { recursive: true, force: true });
  });

  it('returns ok=false with reason insufficient_events when no reviews exist', async () => {
    const { server, tools } = buildFakeServer();
    registerMemoryTools(server as never, buildCtx(store, projectRoot));
    const tool = tools.get('tune_decision_weights');
    expect(tool).toBeDefined();
    const res = await tool!.handler({});
    const json = parseToolJson(res);
    expect(json.ok).toBe(false);
    expect(json.reason).toBe('insufficient_events');
    expect(json.applied).toBe(false);
  });

  it('dry_run=true (default) does NOT persist weights to disk', async () => {
    seedReviewEvents(store, projectRoot, 15);
    const { server, tools } = buildFakeServer();
    registerMemoryTools(server as never, buildCtx(store, projectRoot));
    const res = await tools.get('tune_decision_weights')!.handler({ min_events: 25 });
    const json = parseToolJson(res);
    expect(json.ok).toBe(true);
    expect(json.applied).toBe(false);
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(false);
    expect(json.weights).toBeTruthy();
    expect(json.before).toBeTruthy();
  });

  it('dry_run=false persists weights to disk and resets the cache', async () => {
    seedReviewEvents(store, projectRoot, 15);
    const { server, tools } = buildFakeServer();
    registerMemoryTools(server as never, buildCtx(store, projectRoot));
    const res = await tools
      .get('tune_decision_weights')!
      .handler({ dry_run: false, min_events: 25 });
    const json = parseToolJson(res);
    expect(json.ok).toBe(true);
    expect(json.applied).toBe(true);
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf-8'));
    expect(onDisk.version).toBe(1);
    expect(typeof onDisk.codeRef).toBe('number');
  });

  it('honours min_events parameter override', async () => {
    seedReviewEvents(store, projectRoot, 5); // 10 events total
    const { server, tools } = buildFakeServer();
    registerMemoryTools(server as never, buildCtx(store, projectRoot));
    // Default min_events=25 should refuse to fit.
    const refused = parseToolJson(await tools.get('tune_decision_weights')!.handler({}));
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('insufficient_events');

    // Lowering min_events to 10 unlocks the fit.
    const fitted = parseToolJson(
      await tools.get('tune_decision_weights')!.handler({ min_events: 10 }),
    );
    expect(fitted.ok).toBe(true);
  });

  it('filters review events by project_root', async () => {
    // Seed in two projects — only project A should be visible to the tool.
    seedReviewEvents(store, '/projects/A', 15);
    seedReviewEvents(store, '/projects/B', 15);
    const { server, tools } = buildFakeServer();
    registerMemoryTools(server as never, buildCtx(store, '/projects/A'));
    const res = await tools.get('tune_decision_weights')!.handler({ min_events: 25 });
    const json = parseToolJson(res) as Record<string, unknown>;
    expect(json.events_used).toBe(30); // 2 * 15 from project A only
  });

  it('reports loss_before and loss_after when fit succeeds', async () => {
    seedReviewEvents(store, projectRoot, 15);
    const { server, tools } = buildFakeServer();
    registerMemoryTools(server as never, buildCtx(store, projectRoot));
    const res = await tools.get('tune_decision_weights')!.handler({ min_events: 25 });
    const json = parseToolJson(res) as Record<string, number>;
    expect(typeof json.loss_before).toBe('number');
    expect(typeof json.loss_after).toBe('number');
    expect(json.loss_after).toBeLessThanOrEqual(json.loss_before);
  });
});

// Hard-pin types from the seedReviewEvents helper to satisfy ts-no-unused-vars
// when DEFAULT_WEIGHTS is otherwise only used at runtime as part of weights JSON.
void DEFAULT_WEIGHTS;
