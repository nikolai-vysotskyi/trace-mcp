import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TypeScriptLanguagePlugin } from '../../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import { registerProject, unregisterProject } from '../../../src/registry.js';
import type { ServerContext } from '../../../src/server/server.js';
import { registerLookupTools } from '../../../src/tools/register/navigation/lookup-tools.js';
import { createTestStore } from '../../test-utils.js';

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
    tool: (
      name: string,
      _description: string,
      _shape: Record<string, z.ZodTypeAny>,
      handler: Handler,
    ) => {
      captured.push({ name, handler });
    },
  };
  return { server, captured };
}

describe('get_outline → get_symbol workflow (TRA-2535)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tra2535-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('workflow: get_outline followed by get_symbol for a confirmed existing symbol', async () => {
    const projDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
    const filePath = path.join(projDir, 'src', 'greeter.ts');
    fs.writeFileSync(
      filePath,
      'export class Greeter {\n  greet(name: string): string {\n    return "hello " + name;\n  }\n}\n',
    );

    const store = createTestStore();
    const fileRow = store.insertFile('src/greeter.ts', 'typescript', 'h1', 100);
    store.insertSymbol(fileRow, {
      symbolId: 'src/greeter.ts::Greeter#class',
      name: 'Greeter',
      kind: 'class',
      byteStart: 0,
      byteEnd: 85,
      lineStart: 1,
      lineEnd: 5,
    });
    store.insertSymbol(fileRow, {
      symbolId: 'src/greeter.ts::Greeter::greet#method',
      name: 'greet',
      kind: 'method',
      byteStart: 24,
      byteEnd: 83,
      lineStart: 2,
      lineEnd: 4,
    });

    const ctx = {
      store,
      registry: new PluginRegistry(),
      config: { root: projDir, include: ['**/*.ts'], exclude: [], plugins: [] },
      projectRoot: projDir,
      guardPath: () => null,
      j: (v: unknown) => JSON.stringify(v),
      jh: (_tool: string, v: unknown) => JSON.stringify(v),
      markExplored: () => undefined,
      decisionStore: null,
      rankingLedger: null,
      projectRelay: null,
    } as unknown as ServerContext;

    const { server, captured } = makeCapturingServer();
    registerLookupTools(server as never, ctx);
    const outlineHandler = captured.find((t) => t.name === 'get_outline')!.handler;
    const symbolHandler = captured.find((t) => t.name === 'get_symbol')!.handler;

    // 1. get_outline
    const outlineRes = await outlineHandler({ path: 'src/greeter.ts' });
    expect(outlineRes.isError).toBeFalsy();
    const outlineBody = JSON.parse(outlineRes.content[0].text);
    const greetSymbol = outlineBody.symbols.find((s: { name: string }) => s.name === 'greet');
    expect(greetSymbol).toBeDefined();

    // 2. get_symbol with exact symbolId from outline
    const symbolRes = await symbolHandler({ symbol_id: greetSymbol.symbolId });
    expect(symbolRes.isError).toBeFalsy();
    const symbolBody = JSON.parse(symbolRes.content[0].text);
    expect(symbolBody.name).toBe('greet');
    expect(symbolBody.source).toContain('return "hello " + name');
  });

  it('workflow: get_outline followed by get_symbol with project-prefixed path or Class.method notation', async () => {
    const projDir = path.join(tmpDir, 'proj-prefix');
    fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
    const filePath = path.join(projDir, 'src', 'manager.ts');
    fs.writeFileSync(
      filePath,
      'export class ProjectManager {\n  startIdleUnloadSweep(): void {}\n}\n',
    );

    const store = createTestStore();
    const fileRow = store.insertFile('src/manager.ts', 'typescript', 'h1', 100);
    store.insertSymbol(fileRow, {
      symbolId: 'src/manager.ts::ProjectManager::startIdleUnloadSweep#method',
      name: 'startIdleUnloadSweep',
      kind: 'method',
      byteStart: 31,
      byteEnd: 63,
      lineStart: 2,
      lineEnd: 2,
    });

    const ctx = {
      store,
      registry: new PluginRegistry(),
      config: { root: projDir, include: ['**/*.ts'], exclude: [], plugins: [] },
      projectRoot: projDir,
      guardPath: () => null,
      j: (v: unknown) => JSON.stringify(v),
      jh: (_tool: string, v: unknown) => JSON.stringify(v),
      markExplored: () => undefined,
      decisionStore: null,
      rankingLedger: null,
      projectRelay: null,
    } as unknown as ServerContext;

    const { server, captured } = makeCapturingServer();
    registerLookupTools(server as never, ctx);
    const symbolHandler = captured.find((t) => t.name === 'get_symbol')!.handler;

    // Call get_symbol with Class.method (without kind)
    const resDot = await symbolHandler({
      symbol_id: 'src/manager.ts::ProjectManager.startIdleUnloadSweep',
    });
    expect(resDot.isError).toBeFalsy();

    // Call get_symbol with project prefix + Class.method
    const resPrefix = await symbolHandler({
      symbol_id: 'proj-prefix/src/manager.ts::ProjectManager.startIdleUnloadSweep',
    });
    expect(resPrefix.isError).toBeFalsy();
  });

  it('workflow: relays get_symbol when file belongs to registered descendant project (TRA-2535)', async () => {
    const parentDir = path.join(tmpDir, 'parent');
    const childDir = path.join(parentDir, 'packages', 'child');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(
      path.join(childDir, 'child.ts'),
      'export function childFunc(): string { return "child"; }\n',
    );
    registerProject(parentDir);
    registerProject(childDir);

    try {
      const mockRelayedOutline = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              path: 'child.ts',
              symbols: [
                { name: 'childFunc', symbolId: 'packages/child/child.ts::childFunc#function' },
              ],
            }),
          },
        ],
        isError: false,
      };
      const mockRelayedSymbol = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              symbol_id: 'child.ts::childFunc#function',
              name: 'childFunc',
              source: 'export function childFunc(): string { return "child"; }',
            }),
          },
        ],
        isError: false,
      };

      const mockRelay = {
        listRelayTargets: () => [parentDir, childDir],
        openProject: vi.fn(async (targetRoot: string) => {
          if (targetRoot === childDir) {
            return {
              toolHandlers: new Map([
                ['get_outline', vi.fn(async () => mockRelayedOutline)],
                ['get_symbol', vi.fn(async () => mockRelayedSymbol)],
              ]),
            };
          }
          return null;
        }),
        dispose: () => {},
      };

      const store = createTestStore();
      store.insertFile('other.ts', 'typescript', 'h1', 1);

      const ctx = {
        store,
        registry: new PluginRegistry(),
        config: { root: parentDir, include: ['**/*.ts'], exclude: [], plugins: [] },
        projectRoot: parentDir,
        guardPath: () => null,
        j: (v: unknown) => JSON.stringify(v),
        jh: (_tool: string, v: unknown) => JSON.stringify(v),
        markExplored: () => undefined,
        decisionStore: null,
        rankingLedger: null,
        projectRelay: mockRelay,
      } as unknown as ServerContext;

      const { server, captured } = makeCapturingServer();
      registerLookupTools(server as never, ctx);
      const outlineHandler = captured.find((t) => t.name === 'get_outline')!.handler;
      const symbolHandler = captured.find((t) => t.name === 'get_symbol')!.handler;

      // 1. get_outline relays to childDir
      const outlineRes = await outlineHandler({ path: 'packages/child/child.ts' });
      expect(outlineRes.isError).toBeFalsy();

      // 2. get_symbol should also relay to childDir
      const symbolRes = await symbolHandler({
        symbol_id: 'packages/child/child.ts::childFunc#function',
      });
      expect(symbolRes.isError).toBeFalsy();
      const symbolBody = JSON.parse(symbolRes.content[0].text);
      expect(symbolBody.name).toBe('childFunc');
      expect(mockRelay.openProject).toHaveBeenCalledWith(childDir);
    } finally {
      unregisterProject(childDir);
      unregisterProject(parentDir);
    }
  });

  it('workflow: relays get_symbol when session is at / and file belongs to registered project (TRA-2535)', async () => {
    const projDir = path.join(tmpDir, 'thewed-ai-detector');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'detector.py'), 'def detect():\n    return True\n');
    registerProject(projDir);

    try {
      const mockRelayedSymbol = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              symbol_id: 'detector.py::detect#function',
              name: 'detect',
              source: 'def detect():\n    return True',
            }),
          },
        ],
        isError: false,
      };

      const mockRelay = {
        listRelayTargets: () => [projDir],
        openProject: vi.fn(async (targetRoot: string) => {
          if (targetRoot === projDir) {
            return {
              toolHandlers: new Map([['get_symbol', vi.fn(async () => mockRelayedSymbol)]]),
            };
          }
          return null;
        }),
        dispose: () => {},
      };

      const emptyStore = createTestStore();
      const ctx = {
        store: emptyStore,
        registry: new PluginRegistry(),
        config: { root: '/', include: [], exclude: [], plugins: [] },
        projectRoot: '/',
        guardPath: () => null,
        j: (v: unknown) => JSON.stringify(v),
        jh: (_tool: string, v: unknown) => JSON.stringify(v),
        markExplored: () => undefined,
        decisionStore: null,
        rankingLedger: null,
        projectRelay: mockRelay,
      } as unknown as ServerContext;

      const { server, captured } = makeCapturingServer();
      registerLookupTools(server as never, ctx);
      const symbolHandler = captured.find((t) => t.name === 'get_symbol')!.handler;

      // get_symbol on root session with project-prefixed path
      const symbolRes = await symbolHandler({
        symbol_id: 'thewed-ai-detector/detector.py::detect#function',
      });
      expect(symbolRes.isError).toBeFalsy();
      const symbolBody = JSON.parse(symbolRes.content[0].text);
      expect(symbolBody.name).toBe('detect');
      expect(mockRelay.openProject).toHaveBeenCalledWith(projDir);
    } finally {
      unregisterProject(projDir);
    }
  });

  it('workflow: auto-indexes on demand when file is not in store but exists on disk (TRA-2535)', async () => {
    const projDir = path.join(tmpDir, 'auto-index-proj');
    fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
    const filePath = path.join(projDir, 'src', 'service.ts');
    fs.writeFileSync(filePath, 'export function serveData(): string { return "data"; }\n');

    const store = createTestStore();
    // Initially empty store: file is not indexed yet
    expect(store.getStats().totalFiles).toBe(0);

    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

    const ctx = {
      store,
      registry,
      config: { root: projDir, include: ['**/*.ts'], exclude: [], plugins: [] },
      projectRoot: projDir,
      guardPath: () => null,
      j: (v: unknown) => JSON.stringify(v),
      jh: (_tool: string, v: unknown) => JSON.stringify(v),
      markExplored: () => undefined,
      decisionStore: null,
      rankingLedger: null,
      projectRelay: null,
    } as unknown as ServerContext;

    const { server, captured } = makeCapturingServer();
    registerLookupTools(server as never, ctx);
    const symbolHandler = captured.find((t) => t.name === 'get_symbol')!.handler;

    // get_symbol on unindexed file should auto-index and succeed
    const res = await symbolHandler({
      symbol_id: 'src/service.ts::serveData#function',
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.name).toBe('serveData');
    expect(body.source).toContain('return "data"');
  });

  it('outcome classification: genuine unknown symbol returns isError: true and NOT_FOUND', async () => {
    const projDir = path.join(tmpDir, 'notfound-proj');
    fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'src', 'dummy.ts'), 'export const a = 1;\n');

    const store = createTestStore();
    store.insertFile('src/dummy.ts', 'typescript', 'h1', 20);

    const ctx = {
      store,
      registry: new PluginRegistry(),
      config: { root: projDir, include: ['**/*.ts'], exclude: [], plugins: [] },
      projectRoot: projDir,
      guardPath: () => null,
      j: (v: unknown) => JSON.stringify(v),
      jh: (_tool: string, v: unknown) => JSON.stringify(v),
      markExplored: () => undefined,
      decisionStore: null,
      rankingLedger: null,
      projectRelay: null,
    } as unknown as ServerContext;

    const { server, captured } = makeCapturingServer();
    registerLookupTools(server as never, ctx);
    const symbolHandler = captured.find((t) => t.name === 'get_symbol')!.handler;

    const res = await symbolHandler({
      symbol_id: 'src/dummy.ts::nonExistentSymbol#function',
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
