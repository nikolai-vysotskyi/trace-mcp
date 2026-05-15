/**
 * Wiring tests for `output_format: "toon"` across two TOON-keeper tools:
 *   - query_decisions (src/tools/register/memory.ts)
 *   - get_changed_symbols (src/tools/register/quality.ts)
 *
 * Each tool gets two tests:
 *   A — toon round-trip: `toon` decode equals the JSON branch payload.
 *   B — markdown normalization: `markdown` request returns valid JSON
 *       (neither tool produces markdown, so the helper falls back).
 *
 * The handlers are captured via a fake `server.tool(...)` injected into the
 * register function.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decode as toonDecode } from '@toon-format/toon';
import { z } from 'zod';
import { DecisionStore } from '../../../memory/decision-store.js';
import type { ServerContext } from '../../../server/types.js';
import { registerMemoryTools } from '../memory.js';
import { registerQualityTools } from '../quality.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../../../../tests/test-utils.js';

type Handler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface CapturedTool {
  name: string;
  description: string;
  schemaShape: Record<string, z.ZodTypeAny>;
  handler: Handler;
}

function makeCapturingServer(): {
  server: unknown;
  captured: CapturedTool[];
} {
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
    savings: { getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }) },
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

describe('query_decisions — output_format wiring', () => {
  let tool: CapturedTool;
  let tmpDir: string;
  let decisionStore: DecisionStore;

  beforeEach(() => {
    tmpDir = createTmpDir('registry-toon-decisions-');
    decisionStore = new DecisionStore(path.join(tmpDir, 'decisions.db'));
    decisionStore.addDecision({
      title: 'Use Redis for sessions',
      content: 'Adopted Redis to scale session storage.',
      type: 'architecture_decision',
      project_root: '/tmp/fake-project',
      tags: ['caching'],
      valid_from: '2024-01-01T00:00:00.000Z',
    });

    const store = createTestStore();
    const { server, captured } = makeCapturingServer();
    registerMemoryTools(
      server as Parameters<typeof registerMemoryTools>[0],
      baseCtxStub({ store, decisionStore }),
    );
    tool = findTool(captured, 'query_decisions');
  });

  afterEach(() => {
    decisionStore.close();
    removeTmpDir(tmpDir);
  });

  it('toon output round-trips losslessly to the json output', async () => {
    const jsonRes = await tool.handler({}, {});
    const toonRes = await tool.handler({ output_format: 'toon' }, {});
    const jsonPayload = JSON.parse(jsonRes.content[0].text);
    const decoded = toonDecode(toonRes.content[0].text);
    expect(decoded).toEqual(jsonPayload);
  });

  it('markdown output falls back to valid JSON', async () => {
    const res = await tool.handler({ output_format: 'markdown' }, {});
    const text = res.content[0].text;
    expect(text).toBeTruthy();
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe('get_changed_symbols — output_format wiring', () => {
  let tool: CapturedTool;
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTmpDir('registry-toon-changed-');
    const run = (cmd: string) =>
      execSync(cmd, {
        cwd: repoDir,
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
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'src/auth.ts'),
      ['export function login() {', '  return 1;', '}'].join('\n'),
    );
    run('git add -A');
    run('git commit -m "initial"');
    const baseSha = run('git rev-parse HEAD').trim();

    fs.writeFileSync(
      path.join(repoDir, 'src/auth.ts'),
      ['export function login() {', '  const user = fetchUser();', '  return user;', '}'].join(
        '\n',
      ),
    );
    run('git add -A');
    run('git commit -m "modify login"');

    const store = createTestStore();
    const fileId = store.insertFile('src/auth.ts', 'typescript', 'h1', 200);
    store.insertSymbol(fileId, {
      symbolId: 'src/auth.ts::login#function',
      name: 'login',
      kind: 'function',
      fqn: 'login',
      byteStart: 0,
      byteEnd: 80,
      lineStart: 1,
      lineEnd: 4,
    });

    const { server, captured } = makeCapturingServer();
    registerQualityTools(
      server as Parameters<typeof registerQualityTools>[0],
      baseCtxStub({ store, projectRoot: repoDir }),
    );
    tool = findTool(captured, 'get_changed_symbols');
    // Stash baseSha onto the tool for the round-trip tests.
    (tool as unknown as { __since: string }).__since = baseSha;
  });

  afterEach(() => {
    removeTmpDir(repoDir);
  });

  it('toon output round-trips losslessly to the json output', async () => {
    const since = (tool as unknown as { __since: string }).__since;
    const jsonRes = await tool.handler({ since }, {});
    const toonRes = await tool.handler({ since, output_format: 'toon' }, {});
    const jsonPayload = JSON.parse(jsonRes.content[0].text);
    const decoded = toonDecode(toonRes.content[0].text);
    expect(decoded).toEqual(jsonPayload);
  });

  it('markdown output falls back to valid JSON', async () => {
    const since = (tool as unknown as { __since: string }).__since;
    const res = await tool.handler({ since, output_format: 'markdown' }, {});
    const text = res.content[0].text;
    expect(text).toBeTruthy();
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
