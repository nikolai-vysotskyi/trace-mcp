/**
 * Wave-2 wiring tests for `output_format: "toon"` across 9 high-value tools.
 *
 * Per tool, two tests are exercised:
 *   A — toon round-trip: decoded TOON deep-equals the JSON branch payload.
 *   B — markdown normalization: `markdown` falls back to valid JSON.
 *
 * Tools covered:
 *   analysis.ts  — get_pagerank, get_coupling, get_refactor_candidates,
 *                  get_dead_exports, get_untested_exports
 *   git.ts       — get_risk_hotspots, get_complexity_report, get_git_churn
 *   session.ts   — analyze_perf
 *
 * Handlers are captured via a fake `server.tool(...)` injected into the
 * register function. No MCP runtime, no LSP, no AI provider needed.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decode as toonDecode } from '@toon-format/toon';
import { z } from 'zod';
import type { MetaContext, ServerContext } from '../../../server/types.js';
import { registerAnalysisTools } from '../analysis.js';
import { registerGitTools } from '../git.js';
import { registerSessionTools } from '../session.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../../../../tests/test-utils.js';

type Handler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

interface CapturedTool {
  name: string;
  description: string;
  schemaShape: Record<string, z.ZodTypeAny>;
  handler: Handler;
}

function makeCapturingServer(): { server: unknown; captured: CapturedTool[] } {
  const captured: CapturedTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schemaShape: Record<string, z.ZodTypeAny>,
      handler: Handler,
    ) => {
      captured.push({ name, description, schemaShape, handler });
    },
    resource: (..._args: unknown[]) => undefined,
    prompt: (..._args: unknown[]) => undefined,
  };
  return { server, captured };
}

function findTool(captured: CapturedTool[], name: string): CapturedTool {
  const tool = captured.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} was not registered`);
  return tool;
}

function baseCtxStub(overrides: Record<string, unknown>): ServerContext {
  const stub = {
    projectRoot: '/tmp/fake-project',
    config: {},
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
    savings: {
      getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }),
      getLatencyPerTool: () => ({}),
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

function metaCtxStub(overrides: Record<string, unknown>): MetaContext {
  const base = baseCtxStub(overrides) as unknown as Record<string, unknown>;
  const meta = {
    ...base,
    _originalTool: () => undefined,
    registeredToolNames: [] as string[],
    toolHandlers: new Map<string, unknown>(),
    presetName: 'wave2-test',
  };
  return meta as unknown as MetaContext;
}

/**
 * Recursive loose-equality with float tolerance. TOON's number encoder can
 * round high-precision floats (PageRank, churn frequency, p95 latency etc.)
 * within ~7-8 significant digits. Strings/booleans/null must be exactly equal.
 */
function looselyEqual(a: unknown, b: unknown, tol = 1e-6): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
    const diff = Math.abs(a - b);
    const mag = Math.max(1, Math.abs(a), Math.abs(b));
    return diff / mag < tol;
  }
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!looselyEqual(a[i], b[i], tol)) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (
        !looselyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol)
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Seed a store with a small graph that produces non-empty rows for every
 * tool under test: 3 files, 4 symbols, imports + calls, complexity.
 */
function seedRichStore(store: ReturnType<typeof createTestStore>): void {
  const authFile = store.insertFile('src/services/auth.ts', 'typescript', 'h1', 500);
  const userFile = store.insertFile('src/services/user.ts', 'typescript', 'h2', 400);
  const utilFile = store.insertFile('src/utils/format.ts', 'typescript', 'h3', 300);

  store.insertSymbol(authFile, {
    symbolId: 'src/services/auth.ts::AuthService#class',
    name: 'AuthService',
    kind: 'class',
    fqn: 'AuthService',
    byteStart: 0,
    byteEnd: 200,
    lineStart: 1,
    lineEnd: 30,
    signature: 'class AuthService',
    metadata: { cyclomatic: 8, max_nesting: 3, param_count: 2, isExported: true },
  });
  store.insertSymbol(authFile, {
    symbolId: 'src/services/auth.ts::login#method',
    name: 'login',
    kind: 'method',
    fqn: 'AuthService.login',
    byteStart: 210,
    byteEnd: 350,
    lineStart: 32,
    lineEnd: 50,
    signature: 'login(email: string)',
    metadata: { cyclomatic: 12, max_nesting: 4, param_count: 1 },
  });
  store.insertSymbol(userFile, {
    symbolId: 'src/services/user.ts::UserService#class',
    name: 'UserService',
    kind: 'class',
    fqn: 'UserService',
    byteStart: 0,
    byteEnd: 180,
    lineStart: 1,
    lineEnd: 25,
    signature: 'class UserService',
    metadata: { cyclomatic: 6, max_nesting: 2, param_count: 1, isExported: true },
  });
  store.insertSymbol(utilFile, {
    symbolId: 'src/utils/format.ts::formatCurrency#function',
    name: 'formatCurrency',
    kind: 'function',
    fqn: 'formatCurrency',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 10,
    signature: 'function formatCurrency(n: number)',
    metadata: { cyclomatic: 3, max_nesting: 1, param_count: 1, isExported: true },
  });

  // Insert a couple of call edges (symbol → symbol) so PageRank/coupling/
  // refactor-candidates produce non-trivial rows when possible.
  const ids = [
    'src/services/auth.ts::login#method',
    'src/services/user.ts::UserService#class',
    'src/utils/format.ts::formatCurrency#function',
  ];
  const nodeIdFor = (symbolId: string): number | null => {
    const sym = store.getSymbolBySymbolId(symbolId);
    if (!sym) return null;
    return store.getNodeId('symbol', sym.id) ?? null;
  };
  const loginNode = nodeIdFor(ids[0]);
  const userNode = nodeIdFor(ids[1]);
  const fmtNode = nodeIdFor(ids[2]);
  if (loginNode && userNode) store.insertEdge(loginNode, userNode, 'calls');
  if (loginNode && fmtNode) store.insertEdge(loginNode, fmtNode, 'calls');
  if (userNode && fmtNode) store.insertEdge(userNode, fmtNode, 'calls');
}

function makeGitFixtureRepo(): { dir: string; baseSha: string } {
  const dir = createTmpDir('wave2-toon-git-');
  const run = (cmd: string) =>
    execSync(cmd, {
      cwd: dir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });
  run('git init -b main');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'src/b.ts'), 'export const b = 2;\n');
  run('git add -A');
  run('git commit -m "initial"');
  const baseSha = run('git rev-parse HEAD').trim();
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\nexport const x = 9;\n');
  run('git add -A');
  run('git commit -m "extend a"');
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 2;\nexport const x = 9;\n');
  run('git add -A');
  run('git commit -m "bump a"');
  return { dir, baseSha };
}

// ─── analysis.ts tools ────────────────────────────────────────────────────────

describe('wave2 toon — analysis.ts tools', () => {
  let captured: CapturedTool[];
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    seedRichStore(store);
    const { server, captured: cap } = makeCapturingServer();
    registerAnalysisTools(
      server as Parameters<typeof registerAnalysisTools>[0],
      baseCtxStub({ store }),
    );
    captured = cap;
  });

  describe('get_pagerank', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const tool = findTool(captured, 'get_pagerank');
      const jsonRes = await tool.handler({ limit: 10 }, {});
      const toonRes = await tool.handler({ limit: 10, output_format: 'toon' }, {});
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      const decoded = toonDecode(toonRes.content[0].text);
      expect(looselyEqual(decoded, jsonPayload)).toBe(true);
    });
    it('markdown output falls back to valid JSON', async () => {
      const tool = findTool(captured, 'get_pagerank');
      const res = await tool.handler({ limit: 10, output_format: 'markdown' }, {});
      expect(res.content[0].text).toBeTruthy();
      expect(() => JSON.parse(res.content[0].text)).not.toThrow();
    });
  });

  describe('get_coupling', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const tool = findTool(captured, 'get_coupling');
      const jsonRes = await tool.handler({ limit: 10 }, {});
      const toonRes = await tool.handler({ limit: 10, output_format: 'toon' }, {});
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      const decoded = toonDecode(toonRes.content[0].text);
      expect(looselyEqual(decoded, jsonPayload)).toBe(true);
    });
    it('markdown output falls back to valid JSON', async () => {
      const tool = findTool(captured, 'get_coupling');
      const res = await tool.handler({ limit: 10, output_format: 'markdown' }, {});
      expect(res.content[0].text).toBeTruthy();
      expect(() => JSON.parse(res.content[0].text)).not.toThrow();
    });
  });

  describe('get_refactor_candidates', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const tool = findTool(captured, 'get_refactor_candidates');
      const args = { min_cyclomatic: 1, min_callers: 1, limit: 10 };
      const jsonRes = await tool.handler(args, {});
      const toonRes = await tool.handler({ ...args, output_format: 'toon' }, {});
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      const decoded = toonDecode(toonRes.content[0].text);
      expect(looselyEqual(decoded, jsonPayload)).toBe(true);
    });
    it('markdown output falls back to valid JSON', async () => {
      const tool = findTool(captured, 'get_refactor_candidates');
      const res = await tool.handler(
        { min_cyclomatic: 1, min_callers: 1, limit: 10, output_format: 'markdown' },
        {},
      );
      expect(res.content[0].text).toBeTruthy();
      expect(() => JSON.parse(res.content[0].text)).not.toThrow();
    });
  });

  describe('get_dead_exports', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const tool = findTool(captured, 'get_dead_exports');
      const jsonRes = await tool.handler({}, {});
      const toonRes = await tool.handler({ output_format: 'toon' }, {});
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      const decoded = toonDecode(toonRes.content[0].text);
      expect(looselyEqual(decoded, jsonPayload)).toBe(true);
    });
    it('markdown output falls back to valid JSON', async () => {
      const tool = findTool(captured, 'get_dead_exports');
      const res = await tool.handler({ output_format: 'markdown' }, {});
      expect(res.content[0].text).toBeTruthy();
      expect(() => JSON.parse(res.content[0].text)).not.toThrow();
    });
  });

  describe('get_untested_exports', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const tool = findTool(captured, 'get_untested_exports');
      const jsonRes = await tool.handler({}, {});
      const toonRes = await tool.handler({ output_format: 'toon' }, {});
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      const decoded = toonDecode(toonRes.content[0].text);
      expect(looselyEqual(decoded, jsonPayload)).toBe(true);
    });
    it('markdown output falls back to valid JSON', async () => {
      const tool = findTool(captured, 'get_untested_exports');
      const res = await tool.handler({ output_format: 'markdown' }, {});
      expect(res.content[0].text).toBeTruthy();
      expect(() => JSON.parse(res.content[0].text)).not.toThrow();
    });
  });
});

// ─── git.ts tools ────────────────────────────────────────────────────────────

describe('wave2 toon — git.ts tools', () => {
  let captured: CapturedTool[];
  let store: ReturnType<typeof createTestStore>;
  let repoDir: string;

  beforeEach(() => {
    const fixture = makeGitFixtureRepo();
    repoDir = fixture.dir;
    store = createTestStore();
    seedRichStore(store);
    const { server, captured: cap } = makeCapturingServer();
    registerGitTools(
      server as Parameters<typeof registerGitTools>[0],
      baseCtxStub({ store, projectRoot: repoDir }),
    );
    captured = cap;
  });

  afterEach(() => {
    removeTmpDir(repoDir);
  });

  describe('get_risk_hotspots', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const tool = findTool(captured, 'get_risk_hotspots');
      const args = { limit: 10, min_cyclomatic: 1, since_days: 180 };
      const jsonRes = await tool.handler(args, {});
      const toonRes = await tool.handler({ ...args, output_format: 'toon' }, {});
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      const decoded = toonDecode(toonRes.content[0].text);
      expect(looselyEqual(decoded, jsonPayload)).toBe(true);
    });
    it('markdown output falls back to valid JSON', async () => {
      const tool = findTool(captured, 'get_risk_hotspots');
      const res = await tool.handler(
        { limit: 10, min_cyclomatic: 1, since_days: 180, output_format: 'markdown' },
        {},
      );
      expect(res.content[0].text).toBeTruthy();
      expect(() => JSON.parse(res.content[0].text)).not.toThrow();
    });
  });

  describe('get_complexity_report', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const tool = findTool(captured, 'get_complexity_report');
      const args = { min_cyclomatic: 1, limit: 30 };
      const jsonRes = await tool.handler(args, {});
      const toonRes = await tool.handler({ ...args, output_format: 'toon' }, {});
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      const decoded = toonDecode(toonRes.content[0].text);
      expect(looselyEqual(decoded, jsonPayload)).toBe(true);
    });
    it('markdown output falls back to valid JSON', async () => {
      const tool = findTool(captured, 'get_complexity_report');
      const res = await tool.handler(
        { min_cyclomatic: 1, limit: 30, output_format: 'markdown' },
        {},
      );
      expect(res.content[0].text).toBeTruthy();
      expect(() => JSON.parse(res.content[0].text)).not.toThrow();
    });
  });

  describe('get_git_churn', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const tool = findTool(captured, 'get_git_churn');
      const args = { limit: 50, since_days: 180 };
      const jsonRes = await tool.handler(args, {});
      const toonRes = await tool.handler({ ...args, output_format: 'toon' }, {});
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      const decoded = toonDecode(toonRes.content[0].text);
      expect(looselyEqual(decoded, jsonPayload)).toBe(true);
    });
    it('markdown output falls back to valid JSON', async () => {
      const tool = findTool(captured, 'get_git_churn');
      const res = await tool.handler({ limit: 50, since_days: 180, output_format: 'markdown' }, {});
      expect(res.content[0].text).toBeTruthy();
      expect(() => JSON.parse(res.content[0].text)).not.toThrow();
    });
  });
});

// ─── session.ts tools ────────────────────────────────────────────────────────

describe('wave2 toon — session.ts tools', () => {
  let captured: CapturedTool[];
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    seedRichStore(store);
    const seededStats: Record<
      string,
      { p50: number; p95: number; max: number; count: number; errors: number; error_rate: number }
    > = {};
    const toolNames = [
      'search',
      'get_outline',
      'get_symbol',
      'find_usages',
      'get_call_graph',
      'get_change_impact',
      'query_decisions',
      'get_feature_context',
      'get_artifacts',
      'get_tests_for',
      'get_dead_code',
      'predict_bugs',
      'analyze_perf',
      'list_pins',
      'get_pagerank',
    ];
    for (let i = 0; i < toolNames.length; i++) {
      seededStats[toolNames[i]] = {
        p50: 5 + i * 2,
        p95: 12 + i * 4,
        max: 40 + i * 7,
        count: 100 - i * 3,
        errors: i % 4,
        error_rate: Math.round(((i % 4) / Math.max(1, 100 - i * 3)) * 1000) / 1000,
      };
    }
    const { server, captured: cap } = makeCapturingServer();
    registerSessionTools(
      server as Parameters<typeof registerSessionTools>[0],
      metaCtxStub({
        store,
        savings: {
          getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }),
          getLatencyPerTool: () => seededStats,
        },
      }),
    );
    captured = cap;
  });

  describe('analyze_perf', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const tool = findTool(captured, 'analyze_perf');
      const jsonRes = await tool.handler({ top: 30 }, {});
      const toonRes = await tool.handler({ top: 30, output_format: 'toon' }, {});
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      const decoded = toonDecode(toonRes.content[0].text);
      expect(looselyEqual(decoded, jsonPayload)).toBe(true);
    });
    it('markdown output falls back to valid JSON', async () => {
      const tool = findTool(captured, 'analyze_perf');
      const res = await tool.handler({ top: 30, output_format: 'markdown' }, {});
      expect(res.content[0].text).toBeTruthy();
      expect(() => JSON.parse(res.content[0].text)).not.toThrow();
    });
  });
});
