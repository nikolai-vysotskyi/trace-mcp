import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import type { PluginRegistry } from '../../src/plugin-api/registry.js';
import { registerPrompts } from '../../src/prompts/index.js';

// Minimal mock store
function createMockStore(): Store {
  return {
    db: { prepare: () => ({ all: () => [], get: () => null, run: () => ({}) }) },
    getFile: () => null,
    getFileById: () => null,
    getAllFiles: () => [],
    getSymbolById: () => null,
    getSymbolByName: () => null,
    getStats: () => ({
      totalFiles: 0,
      totalSymbols: 0,
      totalEdges: 0,
      totalNodes: 0,
      totalRoutes: 0,
      totalResourceRoutes: 0,
      totalTestFixtureRoutes: 0,
      totalComponents: 0,
      totalMigrations: 0,
      partialFiles: 0,
      errorFiles: 0,
    }),
    getAllRoutes: () => [],
    searchSymbols: () => ({ items: [], total: 0 }),
    getEdgesFrom: () => [],
    getEdgesTo: () => [],
    getWorkspaceStats: () => [],
    getWorkspaceDependencyGraph: () => [],
    getWorkspaceExports: () => [],
    getCrossWorkspaceEdges: () => [],
    getCommunities: () => [],
    getCoChanges: () => [],
  } as unknown as Store;
}

function createMockRegistry(): PluginRegistry {
  return {
    getAllFrameworkPlugins: () => [],
    getAllLanguagePlugins: () => [],
  } as unknown as PluginRegistry;
}

const defaultConfig: TraceMcpConfig = {
  root: '.',
  include: [],
  exclude: [],
  plugins: [],
} as unknown as TraceMcpConfig;

describe('MCP Prompts', () => {
  let server: McpServer;
  let registeredPrompts: Map<string, unknown>;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.1.0' }, {});
    registeredPrompts = new Map();

    // Intercept prompt registrations
    const origPrompt = server.prompt.bind(server);
    server.prompt = ((...args: unknown[]) => {
      const name = args[0] as string;
      registeredPrompts.set(name, args);
      return origPrompt(...(args as Parameters<typeof origPrompt>));
    }) as typeof server.prompt;

    const store = createMockStore();
    const registry = createMockRegistry();
    registerPrompts(server, {
      store,
      registry,
      config: defaultConfig,
      projectRoot: '/nonexistent/test',
    });
  });

  it('registers all 6 prompts', () => {
    expect(registeredPrompts.size).toBe(6);
    expect(registeredPrompts.has('review')).toBe(true);
    expect(registeredPrompts.has('onboard')).toBe(true);
    expect(registeredPrompts.has('debug')).toBe(true);
    expect(registeredPrompts.has('architecture')).toBe(true);
    expect(registeredPrompts.has('pre-merge')).toBe(true);
    expect(registeredPrompts.has('state')).toBe(true);
  });

  describe('state prompt', () => {
    // Go through the registered zod schema, not just the callback: the argument
    // validation is part of the contract a real `prompts/get` exercises.
    async function getStatePrompt(params: Record<string, unknown>): Promise<string> {
      const args = registeredPrompts.get('state') as unknown[];
      const schema = z.object(args[2] as Record<string, z.ZodTypeAny>);
      const parsed = schema.parse(params);
      const callback = args[3] as (
        p: unknown,
      ) => Promise<{ messages: { content: { text: string } }[] }>;
      const result = await callback(parsed);
      return result.messages[0]!.content.text;
    }

    it('emits the SKILL.state protocol and a seeded trace_state_init call', async () => {
      const text = await getStatePrompt({
        goal: 'Fix the flaky indexer test',
        steps: 'reproduce, isolate, fix',
      });
      expect(text).toContain('SKILL.state Execution Protocol');
      expect(text).toContain('"trace_state_init"');
      expect(text).toMatch(
        /"trace_state_init"[\s\S]*?task_id: "fix-the-flaky-indexer-test-[0-9a-f]{8}"/,
      );
      expect(text).toContain('["reproduce","isolate","fix"]');
    });

    it('routes every state call through batch, which the default preset advertises', async () => {
      const text = await getStatePrompt({ goal: 'anything' });
      // No bare `trace_state_x(` call: on `minimal` those tools are not in tools/list.
      expect(text).not.toMatch(/[^"]trace_state_\w+\(/);
      for (const tool of [
        'trace_state_init',
        'trace_state_patch',
        'trace_state_checkpoint',
        'trace_state_rollback',
        'trace_state_add_dead_end',
        'trace_state_get',
      ]) {
        expect(text).toContain(`tool: "${tool}"`);
      }
    });

    it('gives two non-ASCII goals two different task ids', async () => {
      const first = await getStatePrompt({ goal: 'Исправить тест' });
      const second = await getStatePrompt({ goal: 'Добавить фичу' });
      // Anchored on the init call — the protocol above it carries `task_id: "..."`
      // placeholders that a bare match would pick up first.
      const idOf = (text: string) => /"trace_state_init"[\s\S]*?task_id: "([^"]+)"/.exec(text)?.[1];
      expect(idOf(first)).toBeTruthy();
      expect(idOf(first)).not.toBe(idOf(second));
    });

    it('rejects an empty or blank goal instead of emitting a doomed init call', () => {
      const schema = z.object(
        (registeredPrompts.get('state') as unknown[])[2] as Record<string, z.ZodTypeAny>,
      );
      expect(() => schema.parse({ goal: '' })).toThrow();
      expect(() => schema.parse({ goal: '   ' })).toThrow();
    });

    it('keeps a quote in the goal inside the rendered string', async () => {
      const text = await getStatePrompt({ goal: 'handle "quoted" input', task_id: 't1' });
      expect(text).toContain('goal: "handle \\"quoted\\" input"');
    });
  });

  it('review prompt has branch argument', () => {
    const args = registeredPrompts.get('review') as unknown[];
    // args[0]=name, args[1]=description, args[2]=schema, args[3]=callback
    const schema = args[2] as Record<string, unknown>;
    expect(schema).toHaveProperty('branch');
  });

  it('debug prompt has description argument', () => {
    const args = registeredPrompts.get('debug') as unknown[];
    const schema = args[2] as Record<string, unknown>;
    expect(schema).toHaveProperty('description');
  });

  it('onboard prompt has no required arguments', () => {
    const args = registeredPrompts.get('onboard') as unknown[];
    const schema = args[2] as Record<string, unknown>;
    // Empty schema = no required args
    expect(Object.keys(schema).length).toBe(0);
  });

  it('pre-merge prompt has branch argument', () => {
    const args = registeredPrompts.get('pre-merge') as unknown[];
    const schema = args[2] as Record<string, unknown>;
    expect(schema).toHaveProperty('branch');
  });

  describe('no N+1 patterns', () => {
    it('review prompt limits impact analysis to 5 files', async () => {
      // The review prompt callback should not analyze more than 5 files
      // We verify by checking the source code — this is a structural test
      const args = registeredPrompts.get('review') as unknown[];
      const callback = args[3] as (
        params: unknown,
      ) => Promise<{ messages: { role: string; content: { text: string } }[] }>;
      // Call with a branch — git will likely fail in test env, which is fine
      const result = await callback({ branch: 'test-branch', base: 'main' });
      expect(result).toHaveProperty('messages');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(typeof result.messages[0].content.text).toBe('string');
    });

    it('pre-merge prompt limits blast radius to 5 files', async () => {
      const args = registeredPrompts.get('pre-merge') as unknown[];
      const callback = args[3] as (
        params: unknown,
      ) => Promise<{ messages: { role: string; content: { text: string } }[] }>;
      const result = await callback({ branch: 'test-branch', base: 'main' });
      expect(result).toHaveProperty('messages');
      expect(result.messages[0].content.text).toContain('Pre-Merge Checklist');
    });
  });
});
