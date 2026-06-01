import { describe, expect, it } from 'vitest';
import { TOPOLOGY_DB_PATH, TRACE_MCP_HOME } from '../../src/global.js';

/**
 * Guards the suite-wide home isolation wired in vitest.config.ts
 * (setupFiles: ['./tests/setup/isolate-home.ts']). If that wiring is removed or
 * stops running before global.ts is imported, TRACE_MCP_HOME resolves to the
 * developer's real ~/.trace-mcp and daemon/subproject/decision tests silently
 * corrupt production state. This test fails loudly in that case.
 */
describe('test home isolation', () => {
  it('redirects the trace-mcp global home into an isolated temp dir', () => {
    expect(process.env.TRACE_MCP_DATA_DIR, 'setupFile must set TRACE_MCP_DATA_DIR').toBeTruthy();
    // The setupFile names the temp home with this prefix; the real home does not.
    expect(TRACE_MCP_HOME).toContain('trace-mcp-test-home-');
    expect(TOPOLOGY_DB_PATH).toContain('trace-mcp-test-home-');
  });

  it('does not resolve to a real ~/.trace-mcp home', () => {
    expect(TRACE_MCP_HOME.endsWith('/.trace-mcp')).toBe(false);
    expect(TRACE_MCP_HOME.endsWith('\\.trace-mcp')).toBe(false);
  });
});
