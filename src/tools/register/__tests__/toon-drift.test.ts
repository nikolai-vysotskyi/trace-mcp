/**
 * Drift guardrail: ensures every tool that accepts `output_format: "toon"` in
 * its zod schema also advertises TOON in its description string, and vice
 * versa. Catches silent drift between the schema and the user-facing prompt.
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
    projectRoot: '/tmp/fake-project',
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
    presetName: 'drift-test',
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

function acceptsToon(schema: z.ZodTypeAny | undefined): boolean {
  if (!schema) return false;
  const result = schema.safeParse('toon');
  return result.success;
}

const TOON_MARKER = 'output_format: "toon"';

describe('TOON output_format drift guardrail', () => {
  const tools = captureAllTools();

  it('captures a non-trivial number of tools from all register files', () => {
    expect(tools.length).toBeGreaterThan(50);
  });

  it('every tool with output_format=toon in schema mentions TOON in description, and vice versa', () => {
    const mismatches: Array<{ name: string; schema: boolean; desc: boolean }> = [];
    for (const tool of tools) {
      const schemaAcceptsToon = acceptsToon(tool.schemaShape.output_format);
      const descMentionsToon = tool.description.includes(TOON_MARKER);
      if (schemaAcceptsToon !== descMentionsToon) {
        mismatches.push({ name: tool.name, schema: schemaAcceptsToon, desc: descMentionsToon });
      }
    }
    if (mismatches.length > 0) {
      const lines = mismatches.map(
        (m) =>
          `  - ${m.name}: schema_accepts_toon=${m.schema}, description_mentions_toon=${m.desc}`,
      );
      throw new Error(
        `TOON drift detected — schema and description disagree on TOON support:\n${lines.join('\n')}\n\n` +
          'Fix either by:\n' +
          '  (a) Adding `output_format: OutputFormatSchema` to the schema AND appending the TOON marketing sentence to the description, OR\n' +
          '  (b) Removing both. Keep the keeper list in CLAUDE.md aligned.',
      );
    }
  });

  it('the set of TOON-enabled tools matches the documented allowlist (14 tools)', () => {
    const toonEnabled = tools
      .filter((t) => acceptsToon(t.schemaShape.output_format))
      .map((t) => t.name)
      .sort();
    const expected = [
      'analyze_perf',
      'get_changed_symbols',
      'get_complexity_report',
      'get_coupling',
      'get_dead_exports',
      'get_feature_context',
      'get_git_churn',
      'get_outline',
      'get_pagerank',
      'get_refactor_candidates',
      'get_risk_hotspots',
      'get_untested_exports',
      'query_decisions',
      'search',
    ].sort();
    expect(toonEnabled).toEqual(expected);
  });
});
