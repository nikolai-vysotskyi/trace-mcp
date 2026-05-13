/**
 * Notebook scratchpad tab.
 *
 * A REPL-like surface for trace-mcp tools. Each "cell" is a (tool, args) pair
 * the user can run; the JSON response is rendered inline. NOT a code-execution
 * sandbox — cells dispatch a fixed, allow-listed set of trace-mcp tools only.
 *
 * Visual style mirrors AskTab.tsx (sidebar header + flex content + accent
 * buttons + var(--*) theme tokens). Cells are local React state only; no
 * persistence in this slice — that's a follow-up.
 */
import { useCallback, useState } from 'react';

const BASE = 'http://127.0.0.1:3741';

// ── Tool catalog ─────────────────────────────────────────────────────
// Keep this list narrow: 4 read-only tools chosen for typical exploration
// workflows. Extending it is a deliberate decision — never auto-add tools
// just because they are read-only.

type ToolName = 'search' | 'get_outline' | 'get_symbol' | 'find_usages';

interface ToolField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
}

interface ToolDef {
  name: ToolName;
  label: string;
  description: string;
  fields: ToolField[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'search',
    label: 'search',
    description: 'Search symbols by name across the project',
    fields: [
      { key: 'query', label: 'Query', placeholder: 'e.g. registerTool', required: true },
      { key: 'kind', label: 'Kind (optional)', placeholder: 'function | class | method | …' },
    ],
  },
  {
    name: 'get_outline',
    label: 'get_outline',
    description: 'Get symbol signatures for a file',
    fields: [{ key: 'path', label: 'Path', placeholder: 'src/server/server.ts', required: true }],
  },
  {
    name: 'get_symbol',
    label: 'get_symbol',
    description: 'Read a single symbol by FQN',
    fields: [{ key: 'fqn', label: 'FQN', placeholder: 'src/foo.ts::Bar#class', required: true }],
  },
  {
    name: 'find_usages',
    label: 'find_usages',
    description: 'Find all references to a symbol',
    fields: [{ key: 'symbol_id', label: 'Symbol ID', placeholder: 'src/foo.ts::Bar#class', required: true }],
  },
];

const TOOL_BY_NAME: Record<ToolName, ToolDef> = TOOLS.reduce(
  (acc, t) => {
    acc[t.name] = t;
    return acc;
  },
  {} as Record<ToolName, ToolDef>,
);

// ── Cell state ───────────────────────────────────────────────────────

interface Cell {
  id: string;
  tool: ToolName;
  args: Record<string, string>;
  status: 'idle' | 'running' | 'ok' | 'error';
  result: unknown;
  error?: string;
}

function makeCell(): Cell {
  return {
    id: `cell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tool: 'search',
    args: { query: '' },
    status: 'idle',
    result: null,
  };
}

// ── Daemon client ────────────────────────────────────────────────────
// `search` has a dedicated REST endpoint; the other tools go over the
// MCP JSON-RPC channel. We open a fresh JSON-RPC session per call — cheap
// enough for ad-hoc exploration. Replace with a persistent session if this
// tab becomes a heavy surface.

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
      const r = await fetch(`${BASE}/api/projects/symbols?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`);
      return await r.json();
    }
    // JSON-RPC path: initialize a session, then call the tool.
    const initRes = await fetch(`${BASE}/mcp?project=${encodeURIComponent(root)}`, {
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
    });
    if (!initRes.ok) throw new Error(`init failed: HTTP ${initRes.status}`);
    const sessionId = initRes.headers.get('mcp-session-id') ?? '';
    if (!sessionId) throw new Error('init did not return a session ID');
    // Drain the init response body so the server doesn't keep it open.
    await initRes.text().catch(() => '');
    // Send the notifications/initialized lifecycle message.
    await fetch(`${BASE}/mcp?project=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    }).then((r) => r.text().catch(() => ''));
    // Call the tool.
    const cleanArgs: Record<string, string> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && v.trim() !== '') cleanArgs[k] = v;
    }
    const callRes = await fetch(`${BASE}/mcp?project=${encodeURIComponent(root)}`, {
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
    });
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

// ── Component ────────────────────────────────────────────────────────

export function Notebook({
  root,
  client = defaultNotebookClient,
}: {
  root: string;
  client?: NotebookClient;
}) {
  const [cells, setCells] = useState<Cell[]>(() => [makeCell()]);

  const addCell = useCallback(() => {
    setCells((prev) => [...prev, makeCell()]);
  }, []);

  const removeCell = useCallback((id: string) => {
    setCells((prev) => (prev.length === 1 ? prev : prev.filter((c) => c.id !== id)));
  }, []);

  const updateCell = useCallback((id: string, patch: Partial<Cell>) => {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const runCell = useCallback(
    async (id: string) => {
      const cell = cells.find((c) => c.id === id);
      if (!cell) return;
      const def = TOOL_BY_NAME[cell.tool];
      // Validate required fields client-side so we don't ping the daemon for nothing.
      const missing = def.fields.find((f) => f.required && !cell.args[f.key]?.trim());
      if (missing) {
        updateCell(id, { status: 'error', error: `Missing required field: ${missing.label}`, result: null });
        return;
      }
      updateCell(id, { status: 'running', error: undefined, result: null });
      try {
        const result = await client.callTool(cell.tool, cell.args, root);
        updateCell(id, { status: 'ok', result });
      } catch (err) {
        updateCell(id, { status: 'error', error: (err as Error).message ?? 'Unknown error' });
      }
    },
    [cells, client, root, updateCell],
  );

  return (
    <div
      className="flex flex-col h-full"
      style={{ WebkitAppRegion: 'no-drag', overflow: 'hidden' } as React.CSSProperties}
    >
      {/* Local keyframe — matches the Dashboard tab's inline style approach. */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      {/* Header */}
      <div
        style={{
          padding: '10px 14px 8px',
          borderBottom: '0.5px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Notebook</div>
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>
          Run ad-hoc trace-mcp queries. Read-only tools, no code execution.
        </div>
      </div>

      {/* Cells */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 80px' }}>
        {cells.map((cell, idx) => (
          <CellView
            key={cell.id}
            index={idx + 1}
            cell={cell}
            onChange={(patch) => updateCell(cell.id, patch)}
            onRun={() => runCell(cell.id)}
            onRemove={cells.length === 1 ? undefined : () => removeCell(cell.id)}
          />
        ))}

        <button
          type="button"
          onClick={addCell}
          aria-label="Add cell"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 8,
            padding: '7px 12px',
            borderRadius: 8,
            background: 'var(--fill-control)',
            border: '0.5px dashed var(--border)',
            boxShadow: 'var(--shadow-control)',
            color: 'var(--text-secondary)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <line x1="6" y1="1" x2="6" y2="11" />
            <line x1="1" y1="6" x2="11" y2="6" />
          </svg>
          Add cell
        </button>
      </div>
    </div>
  );
}

// ── Cell view ────────────────────────────────────────────────────────

function CellView({
  index,
  cell,
  onChange,
  onRun,
  onRemove,
}: {
  index: number;
  cell: Cell;
  onChange: (patch: Partial<Cell>) => void;
  onRun: () => void;
  onRemove?: () => void;
}) {
  const def = TOOL_BY_NAME[cell.tool];
  const running = cell.status === 'running';

  return (
    <div
      style={{
        marginBottom: 10,
        padding: '10px 12px',
        borderRadius: 10,
        background: 'var(--bg-grouped)',
        border: '0.5px solid var(--border)',
        boxShadow: 'var(--shadow-grouped)',
      }}
    >
      {/* Cell header — index, tool picker, run, remove */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-tertiary)',
            fontFamily: 'monospace',
            minWidth: 24,
          }}
        >
          [{index}]
        </span>
        <label htmlFor={`${cell.id}-tool`} style={{ position: 'absolute', left: -9999 }}>
          Tool
        </label>
        <select
          id={`${cell.id}-tool`}
          aria-label="Tool"
          value={cell.tool}
          onChange={(e) => {
            const next = e.target.value as ToolName;
            const nextDef = TOOL_BY_NAME[next];
            // Reset args when switching tool to avoid carrying stale keys.
            const args: Record<string, string> = {};
            for (const f of nextDef.fields) args[f.key] = '';
            onChange({ tool: next, args, status: 'idle', result: null, error: undefined });
          }}
          style={{
            fontSize: 11,
            padding: '4px 8px',
            borderRadius: 6,
            background: 'var(--fill-control)',
            color: 'var(--text-primary)',
            border: '0.5px solid var(--border)',
            outline: 'none',
            fontFamily: 'monospace',
          }}
        >
          {TOOLS.map((t) => (
            <option key={t.name} value={t.name}>
              {t.label}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 10, color: 'var(--text-tertiary)', flex: 1 }}>{def.description}</span>
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          style={{
            padding: '5px 14px',
            fontSize: 11,
            fontWeight: 500,
            borderRadius: 6,
            background: running ? 'var(--fill-control)' : 'var(--accent)',
            color: running ? 'var(--text-tertiary)' : '#fff',
            border: 'none',
            cursor: running ? 'default' : 'pointer',
            boxShadow: 'var(--shadow-control)',
            fontFamily: 'inherit',
          }}
        >
          {running ? 'Running…' : 'Run'}
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title="Remove cell"
            aria-label="Remove cell"
            style={{
              width: 22,
              height: 22,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 5,
              background: 'none',
              border: 'none',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <line x1="2" y1="2" x2="8" y2="8" />
              <line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        )}
      </div>

      {/* Fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {def.fields.map((f) => (
          <label
            key={f.key}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}
          >
            <span
              style={{
                color: 'var(--text-secondary)',
                minWidth: 90,
                textAlign: 'right',
                fontFamily: 'monospace',
                fontSize: 10,
              }}
            >
              {f.key}
            </span>
            <input
              type="text"
              value={cell.args[f.key] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) => onChange({ args: { ...cell.args, [f.key]: e.target.value } })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  onRun();
                }
              }}
              style={{
                flex: 1,
                padding: '5px 9px',
                fontSize: 11,
                borderRadius: 6,
                background: 'var(--fill-control)',
                color: 'var(--text-primary)',
                border: '0.5px solid var(--border)',
                outline: 'none',
                fontFamily: 'monospace',
              }}
            />
          </label>
        ))}
      </div>

      {/* Result area */}
      {cell.status === 'error' && (
        <div
          role="alert"
          style={{
            marginTop: 8,
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: 11,
            color: 'var(--destructive)',
            background: 'rgba(255,59,48,0.06)',
            border: '0.5px solid rgba(255,59,48,0.15)',
          }}
        >
          {cell.error}
        </div>
      )}
      {cell.status === 'running' && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Spinner />
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>Calling trace-mcp…</span>
        </div>
      )}
      {cell.status === 'ok' && cell.result !== null && (
        <ResultView result={cell.result} />
      )}
    </div>
  );
}

function ResultView({ result }: { result: unknown }) {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  // Truncate very large responses; the cell can be re-run if the user needs all of it.
  const MAX = 16_000;
  const truncated = text.length > MAX;
  const body = truncated ? `${text.slice(0, MAX)}\n… (truncated, ${text.length - MAX} more chars)` : text;
  return (
    <pre
      style={{
        marginTop: 8,
        padding: '8px 10px',
        background: 'var(--bg-code, rgba(0,0,0,0.06))',
        borderRadius: 6,
        fontSize: 10,
        lineHeight: '1.5',
        fontFamily: 'monospace',
        color: 'var(--text-primary)',
        border: '0.5px solid var(--border)',
        overflowX: 'auto',
        maxHeight: 360,
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {body}
    </pre>
  );
}

function Spinner() {
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        border: '1.5px solid var(--border)',
        borderTopColor: 'var(--accent)',
        animation: 'spin 0.8s linear infinite',
        display: 'inline-block',
      }}
      aria-hidden="true"
    />
  );
}

// Export the tool catalog for tests and any future tooling that needs it.
export const NOTEBOOK_TOOLS = TOOLS;
