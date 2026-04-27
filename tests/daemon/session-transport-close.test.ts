import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for the daemon's per-session transport.onclose wiring.
 *
 * Before the fix, cli.ts set `transport.onclose = () => { ...; h.server.close(); }`
 * inside the session setup. Because `McpServer.close → Protocol.close → transport.close`
 * synchronously fires `onclose` again (the SDK's WebStandardStreamableHTTPTransport.close
 * body runs to `this.onclose?.()` without hitting an await first), calling `server.close()`
 * from inside onclose produced infinite synchronous recursion → stack overflow.
 *
 * The invariant this test enforces: the transport.onclose callback used by sessions
 * must NOT call `server.close()`, and closing the server once must terminate cleanly
 * without stack overflow, firing onclose exactly once per session.
 */
describe('session transport onclose', () => {
  it('does not stack-overflow when server.close() is called during shutdown', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await server.connect(transport);

    // Replicate cli.ts wiring: preserve the Protocol-wired onclose, then attach ours.
    // Our onclose must only do bookkeeping — never re-close the server.
    const protocolOnClose = transport.onclose;
    let oncloseCount = 0;
    transport.onclose = () => {
      protocolOnClose?.();
      oncloseCount++;
      // Intentionally no server.close() here — that is the bug we're guarding against.
    };

    // Close the server. This must return without throwing and without recursing.
    await server.close();

    expect(oncloseCount).toBe(1);
  });

  it('closing transport directly also fires onclose exactly once', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);

    const protocolOnClose = transport.onclose;
    let oncloseCount = 0;
    transport.onclose = () => {
      protocolOnClose?.();
      oncloseCount++;
    };

    await transport.close();

    expect(oncloseCount).toBe(1);
  });
});
