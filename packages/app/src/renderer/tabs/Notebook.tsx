/**
 * Notebook scratchpad tab.
 *
 * A REPL-like surface for trace-mcp tools. Each "cell" is a (tool, args) pair
 * the user can run; the JSON response is rendered inline. NOT a code-execution
 * sandbox — cells dispatch a fixed, allow-listed set of trace-mcp tools only.
 *
 * On the macOS 26 layer (TRA-310): one 52px Toolbar carrying the project this
 * queries run against, content capped at 720px, and every control from
 * lattice/ui. Cells are local React state only; no persistence in this slice.
 */
import { useCallback, useState } from 'react';
import { Icon } from '../lattice/icons';
import {
  Button,
  Card,
  PopUpButton,
  Skeleton,
  Toolbar,
  ToolbarDivider,
} from '../lattice/ui';
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

/** Content measure, same as Project Overview — a form is not a table. */
const MEASURE = 720;

/** Trailing-aligned label column, macOS form style. Wide enough that no label
    in the tool catalog wraps to a second line and breaks its row's baseline. */
const LABEL_COL = 88;

const TOOL_OPTIONS = NOTEBOOK_TOOLS.map((t) => ({ value: t.name, label: t.label }));

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
    id: `cell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- local UI element id, not a security-sensitive value.
    tool: 'search',
    args: { query: '' },
    status: 'idle',
    result: null,
  };
}

/** Head-truncated so the tail — the part that distinguishes siblings — stays. */
function projectName(root: string): string {
  const parts = root.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? root;
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
  const [scrolled, setScrolled] = useState(false);

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
        updateCell(id, {
          status: 'error',
          // Says what to do next, not which form control failed validation.
          error: `Enter a ${missing.label.toLowerCase()} to run this cell.`,
          result: null,
        });
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
      className="flex flex-col h-full overflow-hidden"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* ── Toolbar ──────────────────────────────────────────────────────
          The surface never said which project it queries. It does now. */}
      <Toolbar scrolled={scrolled} className="gap-3">
        <div className="min-w-0 flex-1">
          <h2
            className="text-[13px] leading-4 font-semibold truncate"
            style={{ color: 'var(--label)' }}
          >
            Notebook
          </h2>
          <p
            className="text-[11px] leading-[13px] truncate"
            style={{ color: 'var(--label-secondary)' }}
            title={root}
          >
            {projectName(root)}
          </p>
        </div>
        <ToolbarDivider />
        <span
          className="shrink-0 text-[11px] leading-[13px] tabular-nums"
          style={{ color: 'var(--label-secondary)' }}
        >
          {cells.length === 1 ? '1 cell' : `${cells.length} cells`}
        </span>
      </Toolbar>

      {/* ── Cells ────────────────────────────────────────────────────── */}
      <div
        className="flex-1 overflow-auto"
        onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 0)}
      >
        <div
          className="flex flex-col gap-3 px-4 py-4 mx-auto w-full"
          style={{ maxWidth: MEASURE }}
        >
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

          <div className="flex">
            <Button icon="add" onClick={addCell} aria-label="Add cell">
              Add cell
            </Button>
          </div>
        </div>
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
    <Card>
      {/* Cell header — index, tool picker, run, remove. Run is `bordered`:
          one accent capsule per cell would put N prominent actions on one
          surface, which is the rule this screen used to break hardest. */}
      <div
        className="flex items-center gap-2 px-3"
        style={{ minHeight: 40, borderBottom: '0.5px solid var(--separator)' }}
      >
        <span
          className="shrink-0 text-[11px] leading-[13px] tabular-nums"
          style={{ color: 'var(--label-secondary)', minWidth: 16 }}
        >
          {index}
        </span>
        <PopUpButton
          options={TOOL_OPTIONS}
          value={cell.tool}
          aria-label="Tool"
          onChange={(next) => {
            const nextDef = TOOL_BY_NAME[next];
            // Reset args when switching tool to avoid carrying stale keys.
            const args: Record<string, string> = {};
            for (const f of nextDef.fields) args[f.key] = '';
            onChange({ tool: next, args, status: 'idle', result: null, error: undefined });
          }}
        />
        <span className="flex-1" />
        <Button onClick={onRun} disabled={running} className={running ? 'is-status' : undefined}>
          {running ? 'Running…' : 'Run'}
        </Button>
        {onRemove && (
          <Button
            variant="icon"
            icon="close"
            onClick={onRemove}
            aria-label={`Remove cell ${index}`}
            title="Remove cell"
          />
        )}
      </div>

      {/* Fields — the human label from the tool catalog, at reading size, in
          the UI face. The old rows showed the raw arg key in 10px monospace. */}
      <div className="flex flex-col gap-2 px-3 py-3">
        {def.fields.map((f) => (
          <label key={f.key} className="flex items-center gap-3">
            <span
              className="shrink-0 text-[13px] leading-4 text-right"
              style={{ color: 'var(--label-secondary)', width: LABEL_COL }}
            >
              {f.label}
            </span>
            <input
              type="text"
              className="lx-input mono"
              value={cell.args[f.key] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) => onChange({ args: { ...cell.args, [f.key]: e.target.value } })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  onRun();
                }
              }}
            />
          </label>
        ))}
      </div>

      {/* Result area. The idle state is a plain caption, NOT a well: rendered
          as a sunken box it read as a third, oversized text field. */}
      <div className="px-3 pb-3">
        {cell.status === 'idle' && (
          <p
            className="text-[11px] leading-[13px]"
            style={{ color: 'var(--label-secondary)', paddingLeft: LABEL_COL + 12 }}
          >
            {def.description}
          </p>
        )}
        {cell.status === 'running' && (
          <ResultBox>
            <div role="status" aria-label="Running" className="flex flex-col gap-2">
              <Skeleton width="62%" height={11} />
              <Skeleton width="86%" height={11} />
              <Skeleton width="44%" height={11} />
            </div>
          </ResultBox>
        )}
        {cell.status === 'error' && (
          /* The same well as every other cell state, so the four states share
             one geometry. NOT a red-tinted bar: --status-red on a tint of
             itself measured 4.31:1 in light and failed AA, while the token is
             verified at 4.94:1 on --surface-sunken. The glyph, not the fill,
             is what makes this read as an error. */
          <ResultBox>
            <div role="alert" className="flex items-center gap-2" style={{ color: 'var(--status-red)' }}>
              <Icon name="warning" size={14} />
              {cell.error}
            </div>
          </ResultBox>
        )}
        {cell.status === 'ok' && cell.result !== null && <ResultView result={cell.result} />}
      </div>
    </Card>
  );
}

/** The result well. Sunken, hairline, 8px — the same box in every cell state. */
function ResultBox({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <div
      className="flex flex-col justify-center text-[13px] leading-4"
      style={{
        minHeight: 40,
        padding: '10px 12px',
        borderRadius: 'var(--radius-input)',
        background: 'var(--surface-sunken)',
        boxShadow: 'inset 0 0 0 0.5px var(--separator)',
        color: muted ? 'var(--label-secondary)' : 'var(--label)',
      }}
    >
      {children}
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
      className="text-[11px] leading-4 overflow-auto"
      style={{
        margin: 0,
        minHeight: 40,
        padding: '10px 12px',
        borderRadius: 'var(--radius-input)',
        background: 'var(--surface-sunken)',
        boxShadow: 'inset 0 0 0 0.5px var(--separator)',
        fontFamily: 'var(--font-mono)',
        color: 'var(--label)',
        maxHeight: 360,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {body}
    </pre>
  );
}
