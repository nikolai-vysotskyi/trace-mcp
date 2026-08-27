import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

interface ToolsListResult {
  tools: Array<{
    inputSchema?: { $schema?: unknown };
    outputSchema?: { $schema?: unknown };
  }>;
}

function isToolsListResponse(
  msg: JSONRPCMessage,
): msg is JSONRPCMessage & { result: ToolsListResult } {
  const m = msg as Record<string, unknown>;
  if (!Object.hasOwn(m, 'result')) return false;
  const result = m.result as Record<string, unknown> | null;
  return typeof result === 'object' && result !== null && Array.isArray(result.tools);
}

/**
 * zod v4's `toJSONSchema()` — the converter the MCP SDK calls to turn a tool's
 * zod shape into `inputSchema` — stamps a top-level `$schema` URI on every
 * tool. Across ~171 tools that is ~9k chars (~2.25k tokens) of pure duplication
 * paid on every `tools/list`, and `$schema` is an optional informational
 * keyword no MCP client reads. Strip it as the message leaves the process.
 *
 * Verified against @modelcontextprotocol/sdk@1.29.0, zod@4.3.6 (2026-08-28).
 * The "premise" test in `__tests__/schema-shim.test.ts` asserts the *unpatched*
 * SDK still emits `$schema` — if an SDK/zod bump stops emitting it or changes
 * the response shape, that test fails instead of this shim silently becoming a
 * no-op.
 */
export function stripRedundantSchemaKeyword<T extends Transport>(transport: T): T {
  const originalSend = transport.send.bind(transport);
  transport.send = ((message: JSONRPCMessage, options?: unknown) => {
    if (isToolsListResponse(message)) {
      for (const tool of message.result.tools) {
        if (tool.inputSchema) delete tool.inputSchema.$schema;
        if (tool.outputSchema) delete tool.outputSchema.$schema;
      }
    }
    return originalSend(message, options as never);
  }) as Transport['send'];
  return transport;
}
