/**
 * Regression guard for MCP tool-schema token tax (TRA-186): every tool
 * description the server advertises is paid in full by any MCP client
 * without deferred/lazy tool loading, on every session. Caps total
 * description size and flags any single tool ballooning past a sane budget,
 * so the "170+ tools = ~50k tokens before the agent does anything" problem
 * doesn't silently regrow.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { MetaContext, ServerContext } from '../../../server/types.js';
import { registerAdvancedTools } from '../advanced.js';
import { registerAnalysisTools } from '../analysis.js';
import { registerCoreTools } from '../core.js';
import { registerFrameworkTools } from '../framework.js';
import { registerGitTools } from '../git.js';
import { registerKnowledgeTools } from '../knowledge.js';
import { registerMemoryTools } from '../memory.js';
import { registerNavigationTools } from '../navigation.js';
import { registerQualityTools } from '../quality.js';
import { registerRefactoringTools } from '../refactoring.js';
import { registerRetrievalTools } from '../retrieval.js';
import { registerSessionTools } from '../session.js';

interface CapturedTool {
  name: string;
  description: string;
  schemaShape: Record<string, z.ZodTypeAny>;
}

function makeCapturingServer(): { server: unknown; captured: CapturedTool[] } {
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

function baseCtx(overrides: Record<string, unknown> = {}): ServerContext {
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

function metaCtx(overrides: Record<string, unknown> = {}): MetaContext {
  const base = baseCtx(overrides) as unknown as Record<string, unknown>;
  const meta = {
    ...base,
    _originalTool: () => undefined,
    registeredToolNames: [] as string[],
    toolHandlers: new Map<string, unknown>(),
    presetName: 'schema-budget-test',
  };
  return meta as unknown as MetaContext;
}

function captureAllTools(): CapturedTool[] {
  const { server, captured } = makeCapturingServer();
  const ctx = baseCtx();
  const mctx = metaCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = server as any;
  registerCoreTools(s, ctx);
  registerNavigationTools(s, ctx);
  registerAdvancedTools(s, ctx);
  registerFrameworkTools(s, ctx);
  registerAnalysisTools(s, ctx);
  registerQualityTools(s, ctx);
  registerGitTools(s, ctx);
  registerMemoryTools(s, ctx);
  registerRefactoringTools(s, ctx);
  registerKnowledgeTools(s, ctx);
  registerRetrievalTools(s, ctx);
  registerSessionTools(s, mctx);
  return captured;
}

// Baseline measured 2026-08-27 (TRA-186): 184 tools, ~67.6k description
// chars after the first trim pass (down from ~74k). Ceiling leaves modest
// headroom for legitimate new tools/params without allowing bloat to creep
// back toward the pre-fix baseline.
const TOTAL_DESCRIPTION_CHAR_BUDGET = 72_000;
// No single tool description should need more prose than this to be usable
// — if a tool grows past it, the fix is almost always "move detail into the
// per-param describe() or the response docs", not a longer top-level string.
const PER_TOOL_DESCRIPTION_CHAR_CEILING = 800;

describe('MCP tool-schema token budget guardrail (TRA-186)', () => {
  const tools = captureAllTools();

  it('captures a non-trivial number of tools from all register files', () => {
    expect(tools.length).toBeGreaterThan(50);
  });

  it('keeps total tool description size under budget', () => {
    const total = tools.reduce((sum, t) => sum + t.description.length, 0);
    expect(
      total,
      `Total tool description chars (${total}) exceeds the budget (${TOTAL_DESCRIPTION_CHAR_BUDGET}). ` +
        'This text is paid in full by every MCP client without deferred tool loading, on every session ' +
        '(see TRA-186). Trim descriptions before raising this budget.',
    ).toBeLessThanOrEqual(TOTAL_DESCRIPTION_CHAR_BUDGET);
  });

  it('flags any single tool description that has ballooned past the per-tool ceiling', () => {
    const offenders = tools
      .filter((t) => t.description.length > PER_TOOL_DESCRIPTION_CHAR_CEILING)
      .map((t) => `  - ${t.name}: ${t.description.length} chars`);
    expect(
      offenders.length,
      `Tool description(s) exceed ${PER_TOOL_DESCRIPTION_CHAR_CEILING} chars:\n${offenders.join('\n')}\n` +
        'Move detail into per-param describe() text or the docs site instead of the top-level description.',
    ).toBe(0);
  });
});
