/**
 * Dedicated coverage for the `get_decision` tool (Task 12 companion to
 * progressive disclosure) beyond the single happy-path + single error-path
 * case in decision-progressive-disclosure.test.ts:
 *   - error shape is stable across several non-existent ids (not just one)
 *   - `verify` composes correctly: a stale (deleted-symbol) decision comes
 *     back flagged; a fresh one does not carry the annotation at all
 *   - `verify: false` explicitly skips verification even for a stale symbol
 *   - a bare decision (no symbol_id) never touches the verifier
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Store } from '../../../db/store.js';
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
    projectRoot: '/tmp/fake-project-get-decision',
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

describe('get_decision tool', () => {
  let tmpDir: string;
  let decisionStore: DecisionStore;
  let codeStore: Store;
  let captured: CapturedTool[];
  const projectRoot = '/tmp/fake-project-get-decision';

  beforeEach(() => {
    tmpDir = createTmpDir('get-decision-tool-');
    decisionStore = new DecisionStore(path.join(tmpDir, 'decisions.db'));
    codeStore = createTestStore();

    const { server, captured: cap } = makeCapturingServer();
    registerMemoryTools(
      server as Parameters<typeof registerMemoryTools>[0],
      ctxStub({
        store: codeStore,
        decisionStore,
      }),
    );
    captured = cap;
  });

  afterEach(() => {
    decisionStore.close();
    codeStore.db.close();
    removeTmpDir(tmpDir);
  });

  it('returns a clean structured error (not a crash) for a non-existent id, across several ids', async () => {
    const tool = findTool(captured, 'get_decision');
    for (const id of [1, 42, 999_999]) {
      const res = await tool.handler({ id });
      expect(res.isError).toBe(true);
      const payload = JSON.parse(res.content[0].text);
      expect(payload).toHaveProperty('error');
      expect(typeof payload.error).toBe('string');
      expect(payload.error).toContain(String(id));
      // Must not carry a `decision` key on the error path.
      expect(payload).not.toHaveProperty('decision');
    }
  });

  it('flags a decision as stale when its linked symbol no longer resolves', async () => {
    // NOTE: deliberately do NOT seed the symbol into codeStore — it must not
    // resolve, forcing verification to report symbol_missing.
    const row = decisionStore.addDecision({
      title: 'Uses a since-deleted helper',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      symbol_id: 'src/gone.ts::deletedHelper#function',
      file_path: 'src/gone.ts',
    });

    const tool = findTool(captured, 'get_decision');
    const res = await tool.handler({ id: row.id });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.decision.id).toBe(row.id);
    expect(payload.decision.content).toBe('c'); // full content still present
    expect(payload.decision.verification).toBe('symbol_missing');
    expect(payload.decision.stale).toBe(true);
  });

  it('does not carry verification/stale fields at all for a fresh decision', async () => {
    const row = decisionStore.addDecision({
      title: 'Bare decision, no code anchor',
      content: 'c',
      type: 'preference',
      project_root: projectRoot,
    });
    const tool = findTool(captured, 'get_decision');
    const res = await tool.handler({ id: row.id });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.decision).not.toHaveProperty('verification');
    expect(payload.decision).not.toHaveProperty('stale');
  });

  it('verify:false skips verification even when the symbol is missing', async () => {
    const row = decisionStore.addDecision({
      title: 'Uses a since-deleted helper',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      symbol_id: 'src/gone2.ts::deletedHelper2#function',
      file_path: 'src/gone2.ts',
    });
    const tool = findTool(captured, 'get_decision');
    const res = await tool.handler({ id: row.id, verify: false });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.decision).not.toHaveProperty('verification');
    expect(payload.decision).not.toHaveProperty('stale');
  });
});
