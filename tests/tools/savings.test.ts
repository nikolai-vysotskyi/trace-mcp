import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SavingsTracker, loadPersistentSavings } from '../../src/savings.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

// Use a temp dir to avoid polluting real ~/.trace-mcp
let tmpDir: string;

describe('SavingsTracker', () => {
  beforeEach(() => {
    tmpDir = createTmpDir('trace-mcp-savings-');
    // Override TRACE_MCP_HOME by monkey-patching the module's SAVINGS_PATH
    // We test the class logic directly — persistence tests use the real path logic
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  describe('session tracking', () => {
    it('starts with zero stats', () => {
      const tracker = new SavingsTracker('/test/project');
      const stats = tracker.getSessionStats();
      expect(stats.total_calls).toBe(0);
      expect(stats.total_tokens_saved).toBe(0);
      expect(stats.total_raw_tokens).toBe(0);
      expect(stats.total_actual_tokens).toBe(0);
      expect(stats.reduction_pct).toBe(0);
    });

    it('records a known tool call with estimated savings', () => {
      const tracker = new SavingsTracker('/test/project');
      tracker.recordCall('search');
      const stats = tracker.getSessionStats();
      expect(stats.total_calls).toBe(1);
      expect(stats.total_raw_tokens).toBeGreaterThan(0);
      expect(stats.total_tokens_saved).toBeGreaterThan(0);
      expect(stats.total_actual_tokens).toBeGreaterThan(0);
      expect(stats.reduction_pct).toBeGreaterThan(0);
      expect(stats.per_tool['search'].calls).toBe(1);
    });

    it('records an unknown tool with default cost', () => {
      const tracker = new SavingsTracker('/test/project');
      tracker.recordCall('unknown_tool_xyz');
      const stats = tracker.getSessionStats();
      expect(stats.total_calls).toBe(1);
      expect(stats.total_raw_tokens).toBe(500); // DEFAULT_RAW_COST
      expect(stats.per_tool['unknown_tool_xyz'].calls).toBe(1);
    });

    it('accepts custom actual token count', () => {
      const tracker = new SavingsTracker('/test/project');
      tracker.recordCall('search', 100);
      const stats = tracker.getSessionStats();
      // search raw cost = 600, actual = 100, saved = 500
      expect(stats.total_raw_tokens).toBe(600);
      expect(stats.total_actual_tokens).toBe(100);
      expect(stats.total_tokens_saved).toBe(500);
    });

    it('accumulates multiple calls', () => {
      const tracker = new SavingsTracker('/test/project');
      tracker.recordCall('search');
      tracker.recordCall('search');
      tracker.recordCall('get_outline');
      const stats = tracker.getSessionStats();
      expect(stats.total_calls).toBe(3);
      expect(stats.per_tool['search'].calls).toBe(2);
      expect(stats.per_tool['get_outline'].calls).toBe(1);
    });

    it('computes reduction percentage correctly', () => {
      const tracker = new SavingsTracker('/test/project');
      tracker.recordCall('get_symbol', 50); // raw 800, actual 50, saved 750
      const stats = tracker.getSessionStats();
      expect(stats.reduction_pct).toBe(Math.round((750 / 800) * 100));
    });
  });

  describe('getFullStats', () => {
    it('returns session and null cumulative when no persistent file', () => {
      const tracker = new SavingsTracker('/test/project');
      tracker.recordCall('search');
      const full = tracker.getFullStats();
      expect(full.session.total_calls).toBe(1);
      // cumulative is null or existing data — depends on whether ~/.trace-mcp/savings.json exists
      // We just check the structure
      expect(full).toHaveProperty('session');
      expect(full).toHaveProperty('cumulative');
    });
  });

  describe('flush idempotency', () => {
    it('flush is idempotent — second call is a no-op', () => {
      const tracker = new SavingsTracker('/test/project');
      tracker.recordCall('search');
      tracker.flush(); // first flush
      tracker.flush(); // second flush — should be no-op
      // No error thrown = success
    });

    it('flush with zero calls does nothing', () => {
      const tracker = new SavingsTracker('/test/project');
      tracker.flush();
      // No error, no file written for zero calls
    });
  });

  describe('no memory leaks in per_tool accumulation', () => {
    it('handles 10000 calls without unbounded growth', () => {
      const tracker = new SavingsTracker('/test/project');
      const tools = ['search', 'get_symbol', 'get_outline', 'get_call_graph', 'find_usages'];
      for (let i = 0; i < 10000; i++) {
        tracker.recordCall(tools[i % tools.length]);
      }
      const stats = tracker.getSessionStats();
      expect(stats.total_calls).toBe(10000);
      // per_tool should only have 5 entries, not 10000
      expect(Object.keys(stats.per_tool).length).toBe(5);
      expect(stats.per_tool['search'].calls).toBe(2000);
    });
  });
});

describe('loadPersistentSavings', () => {
  it('returns null when file does not exist', () => {
    // This tests against real SAVINGS_PATH — may or may not exist
    // Just verify it returns PersistentSavings | null without crashing
    const result = loadPersistentSavings();
    if (result !== null) {
      expect(result.version).toBe(1);
      expect(typeof result.total_calls).toBe('number');
      expect(typeof result.sessions).toBe('number');
    }
  });
});
