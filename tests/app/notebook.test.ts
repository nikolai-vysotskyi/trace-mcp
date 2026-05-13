/**
 * Smoke test for the Notebook scratchpad tab.
 *
 * The Electron app package has no React/jsdom test harness, so this test
 * targets the pure logic exported from Notebook.tsx: the tool catalog and
 * the daemon client's request-shaping behaviour. The React component itself
 * is exercised by manual launch (see plan-cognee-R08-IMPL.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTEBOOK_TOOLS,
  defaultNotebookClient,
  type NotebookClient,
} from '../../packages/app/src/renderer/tabs/Notebook';

describe('Notebook scratchpad', () => {
  describe('tool catalog', () => {
    it('exposes exactly the four allow-listed read-only tools', () => {
      const names = NOTEBOOK_TOOLS.map((t) => t.name).sort();
      expect(names).toEqual(['find_usages', 'get_outline', 'get_symbol', 'search']);
    });

    it('every tool has at least one required field', () => {
      for (const tool of NOTEBOOK_TOOLS) {
        const required = tool.fields.filter((f) => f.required);
        expect(required.length, `${tool.name} has no required field`).toBeGreaterThan(0);
      }
    });

    it('every tool has a non-empty description', () => {
      for (const tool of NOTEBOOK_TOOLS) {
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });

    it('allow-list contains no write/destructive tools', () => {
      const forbidden = [
        'apply_rename',
        'apply_codemod',
        'apply_move',
        'remove_dead_code',
        'reindex',
      ];
      const names = NOTEBOOK_TOOLS.map((t) => t.name as string);
      for (const f of forbidden) {
        expect(names).not.toContain(f);
      }
    });
  });

  describe('defaultNotebookClient', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      // Reset fetch before each test so mocks don't leak across cases.
      globalThis.fetch = originalFetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('routes search to the REST symbols endpoint with project + query params', async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ symbols: [{ id: 1, fqn: 'Foo' }], count: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const result = await defaultNotebookClient.callTool(
        'search',
        { query: 'registerTool', kind: 'function' },
        '/path/to/project',
      );

      expect(calls).toHaveLength(1);
      const url = calls[0].url;
      expect(url).toContain('/api/projects/symbols');
      expect(url).toContain('project=%2Fpath%2Fto%2Fproject');
      expect(url).toContain('q=registerTool');
      expect(url).toContain('kind=function');
      expect((result as { count: number }).count).toBe(1);
    });

    it('search omits the kind param when blank', async () => {
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ symbols: [], count: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      await defaultNotebookClient.callTool('search', { query: 'x', kind: '' }, '/p');
      expect(calls[0]).not.toContain('kind=');
    });

    it('search surfaces HTTP errors as thrown errors', async () => {
      globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as typeof fetch;
      await expect(defaultNotebookClient.callTool('search', { query: 'x' }, '/p')).rejects.toThrow(
        /500/,
      );
    });
  });

  describe('NotebookClient contract', () => {
    it('a test double can be injected without touching globals', async () => {
      // The component accepts a `client` prop so tests can swap the daemon.
      // Confirm the contract is small enough to mock in a single object.
      const fake: NotebookClient = {
        async callTool(tool, args) {
          return { tool, args, mocked: true };
        },
      };
      const out = (await fake.callTool('get_outline', { path: 'a.ts' }, '/p')) as {
        tool: string;
        mocked: boolean;
      };
      expect(out.tool).toBe('get_outline');
      expect(out.mocked).toBe(true);
    });
  });
});
