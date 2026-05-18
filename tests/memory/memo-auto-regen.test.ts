/**
 * Auto-regen memo trigger tests.
 *
 * Each write that lands in the active decision store schedules a
 * fire-and-forget memo regeneration on `setImmediate` when:
 *   - `memory.memo.enabled !== false`
 *   - `memory.memo.autoRegenerate !== false`
 *   - an AI provider is wired in
 *   - the per-scope throttle (`minTriggerIntervalSec`) has elapsed
 *   - `countDecisionsSinceLastMemo >= regenerateEveryN`
 *
 * Tests use `vi.useFakeTimers()` for throttle determinism and
 * `vi.advanceTimersByTimeAsync` to let queued `setImmediate` callbacks
 * actually run inside the test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceService } from '../../src/ai/interfaces.js';
import { DecisionStore } from '../../src/memory/decision-store.js';
import type { ServerContext } from '../../src/server/types.js';
import {
  _resetMemoAutoTriggerStateForTests,
  registerMemoryTools,
} from '../../src/tools/register/memory.js';

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

const SAMPLE_MEMO = `## Architecture

We layer JWT auth on top of Redis sessions. Migration runs through versioned database scripts.

## Tech stack

PostgreSQL with JSONB. Redis for hot session state.

## Conventions

Tests on every PR.

## In progress

Refresh-token rollout.`;

function buildCtx(opts: {
  store: DecisionStore;
  projectRoot: string;
  inferenceMock: ReturnType<typeof vi.fn> | null;
  regenerateEveryN?: number;
  minTriggerIntervalSec?: number;
  autoRegenerate?: boolean;
  memoEnabled?: boolean;
}): ServerContext {
  const aiProvider = opts.inferenceMock
    ? {
        isAvailable: vi.fn(async () => true),
        inference: () => ({ generate: opts.inferenceMock }) as unknown as InferenceService,
      }
    : null;
  return {
    projectRoot: opts.projectRoot,
    decisionStore: opts.store,
    topoStore: null,
    config: {
      memory: {
        recall: { timeoutMs: 5000 },
        memo: {
          enabled: opts.memoEnabled ?? true,
          regenerateEveryN: opts.regenerateEveryN ?? 1,
          targetTokens: 350,
          autoRegenerate: opts.autoRegenerate ?? true,
          minTriggerIntervalSec: opts.minTriggerIntervalSec ?? 600,
        },
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

describe('memo auto-regen on qualifying writes', () => {
  let store: DecisionStore;
  let dbPath: string;
  let tmpDir: string;
  const projectRoot = '/projects/memo-auto-regen';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-auto-regen-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
    _resetMemoAutoTriggerStateForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetMemoAutoTriggerStateForTests();
  });

  /** Drain the `setImmediate` queue and any racing setTimeout(0). */
  async function flushImmediate(): Promise<void> {
    // setImmediate is bridged to vi.fake timer queue. Advance by 1ms.
    await vi.advanceTimersByTimeAsync(1);
  }

  it('threshold not crossed → no regen call', async () => {
    const generate = vi.fn(async () => SAMPLE_MEMO);
    const { server, tools } = buildFakeServer();
    // regenerateEveryN=50, only 1 write — under threshold.
    registerMemoryTools(
      server as never,
      buildCtx({ store, projectRoot, inferenceMock: generate, regenerateEveryN: 50 }),
    );
    await tools.get('add_decision')!.handler({
      title: 'Use Redis sessions',
      content: 'Store user sessions in Redis with TTL — short-lived, refresh on access.',
      type: 'architecture_decision',
    });
    await flushImmediate();
    expect(generate).not.toHaveBeenCalled();
    expect(store.getLatestProjectMemo({ project_root: projectRoot })).toBeUndefined();
  });

  it('threshold crossed by a remember_decision write → exactly one regen call', async () => {
    const generate = vi.fn(async () => SAMPLE_MEMO);
    const { server, tools } = buildFakeServer();
    registerMemoryTools(
      server as never,
      buildCtx({ store, projectRoot, inferenceMock: generate, regenerateEveryN: 1 }),
    );
    const res = await tools.get('remember_decision')!.handler({
      title: 'Use JWT for auth',
      content:
        'Short-lived JWTs (15min) with refresh tokens stored in Redis. Provides a clean ' +
        'logout story and lets us revoke without a global session table.',
      type: 'architecture_decision',
      file_path: 'src/auth/jwt.ts',
      tags: ['auth', 'security'],
    });
    const body = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(body.review_status).toBe('approved');
    await flushImmediate();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.getLatestProjectMemo({ project_root: projectRoot })).toBeDefined();
  });

  it('second write within throttle window → still exactly one regen call', async () => {
    const generate = vi.fn(async () => SAMPLE_MEMO);
    const { server, tools } = buildFakeServer();
    registerMemoryTools(
      server as never,
      buildCtx({
        store,
        projectRoot,
        inferenceMock: generate,
        regenerateEveryN: 1,
        minTriggerIntervalSec: 600,
      }),
    );

    await tools.get('add_decision')!.handler({
      title: 'JWT auth',
      content: 'Short-lived JWTs with Redis-backed refresh tokens.',
      type: 'architecture_decision',
      file_path: 'src/auth/jwt.ts',
    });
    await flushImmediate();
    expect(generate).toHaveBeenCalledTimes(1);

    // Within throttle window — second write must NOT trigger another regen.
    await vi.advanceTimersByTimeAsync(60_000); // 60s, well under 600s throttle
    await tools.get('add_decision')!.handler({
      title: 'Redis sessions',
      content: 'Store user sessions in Redis with TTL.',
      type: 'architecture_decision',
      file_path: 'src/auth/sessions.ts',
    });
    await flushImmediate();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('second write after throttle expires → second regen call fires', async () => {
    const generate = vi.fn(async () => SAMPLE_MEMO);
    const { server, tools } = buildFakeServer();
    registerMemoryTools(
      server as never,
      buildCtx({
        store,
        projectRoot,
        inferenceMock: generate,
        regenerateEveryN: 1,
        minTriggerIntervalSec: 60, // tight window so the test runs fast
      }),
    );

    await tools.get('add_decision')!.handler({
      title: 'JWT auth',
      content: 'Short-lived JWTs with Redis-backed refresh tokens.',
      type: 'architecture_decision',
      file_path: 'src/auth/jwt.ts',
    });
    await flushImmediate();
    expect(generate).toHaveBeenCalledTimes(1);

    // Advance past the throttle window.
    await vi.advanceTimersByTimeAsync(61_000);

    await tools.get('add_decision')!.handler({
      title: 'Redis sessions',
      content: 'Store user sessions in Redis with TTL.',
      type: 'architecture_decision',
      file_path: 'src/auth/sessions.ts',
    });
    await flushImmediate();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('autoRegenerate=false → never fires', async () => {
    const generate = vi.fn(async () => SAMPLE_MEMO);
    const { server, tools } = buildFakeServer();
    registerMemoryTools(
      server as never,
      buildCtx({
        store,
        projectRoot,
        inferenceMock: generate,
        regenerateEveryN: 1,
        autoRegenerate: false,
      }),
    );
    await tools.get('add_decision')!.handler({
      title: 'JWT auth',
      content: 'JWTs with refresh.',
      type: 'architecture_decision',
      file_path: 'src/auth/jwt.ts',
    });
    await flushImmediate();
    expect(generate).not.toHaveBeenCalled();
  });

  it('memory.memo.enabled=false → never fires', async () => {
    const generate = vi.fn(async () => SAMPLE_MEMO);
    const { server, tools } = buildFakeServer();
    registerMemoryTools(
      server as never,
      buildCtx({
        store,
        projectRoot,
        inferenceMock: generate,
        regenerateEveryN: 1,
        memoEnabled: false,
      }),
    );
    await tools.get('add_decision')!.handler({
      title: 'JWT auth',
      content: 'JWTs with refresh.',
      type: 'architecture_decision',
      file_path: 'src/auth/jwt.ts',
    });
    await flushImmediate();
    expect(generate).not.toHaveBeenCalled();
  });

  it('no aiProvider injected → never fires', async () => {
    const { server, tools } = buildFakeServer();
    registerMemoryTools(
      server as never,
      buildCtx({ store, projectRoot, inferenceMock: null, regenerateEveryN: 1 }),
    );
    await tools.get('add_decision')!.handler({
      title: 'JWT auth',
      content: 'JWTs with refresh.',
      type: 'architecture_decision',
      file_path: 'src/auth/jwt.ts',
    });
    await flushImmediate();
    // No provider, no memo persisted.
    expect(store.getLatestProjectMemo({ project_root: projectRoot })).toBeUndefined();
  });

  it('approve_decision transition to approved triggers regen', async () => {
    const generate = vi.fn(async () => SAMPLE_MEMO);
    const { server, tools } = buildFakeServer();
    registerMemoryTools(
      server as never,
      buildCtx({ store, projectRoot, inferenceMock: generate, regenerateEveryN: 1 }),
    );
    // Seed a pending row directly via the store.
    const pending = store.addDecision({
      title: 'Use GraphQL gateway',
      content: 'Federate microservices through a single GraphQL gateway.',
      type: 'architecture_decision',
      project_root: projectRoot,
      review_status: 'pending',
    });
    // approve_decision should bump the trigger.
    await tools.get('approve_decision')!.handler({ id: pending.id });
    await flushImmediate();
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
