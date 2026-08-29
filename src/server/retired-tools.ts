/**
 * Retired-tool hints (TRA-412).
 *
 * v2.0.0 removed seven deprecated aliases. An agent whose CLAUDE.md, saved
 * workflow, or habit still names one gets the SDK's bare `Tool X not found`,
 * which is a dead end — the user reads it as flakiness and stops using the
 * tool. Re-registering the names as tombstones would undo the schema saving
 * the removal bought, so instead we wrap the already-installed `tools/call`
 * handler and rewrite the not-found message for those seven names only.
 * Zero cost on `tools/list` and on every client's schema payload.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Retired tool name → the call that replaces it, verbatim from PR #415. */
export const RETIRED_TOOL_REPLACEMENTS: Readonly<Record<string, string>> = {
  pin_symbol: 'pin { symbol_id }',
  pin_file: 'pin { file_path }',
  search_with_mode: 'search { query, retriever: mode }',
  get_dead_exports: 'get_dead_code { file_pattern, mode: "exports_only" }',
  get_untested_exports: 'get_untested_symbols { file_pattern, scope: "exports_only" }',
  get_session_resume: 'get_wake_up { scope: "resume", max_sessions }',
  get_project_memo: 'get_wake_up { scope: "project", include_history, history_limit }',
};

/** Self-service error text for a retired name, or `null` if the name is not one. */
export function retiredToolMessage(name: string): string | null {
  const replacement = RETIRED_TOOL_REPLACEMENTS[name];
  if (!replacement) return null;
  return (
    `Tool ${name} was removed in trace-mcp v2.0.0. Use ${replacement} instead — ` +
    `it accepts the same arguments and returns the same shape. ` +
    `Full migration table: https://trace-mcp.com/tools-reference.html`
  );
}

/**
 * Wraps the SDK's `tools/call` handler so a retired name fails with its
 * replacement instead of a bare "not found". Call once, after every
 * `register*Tools()` — the SDK installs the handler lazily on the first
 * `server.tool(...)`, so there is nothing to wrap before that.
 */
export function installRetiredToolHints(server: McpServer): void {
  // ponytail: reaches into the SDK's private handler map, same monkey-patch
  // style as installToolGate. No public seam exists; no-ops if the shape
  // changes, so a future SDK bump degrades to today's bare message.
  const handlers = (
    server.server as unknown as {
      _requestHandlers?: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const inner = handlers?.get('tools/call');
  if (!handlers || !inner) return;

  handlers.set('tools/call', async (request: unknown, extra: unknown) => {
    const result = await inner(request, extra);
    const name = (request as { params?: { name?: unknown } } | undefined)?.params?.name;
    const hint = typeof name === 'string' ? retiredToolMessage(name) : null;
    if (!hint) return result;

    // The SDK turns its own `Tool X not found` McpError into an isError
    // result rather than rejecting, so rewrite the text, not an exception.
    const r = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    const first = r?.isError ? r.content?.[0] : undefined;
    if (first?.type === 'text' && first.text?.includes(`Tool ${name} not found`)) {
      return { ...r, content: [{ ...first, text: hint }, ...(r.content ?? []).slice(1)] };
    }
    return result;
  });
}
