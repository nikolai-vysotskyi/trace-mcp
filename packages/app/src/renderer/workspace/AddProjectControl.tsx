/**
 * AddProjectControl — unified add-project UX for the Workspace tab.
 *
 *  - Primary button → native folder picker (`window.electronAPI.selectFolder`)
 *  - Chevron menu  → inline manual path input
 *  - Window-wide drag-and-drop overlay → drop a folder anywhere in the tab
 *
 * Two visual variants: `compact` (toolbar pill, default) and `empty-state`
 * (large CTA centred in the tab).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../lattice/icons';
import { Button } from '../lattice/ui';

export interface AddProjectControlProps {
  onAdd: (root: string) => Promise<void> | void;
  variant?: 'compact' | 'empty-state';
}

type ElectronFileWithPath = File & { path?: string };

function extractDroppedPath(items: DataTransferItemList | undefined, files: FileList): string | null {
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file') {
        const f = it.getAsFile() as ElectronFileWithPath | null;
        if (f?.path) return f.path;
      }
    }
  }
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as ElectronFileWithPath;
    if (f.path) return f.path;
  }
  return null;
}

export function AddProjectControl({ onAdd, variant = 'compact' }: AddProjectControlProps) {
  const [showPathInput, setShowPathInput] = useState(false);
  const [path, setPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [dragHover, setDragHover] = useState(false);
  const dragDepth = useRef(0);

  const submit = useCallback(
    async (root: string) => {
      const trimmed = root.trim();
      if (!trimmed || adding) return;
      setAdding(true);
      try {
        await onAdd(trimmed);
        setPath('');
        setShowPathInput(false);
      } finally {
        setAdding(false);
      }
    },
    [adding, onAdd],
  );

  const handlePickFolder = useCallback(async () => {
    const folder = await window.electronAPI?.selectFolder();
    if (folder) await submit(folder);
  }, [submit]);

  // Window-level drag overlay. dragenter/leave can fire multiple times as the
  // pointer crosses nested elements; depth counter keeps the overlay stable.
  useEffect(() => {
    const onDragEnter = (e: globalThis.DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragHover(true);
    };
    const onDragOver = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const onDragLeave = (e: globalThis.DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragHover(false);
    };
    const onDrop = (e: globalThis.DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragHover(false);
      const root = extractDroppedPath(e.dataTransfer.items, e.dataTransfer.files);
      if (root) void submit(root);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [submit]);

  // ── Empty-state variant ─────────────────────────────────────────────────
  if (variant === 'empty-state') {
    return (
      <>
        <DragOverlay visible={dragHover} />
        {/* Empty-state anatomy: 32px monochrome glyph, one 17/600 line, one
            13px sentence, one primary action. */}
        <div className="flex flex-col items-center justify-center h-full gap-2 py-8">
          <span style={{ color: 'var(--label-secondary)' }}>
            <Icon name="folder_open" size={32} />
          </span>
          <span
            style={{ fontSize: 17, lineHeight: '22px', fontWeight: 600, color: 'var(--label)' }}
          >
            No projects yet
          </span>
          <span className="text-[13px] text-center" style={{ color: 'var(--label-secondary)' }}>
            Add a folder to index it, or drop one anywhere in this window.
          </span>
          <div className="flex items-center gap-2 mt-2">
            <Button
              variant="prominent"
              size="large"
              disabled={adding}
              onClick={() => void handlePickFolder()}
            >
              Add project
            </Button>
            <Button size="large" disabled={adding} onClick={() => setShowPathInput((v) => !v)}>
              Enter path…
            </Button>
          </div>
          {showPathInput && (
            <PathInput
              value={path}
              disabled={adding}
              onChange={setPath}
              onSubmit={() => void submit(path)}
              onCancel={() => {
                setShowPathInput(false);
                setPath('');
              }}
            />
          )}
        </div>
      </>
    );
  }

  // ── Compact variant ────────────────────────────────────────────────────
  //
  // One prominent action per region: a single accent capsule, with manual path
  // entry folded into its chevron rather than standing next to it as a second,
  // differently-weighted button.
  return (
    <>
      <DragOverlay visible={dragHover} />
      <div className="relative flex items-center">
        <button
          type="button"
          disabled={adding}
          onClick={() => void handlePickFolder()}
          // 13px, not 11: this is a 24px control, and every other regular-tier
          // control on this row (Filter, the search field) labels at 13px. The
          // row's one prominent action was reading two steps quieter than the
          // secondary button beside it.
          className="h-6 px-2 text-[13px] font-medium transition-opacity disabled:opacity-40"
          style={{
            // --accent-fill, not --accent: a white label on --accent measures
            // 3.65:1 in dark. Split radii, so this cannot be a Button capsule.
            background: 'var(--accent-fill)',
            color: 'var(--on-accent)',
            borderRadius: '999px 0 0 999px',
          }}
          title="Choose a folder to index"
        >
          + Add
        </button>
        <button
          type="button"
          disabled={adding}
          aria-label="Add a project by path"
          aria-expanded={showPathInput}
          onClick={() => setShowPathInput((v) => !v)}
          className="h-6 w-6 inline-flex items-center justify-center transition-opacity disabled:opacity-40"
          style={{
            background: 'var(--accent-fill)',
            color: 'var(--on-accent)',
            borderRadius: '0 999px 999px 0',
            // The divider is the label colour at low alpha, not a raw white:
            // on --accent-fill only --on-accent is a verified pair.
            boxShadow: 'inset 1px 0 0 color-mix(in oklab, var(--on-accent) 25%, transparent)',
          }}
          title="Enter path manually"
        >
          {/* An icon, not the text character ⌄ — a font glyph cannot hold a
              1.5px stroke next to the real icons on this row. */}
          <Icon name="expand_more" size={14} />
        </button>
        {showPathInput && (
          // A popover under the chevron — the toolbar row must not grow a
          // 220px input and rewrap every other control.
          <div
            className="absolute right-0 top-8 z-40 p-2 rounded-[10px]"
            style={{
              background: 'var(--surface)',
              border: '0.5px solid var(--separator)',
              boxShadow: 'var(--shadow-panel)',
            }}
          >
            <PathInput
              value={path}
              disabled={adding}
              onChange={setPath}
              onSubmit={() => void submit(path)}
              onCancel={() => {
                setShowPathInput(false);
                setPath('');
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}

interface PathInputProps {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function PathInput({ value, disabled, onChange, onSubmit, onCancel }: PathInputProps) {
  return (
    <div className="flex gap-1">
      <input
        // biome-ignore lint/a11y/noAutofocus: opens on user action; autofocus is expected for inline editors.
        autoFocus
        type="text"
        disabled={disabled}
        value={value}
        placeholder="/path/to/project"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
          if (e.key === 'Escape') onCancel();
        }}
        className="flex-1 text-xs px-2 py-1 rounded-md outline-none disabled:opacity-40"
        style={{
          background: 'var(--fill-quaternary)',
          color: 'var(--label)',
          border: '1px solid var(--separator)',
          minWidth: 220,
        }}
      />
      {/* "Add" names the outcome; "OK" names nothing. */}
      <Button variant="prominent" size="small" disabled={disabled} onClick={onSubmit}>
        Add
      </Button>
      <Button variant="plain" size="small" disabled={disabled} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function DragOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
      style={{
        background: 'color-mix(in oklab, var(--accent) 10%, transparent)',
        border: '2px dashed var(--accent)',
      }}
    >
      <div
        className="px-4 py-2 rounded-lg text-sm font-medium"
        style={{
          background: 'var(--fill-quaternary)',
          color: 'var(--accent)',
          border: '0.5px solid var(--separator)',
          boxShadow: 'var(--shadow-panel)',
        }}
      >
        Drop folder to add as project
      </div>
    </div>
  );
}
