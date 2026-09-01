/**
 * Shared capture harness for the tool-surface budget suites.
 *
 * Registers every tool against a stub server and returns the raw
 * `(name, description, schemaShape)` triples, so a test can reconstruct what a
 * client receives from `tools/list` without standing up a real server.
 * Extracted from tool-schema-budget.test.ts when preset-surface-budget.test.ts
 * (TRA-402) needed the same fixture.
 */
import type { z } from 'zod';
import type { MetaContext, ServerContext } from '../../../server/types.js';
import { registerAdvancedTools } from '../advanced.js';
import { registerAnalysisTools } from '../analysis.js';
import { registerCoreTools } from '../core.js';
import { registerFrameworkTools } from '../framework.js';
import { registerGitTools } from '../git.js';
import { registerKnowledgeTools } from '../knowledge.js';
import { registerMemoryTools } from '../memory.js';
import { registerNavigationTools } from '../navigation.js';
import { registerProjectsTools } from '../projects.js';
import { registerQualityTools } from '../quality.js';
import { registerRefactoringTools } from '../refactoring.js';
import { registerSessionTools } from '../session.js';
import { registerStateTools } from '../state.js';

export interface CapturedTool {
  name: string;
  description: string;
  schemaShape: Record<string, z.ZodTypeAny>;
}

export function makeCapturingServer(): { server: unknown; captured: CapturedTool[] } {
  const captured: CapturedTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schemaShape: Record<string, z.ZodTypeAny>,
      _handler: unknown,
    ) => {
      captured.push({ name, description, schemaShape });
    },
    resource: () => undefined,
    prompt: () => undefined,
  };
  return { server, captured };
}

export function baseCtx(overrides: Record<string, unknown> = {}): ServerContext {
  const stub = {
    projectRoot: '/nonexistent/fake-project',
    config: {},
    registry: { getAllFrameworkPlugins: () => [] },
    embeddingService: null,
    vectorStore: null,
    reranker: null,
    rankingLedger: null,
    decisionStore: {},
    telemetrySink: null,
    topoStore: null,
    progress: null,
    aiProvider: null,
    journal: null,
    savings: {
      getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }),
      getLatencyPerTool: () => ({}) as Record<string, unknown>,
    },
    has: () => false,
    guardPath: () => null,
    j: (v: unknown) => JSON.stringify(v),
    jh: (_tool: string, v: unknown) => JSON.stringify(v),
    markExplored: () => undefined,
    onPipelineEvent: () => undefined,
    ...overrides,
  };
  return stub as unknown as ServerContext;
}

export function metaCtx(
  overrides: Record<string, unknown> = {},
  captured?: CapturedTool[],
): MetaContext {
  const base = baseCtx(overrides) as unknown as Record<string, unknown>;
  const meta = {
    ...base,
    // Meta-tools bypass the gate via `_originalTool`, so a stub that swallows
    // them hides ~9 tools (including load_tools) from every budget that uses
    // this harness. Capture them like any other registration.
    _originalTool: (
      name: string,
      description: string,
      schemaShape: Record<string, z.ZodTypeAny>,
    ) => {
      captured?.push({ name, description, schemaShape });
    },
    registeredToolNames: [] as string[],
    toolHandlers: new Map<string, unknown>(),
    deferredTools: new Map<string, unknown>(),
    presetName: 'schema-budget-test',
  };
  return meta as unknown as MetaContext;
}

export function captureAllTools(ctxOverrides: Record<string, unknown> = {}): CapturedTool[] {
  const { server, captured } = makeCapturingServer();
  const ctx = baseCtx(ctxOverrides);
  const mctx = metaCtx(ctxOverrides, captured);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = server as any;
  registerCoreTools(s, ctx);
  registerNavigationTools(s, ctx);
  registerAdvancedTools(s, ctx);
  registerProjectsTools(s, ctx);
  registerFrameworkTools(s, ctx);
  registerAnalysisTools(s, ctx);
  registerQualityTools(s, ctx);
  registerGitTools(s, ctx);
  registerMemoryTools(s, ctx);
  registerRefactoringTools(s, ctx);
  registerKnowledgeTools(s, ctx);
  registerSessionTools(s, mctx);
  registerStateTools(s, ctx);
  return captured;
}
