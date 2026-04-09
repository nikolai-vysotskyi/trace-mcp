import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installToolGate } from '../../src/server/tool-gate.js';
import type { TraceMcpConfig } from '../../src/config.js';

// ─── Mocks ───────────────────────────────────────────────────

function createMockServer() {
  const registered: Array<{ name: string; desc?: string; schema?: unknown; cb?: Function }> = [];
  const server = {
    tool: vi.fn((...args: unknown[]) => {
      const name = args[0] as string;
      const desc = typeof args[1] === 'string' ? args[1] as string : undefined;
      const schemaIdx = typeof args[1] === 'string' ? 2 : 1;
      const schema = args.length > schemaIdx + 1 ? args[schemaIdx] : undefined;
      const cb = args[args.length - 1] as Function;
      registered.push({ name, desc, schema, cb });
    }),
  };
  return { server: server as any, registered };
}

function createMockSavings() {
  return {
    recordCall: vi.fn(),
    getSessionStats: vi.fn().mockReturnValue({
      total_calls: 0,
      total_raw_tokens: 0,
      total_tokens_saved: 0,
      total_actual_tokens: 0,
      reduction_pct: 0,
      per_tool: {},
      started_at: new Date().toISOString(),
    }),
  } as any;
}

function createMockJournal() {
  return {
    checkDuplicate: vi.fn().mockReturnValue(null),
    record: vi.fn(),
    recordDedupSaving: vi.fn(),
    getOptimizationHint: vi.fn().mockReturnValue(null),
  } as any;
}

const j = (v: unknown) => JSON.stringify(v);
const extractResultCount = () => 1;
const extractCompactResult = () => undefined;
const stripMetaFields = () => {};

// ─── Tests ───────────────────────────────────────────────────

describe('installToolGate', () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let savings: ReturnType<typeof createMockSavings>;
  let journal: ReturnType<typeof createMockJournal>;

  beforeEach(() => {
    mockServer = createMockServer();
    savings = createMockSavings();
    journal = createMockJournal();
  });

  function install(config: Partial<TraceMcpConfig> = {}, preset: Set<string> | 'all' = 'all') {
    return installToolGate(
      mockServer.server,
      config as TraceMcpConfig,
      preset,
      savings,
      journal,
      j,
      extractResultCount,
      extractCompactResult,
      stripMetaFields,
    );
  }

  describe('tool filtering', () => {
    it('allows all tools when preset is "all"', () => {
      install({});
      // Register a tool through the patched server.tool
      mockServer.server.tool('search', 'Search symbols', async () => ({}));
      expect(mockServer.registered).toHaveLength(1);
      expect(mockServer.registered[0].name).toBe('search');
    });

    it('filters tools by preset set', () => {
      const preset = new Set(['search', 'get_outline']);
      install({}, preset);

      mockServer.server.tool('search', 'desc', async () => ({}));
      mockServer.server.tool('get_outline', 'desc', async () => ({}));
      mockServer.server.tool('blocked_tool', 'desc', async () => ({}));

      expect(mockServer.registered).toHaveLength(2);
      expect(mockServer.registered.map((r: any) => r.name)).toEqual(['search', 'get_outline']);
    });

    it('exclude takes priority over include', () => {
      install({
        tools: { include: ['search', 'get_outline'], exclude: ['search'] },
      });

      mockServer.server.tool('search', 'desc', async () => ({}));
      mockServer.server.tool('get_outline', 'desc', async () => ({}));

      // search excluded even though in include
      expect(mockServer.registered).toHaveLength(1);
      expect(mockServer.registered[0].name).toBe('get_outline');
    });

    it('include overrides preset filtering', () => {
      const preset = new Set(['get_outline']);
      install({ tools: { include: ['search'] } }, preset);

      mockServer.server.tool('search', 'desc', async () => ({}));
      mockServer.server.tool('get_outline', 'desc', async () => ({}));
      mockServer.server.tool('blocked', 'desc', async () => ({}));

      expect(mockServer.registered.map((r: any) => r.name)).toEqual(['search', 'get_outline']);
    });

    it('returns registered tool names', () => {
      const result = install({});
      mockServer.server.tool('search', 'desc', async () => ({}));
      mockServer.server.tool('get_outline', 'desc', async () => ({}));
      expect(result.registeredToolNames).toEqual(['search', 'get_outline']);
    });
  });

  describe('description overrides', () => {
    it('applies string override to tool description', () => {
      install({
        tools: { descriptions: { search: 'Custom search description' } },
      });

      mockServer.server.tool('search', 'Original desc', async () => ({}));
      expect(mockServer.registered[0].desc).toBe('Custom search description');
    });

    it('applies object override with _description', () => {
      install({
        tools: {
          descriptions: {
            search: { _description: 'Custom desc', query: 'The search query' } as any,
          },
        },
      });

      mockServer.server.tool('search', 'Original', async () => ({}));
      expect(mockServer.registered[0].desc).toBe('Custom desc');
    });
  });

  describe('verbosity control', () => {
    it('keeps full description when verbosity is full', () => {
      install({ tools: { description_verbosity: 'full' } });

      mockServer.server.tool('search', 'Full description. With details.', async () => ({}));
      expect(mockServer.registered[0].desc).toBe('Full description. With details.');
    });

    it('truncates to first sentence when verbosity is minimal', () => {
      install({ tools: { description_verbosity: 'minimal' } });

      mockServer.server.tool('search', 'First sentence. More details here.', async () => ({}));
      expect(mockServer.registered[0].desc).toBe('First sentence.');
    });

    it('returns empty string when verbosity is none', () => {
      install({ tools: { description_verbosity: 'none' } });

      mockServer.server.tool('search', 'Description text.', async () => ({}));
      expect(mockServer.registered[0].desc).toBe('');
    });
  });

  describe('callback wrapping', () => {
    it('records call in savings tracker', async () => {
      install({});
      const cb = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
      mockServer.server.tool('search', 'desc', cb);

      // Invoke the wrapped callback
      const wrappedCb = mockServer.registered[0].cb;
      await wrappedCb!({ query: 'test' });

      expect(savings.recordCall).toHaveBeenCalledWith('search');
    });

    it('records call in journal', async () => {
      install({});
      const cb = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
      mockServer.server.tool('search', 'desc', cb);

      await mockServer.registered[0].cb!({ query: 'test' });

      expect(journal.record).toHaveBeenCalledWith(
        'search',
        { query: 'test' },
        1,
        expect.objectContaining({ compactResult: undefined }),
      );
    });

    it('returns dedup response when journal detects duplicate', async () => {
      journal.checkDuplicate.mockReturnValue({
        action: 'dedup',
        message: 'Already called',
        saved_tokens: 500,
        compact_result: { _result_count: 1, summary: 'cached' },
      });

      install({});
      const cb = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
      mockServer.server.tool('search', 'desc', cb);

      const result = await mockServer.registered[0].cb!({ query: 'test' });

      // Original callback should NOT be called (dedup short-circuit)
      expect(cb).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Already called');
      expect(journal.recordDedupSaving).toHaveBeenCalledWith(500);
    });

    it('adds duplicate warning on warn-only dedup', async () => {
      journal.checkDuplicate.mockReturnValue({
        action: 'warn',
        message: 'Similar call made before',
      });

      install({});
      const cb = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"data":"result"}' }],
      });
      mockServer.server.tool('search', 'desc', cb);

      const result = await mockServer.registered[0].cb!({ query: 'test' });

      expect(cb).toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._duplicate_warning).toBe('Similar call made before');
    });

    it('adds optimization hint when journal provides one', async () => {
      journal.getOptimizationHint.mockReturnValue('Use batch instead');

      install({});
      const cb = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"data":"result"}' }],
      });
      mockServer.server.tool('search', 'desc', cb);

      const result = await mockServer.registered[0].cb!({ query: 'test' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._optimization_hint).toBe('Use batch instead');
    });

    it('stores handler in toolHandlers map', () => {
      const result = install({});
      const cb = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
      mockServer.server.tool('search', 'desc', cb);

      expect(result.toolHandlers.has('search')).toBe(true);
    });
  });
});
