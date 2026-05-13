import { describe, expect, it, vi } from 'vitest';
import type { EnvIndexer } from '../../indexer/env-indexer.js';
import { TaskDag } from '../task.js';
import {
  createGraphSnapshotsTask,
  GRAPH_SNAPSHOTS_TASK_NAME,
} from '../tasks/graph-snapshots-task.js';
import { createIndexEnvTask, INDEX_ENV_TASK_NAME } from '../tasks/index-env-task.js';
import { createLspEnrichmentTask, LSP_ENRICHMENT_TASK_NAME } from '../tasks/lsp-enrichment-task.js';
import { createResolveEdgesTask, RESOLVE_EDGES_TASK_NAME } from '../tasks/resolve-edges-task.js';

/**
 * Integration tests for the migrated pipeline passes registered as a single
 * TaskDag. These tests exercise the same orchestration shape as
 * `IndexingPipeline.runPipeline` uses, with stubbed adapters so the test
 * runs in milliseconds and does not need a fixture project on disk.
 *
 * We assert two things at this layer:
 *   1. The DAG can be composed and each Task fires in the expected order.
 *   2. The side-effects (counter increments, ordered call log) match what
 *      `runPipeline` would observe if it called the underlying methods
 *      directly.
 */

interface FakePipelineSideEffects {
  resolveEdgesCalls: number;
  lspEnrichmentCalls: number;
  graphSnapshotCalls: number;
  envIndexCalls: number;
  callOrder: string[];
}

function createFreshDag(effects: FakePipelineSideEffects): TaskDag {
  const dag = new TaskDag();
  dag.register(createResolveEdgesTask());
  dag.register(createLspEnrichmentTask());
  dag.register(createGraphSnapshotsTask());
  dag.register(createIndexEnvTask());
  return dag;
}

function buildClosures(effects: FakePipelineSideEffects) {
  const runResolveAllEdges = async () => {
    effects.resolveEdgesCalls++;
    effects.callOrder.push(RESOLVE_EDGES_TASK_NAME);
  };
  const runLspEnrichment = async () => {
    effects.lspEnrichmentCalls++;
    effects.callOrder.push(LSP_ENRICHMENT_TASK_NAME);
  };
  const captureSnapshots = () => {
    effects.graphSnapshotCalls++;
    effects.callOrder.push(GRAPH_SNAPSHOTS_TASK_NAME);
  };
  return { runResolveAllEdges, runLspEnrichment, captureSnapshots };
}

function freshEffects(): FakePipelineSideEffects {
  return {
    resolveEdgesCalls: 0,
    lspEnrichmentCalls: 0,
    graphSnapshotCalls: 0,
    envIndexCalls: 0,
    callOrder: [],
  };
}

function stubEnvIndexer(effects: FakePipelineSideEffects): EnvIndexer {
  const spy = vi.fn(async () => {
    effects.envIndexCalls++;
    effects.callOrder.push(INDEX_ENV_TASK_NAME);
  });
  return { indexEnvFiles: spy } as unknown as EnvIndexer;
}

describe('pipeline-dag-integration', () => {
  it('registers all four migrated tasks under their canonical names', () => {
    const effects = freshEffects();
    const dag = createFreshDag(effects);

    expect(dag.has(RESOLVE_EDGES_TASK_NAME)).toBe(true);
    expect(dag.has(LSP_ENRICHMENT_TASK_NAME)).toBe(true);
    expect(dag.has(GRAPH_SNAPSHOTS_TASK_NAME)).toBe(true);
    expect(dag.has(INDEX_ENV_TASK_NAME)).toBe(true);
    expect(dag.list()).toEqual([
      RESOLVE_EDGES_TASK_NAME,
      LSP_ENRICHMENT_TASK_NAME,
      GRAPH_SNAPSHOTS_TASK_NAME,
      INDEX_ENV_TASK_NAME,
    ]);
  });

  it('runs the full-postprocess sequence (resolve -> lsp -> env -> snapshots) end to end', async () => {
    // Equivalent to the IndexingPipeline.runPipeline call site when
    // postprocess='full' and a full reindex with indexed > 0. We invoke
    // each Task in the same order as the pipeline and assert the
    // side-effect log matches what runPipeline would record.
    const effects = freshEffects();
    const dag = createFreshDag(effects);
    const env = stubEnvIndexer(effects);
    const closures = buildClosures(effects);

    await dag.run(RESOLVE_EDGES_TASK_NAME, { runResolveAllEdges: closures.runResolveAllEdges });
    await dag.run(LSP_ENRICHMENT_TASK_NAME, { runLspEnrichment: closures.runLspEnrichment });
    await dag.run(INDEX_ENV_TASK_NAME, { envIndexer: env, force: false });
    await dag.run(GRAPH_SNAPSHOTS_TASK_NAME, { captureSnapshots: closures.captureSnapshots });

    expect(effects.resolveEdgesCalls).toBe(1);
    expect(effects.lspEnrichmentCalls).toBe(1);
    expect(effects.envIndexCalls).toBe(1);
    expect(effects.graphSnapshotCalls).toBe(1);
    expect(effects.callOrder).toEqual([
      RESOLVE_EDGES_TASK_NAME,
      LSP_ENRICHMENT_TASK_NAME,
      INDEX_ENV_TASK_NAME,
      GRAPH_SNAPSHOTS_TASK_NAME,
    ]);
  });

  it("runs only resolve-edges when postprocess='minimal' (mirrors the pipeline gating)", async () => {
    // Postprocess gating belongs to the pipeline, not the DAG — the DAG
    // simply runs what the pipeline asks for. This test asserts that
    // running only the resolve-edges Task produces a single resolveEdges
    // side-effect and nothing else.
    const effects = freshEffects();
    const dag = createFreshDag(effects);
    const closures = buildClosures(effects);

    await dag.run(RESOLVE_EDGES_TASK_NAME, { runResolveAllEdges: closures.runResolveAllEdges });

    expect(effects.resolveEdgesCalls).toBe(1);
    expect(effects.lspEnrichmentCalls).toBe(0);
    expect(effects.envIndexCalls).toBe(0);
    expect(effects.graphSnapshotCalls).toBe(0);
    expect(effects.callOrder).toEqual([RESOLVE_EDGES_TASK_NAME]);
  });

  it("skips every Task when postprocess='none' (mirrors the pipeline gating)", async () => {
    // The pipeline's runPipeline body short-circuits on postprocess='none'
    // and never enters either branch. The DAG-level analogue is "do not
    // invoke run() at all". Effects must remain zero across the board.
    const effects = freshEffects();
    createFreshDag(effects);

    expect(effects.resolveEdgesCalls).toBe(0);
    expect(effects.lspEnrichmentCalls).toBe(0);
    expect(effects.envIndexCalls).toBe(0);
    expect(effects.graphSnapshotCalls).toBe(0);
    expect(effects.callOrder).toEqual([]);
  });

  it('aborts the chain when the AbortSignal fires before a step', async () => {
    // runPipeline does not currently pass a signal, but the DAG layer
    // supports one for forward compatibility. Confirm that aborting before
    // a step keeps that step's side-effect at zero.
    const effects = freshEffects();
    const dag = createFreshDag(effects);
    const closures = buildClosures(effects);

    // First step runs normally...
    await dag.run(RESOLVE_EDGES_TASK_NAME, { runResolveAllEdges: closures.runResolveAllEdges });
    expect(effects.resolveEdgesCalls).toBe(1);

    // ...then we abort and the second step never fires.
    const ac = new AbortController();
    ac.abort(new Error('user cancelled'));
    await expect(
      dag.run(LSP_ENRICHMENT_TASK_NAME, { runLspEnrichment: closures.runLspEnrichment }, ac.signal),
    ).rejects.toThrow(/user cancelled/);
    expect(effects.lspEnrichmentCalls).toBe(0);
  });
});
