/**
 * TRA-206 — `get_wake_up`'s `scope: "resume"` / `"project"` must dispatch
 * to the exact same implementations the retired `get_session_resume` /
 * `get_project_memo` aliases used (TRA-240)
 * use, and both of those tools (permanent aliases) must stay unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';
import type { ServerContext } from '../../src/server/types.js';
import { registerMemoryTools } from '../../src/tools/register/memory.js';
import { registerSessionTools } from '../../src/tools/register/session.js';
import type { MetaContext } from '../../src/server/types.js';

interface CapturedTool {
  handler: (params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function buildFakeServer(): { server: unknown; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: unknown) => {
      tools.set(name, { handler: handler as CapturedTool['handler'] });
    },
    resource: () => undefined,
    prompt: () => undefined,
  };
  return { server, tools };
}

function parseText(res: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(res.content[0].text);
}

describe('get_wake_up { scope } param (TRA-206)', () => {
  let store: DecisionStore;
  let dbPath: string;
  let projectRoot: string;
  let tools: Map<string, CapturedTool>;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-up-scope-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
    projectRoot = `/tmp/wake-up-scope-project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const ctx = {
      projectRoot,
      decisionStore: store,
      topoStore: null,
      config: { memory: { recall: { timeoutMs: 5000 } } } as unknown as ServerContext['config'],
      aiProvider: null,
      j: (v: unknown) => JSON.stringify(v),
      jh: (_tool: string, v: unknown) => JSON.stringify(v),
      store: {} as ServerContext['store'],
      registry: {} as ServerContext['registry'],
      savings: {} as ServerContext['savings'],
      journal: {} as ServerContext['journal'],
      vectorStore: null,
      embeddingService: null,
      reranker: null,
      has: () => false,
      guardPath: () => null,
      markExplored: () => undefined,
      progress: null,
      telemetrySink: null,
      rankingLedger: null,
      onPipelineEvent: () => undefined,
    } as ServerContext;

    const { server, tools: capturedTools } = buildFakeServer();
    registerMemoryTools(server as never, ctx);
    registerSessionTools(
      server as never,
      {
        ...ctx,
        _originalTool: () => undefined,
        registeredToolNames: [],
        toolHandlers: new Map(),
        presetName: 'wake-up-scope-test',
      } as unknown as MetaContext,
    );
    tools = capturedTools;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('get_wake_up{scope: "resume"} emits the retired get_session_resume shape', async () => {
    const result = parseText(
      await tools.get('get_wake_up')!.handler({ scope: 'resume' }),
    ) as Record<string, unknown>;
    expect(result).toHaveProperty('sessions_available');
    expect(result).toHaveProperty('recent_sessions');
  });

  it('get_wake_up{scope: "project"} emits the retired get_project_memo shape', async () => {
    const result = parseText(
      await tools.get('get_wake_up')!.handler({ scope: 'project' }),
    ) as Record<string, unknown>;
    expect(result).toHaveProperty('memo');
  });

  it('the retired get_session_resume / get_project_memo aliases are gone (TRA-240)', () => {
    expect(tools.get('get_session_resume')).toBeUndefined();
    expect(tools.get('get_project_memo')).toBeUndefined();
  });
});
