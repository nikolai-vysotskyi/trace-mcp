/**
 * Pure runtime for the Notebook scratchpad tab.
 *
 * This file contains the React-free pieces of the notebook surface:
 *   - the allow-listed tool catalog (4 read-only tools)
 *   - the NotebookClient contract
 *   - the defaultNotebookClient that shapes HTTP / JSON-RPC requests
 *
 * Why is this split out from Notebook.tsx? The Electron app workspace does not
 * ship a React/jsdom test toolchain, so the project-root vitest config runs
 * these tests without a DOM. Importing Notebook.tsx pulls in `react`, which
 * is not hoisted to the root node_modules under pnpm --frozen-lockfile on
 * Linux CI. Keeping the testable surface in a pure-TS module avoids that.
 *
 * Keep this file framework-agnostic — no React, no DOM types. Notebook.tsx
 * re-exports the public API for backwards compatibility.
 */

import { DAEMON_TOOL_TIMEOUT_MS, daemonFetch } from '../daemon-fetch';

const BASE = 'http://127.0.0.1:3741';

// ── Tool catalog ─────────────────────────────────────────────────────
// Keep this list narrow: 4 read-only tools chosen for typical exploration
// workflows. Extending it is a deliberate decision — never auto-add tools
// just because they are read-only.

export type ToolName = 'search' | 'get_outline' | 'get_symbol' | 'find_usages';

/* The catalog carries KEYS, not sentences (TRA-385). Two reasons: this module
   is deliberately React-free and must not pull the renderer's i18n runtime in,
   and a tool's label, description and error sentence are read by the component
   that draws them — which re-renders on a language switch, where a constant
   resolved at import time would not. */
export interface ToolField {
  key: string;
  /** Catalogue key for the field's form label. */
  labelKey: string;
  /** Catalogue key for the example value shown in the empty field. */
  placeholderKey?: string;
  /** Catalogue key for "you have to fill this in" — required fields only. */
  missingKey?: string;
  required?: boolean;
}

export interface ToolDef {
  /** Also the label: a tool name is API vocabulary, identical in every language. */
  name: ToolName;
  descriptionKey: string;
  fields: ToolField[];
}

export const NOTEBOOK_TOOLS: ToolDef[] = [
  {
    name: 'search',
    descriptionKey: 'notebook:searchDescription',
    fields: [
      {
        key: 'query',
        labelKey: 'notebook:queryLabel',
        placeholderKey: 'notebook:queryPlaceholder',
        missingKey: 'notebook:queryMissing',
        required: true,
      },
      { key: 'kind', labelKey: 'notebook:kindLabel', placeholderKey: 'notebook:kindPlaceholder' },
    ],
  },
  {
    name: 'get_outline',
    descriptionKey: 'notebook:outlineDescription',
    fields: [
      {
        key: 'path',
        labelKey: 'notebook:pathLabel',
        placeholderKey: 'notebook:pathPlaceholder',
        missingKey: 'notebook:pathMissing',
        required: true,
      },
    ],
  },
  {
    name: 'get_symbol',
    descriptionKey: 'notebook:symbolDescription',
    fields: [
      {
        key: 'fqn',
        labelKey: 'notebook:fqnLabel',
        placeholderKey: 'notebook:fqnPlaceholder',
        missingKey: 'notebook:fqnMissing',
        required: true,
      },
    ],
  },
  {
    name: 'find_usages',
    descriptionKey: 'notebook:usagesDescription',
    fields: [
      {
        key: 'symbol_id',
        labelKey: 'notebook:symbolIdLabel',
        placeholderKey: 'notebook:symbolIdPlaceholder',
        missingKey: 'notebook:symbolIdMissing',
        required: true,
      },
    ],
  },
];

export const TOOL_BY_NAME: Record<ToolName, ToolDef> = NOTEBOOK_TOOLS.reduce(
  (acc, t) => {
    acc[t.name] = t;
    return acc;
  },
  {} as Record<ToolName, ToolDef>,
);

// ── Daemon client ────────────────────────────────────────────────────
// `search` has a dedicated REST endpoint; the other tools go over the
// MCP JSON-RPC channel. We open a fresh JSON-RPC session per call — cheap
// enough for ad-hoc exploration. Replace with a persistent session if this
// tab becomes a heavy surface.
//
// The throws below stay in English on purpose: they name a JSON-RPC protocol
// violation, not a thing the reader did, and translating them would cost this
// module its no-React contract for two sentences nobody should ever see.

export interface NotebookClient {
  callTool(tool: ToolName, args: Record<string, string>, root: string): Promise<unknown>;
}

export const defaultNotebookClient: NotebookClient = {
  async callTool(tool, args, root) {
    if (tool === 'search') {
      const q = args.query?.trim() ?? '';
      const kind = args.kind?.trim() ?? '';
      const params = new URLSearchParams({ project: root, q, limit: '30' });
      if (kind) params.set('kind', kind);
      const r = await daemonFetch(`${BASE}/api/projects/symbols?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`);
      return await r.json();
    }
    // JSON-RPC path: initialize a session, then call the tool.
    const initRes = await daemonFetch(`${BASE}/mcp?project=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'trace-mcp-notebook', version: '0.1.0' },
        },
      }),
    }, DAEMON_TOOL_TIMEOUT_MS);
    if (!initRes.ok) throw new Error(`init failed: HTTP ${initRes.status}`);
    const sessionId = initRes.headers.get('mcp-session-id') ?? '';
    if (!sessionId) throw new Error('init did not return a session ID');
    // Drain the init response body so the server doesn't keep it open.
    await initRes.text().catch(() => '');
    // Send the notifications/initialized lifecycle message.
    await daemonFetch(`${BASE}/mcp?project=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    }, DAEMON_TOOL_TIMEOUT_MS).then((r) => r.text().catch(() => ''));
    // Call the tool.
    const cleanArgs: Record<string, string> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && v.trim() !== '') cleanArgs[k] = v;
    }
    const callRes = await daemonFetch(`${BASE}/mcp?project=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: tool, arguments: cleanArgs },
      }),
    }, DAEMON_TOOL_TIMEOUT_MS);
    if (!callRes.ok) throw new Error(`HTTP ${callRes.status}: ${await callRes.text().catch(() => '')}`);
    const ct = callRes.headers.get('content-type') ?? '';
    let payload: unknown;
    if (ct.includes('text/event-stream')) {
      // Parse SSE: find the first `data:` line that contains a JSON-RPC response.
      const raw = await callRes.text();
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        try {
          const parsed = JSON.parse(t.slice(5).trim());
          payload = parsed;
          break;
        } catch {
          // skip non-JSON data frames
        }
      }
    } else {
      payload = await callRes.json();
    }
    const rpc = payload as { error?: { message?: string }; result?: { content?: Array<{ type: string; text?: string }> } };
    if (rpc?.error) throw new Error(rpc.error.message ?? 'tool call failed');
    // MCP tools return content as an array of {type, text}. Unwrap the first text block.
    const first = rpc?.result?.content?.[0];
    if (first?.type === 'text' && typeof first.text === 'string') {
      try {
        return JSON.parse(first.text);
      } catch {
        return first.text;
      }
    }
    return rpc?.result ?? payload;
  },
};
