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
import {
  NOTEBOOK_TOOLS,
  TOOL_BY_NAME,
  defaultNotebookClient,
  type NotebookClient,
  type ToolName,
} from './notebook-runtime';

// Re-export the pure runtime so existing imports (tests, future tooling)
// keep working unchanged.
export { NOTEBOOK_TOOLS, defaultNotebookClient } from './notebook-runtime';
export type { NotebookClient, ToolName } from './notebook-runtime';

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
          {NOTEBOOK_TOOLS.map((t) => (
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

