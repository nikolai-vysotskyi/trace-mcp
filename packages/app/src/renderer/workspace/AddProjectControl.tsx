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
        <div className="flex flex-col items-center justify-center gap-2 py-8">
          <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            No projects registered yet
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            or drop a folder anywhere in this window
          </span>
          <div className="flex items-center gap-1 mt-2">
            <button
              type="button"
              disabled={adding}
              onClick={() => void handlePickFolder()}
              className="text-xs px-3 py-1.5 rounded-md font-medium transition-opacity disabled:opacity-40"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              + Add project
            </button>
            <button
              type="button"
              disabled={adding}
              onClick={() => setShowPathInput((v) => !v)}
              className="text-xs px-2 py-1.5 rounded-md font-medium transition-colors hover:bg-[var(--bg-active)]"
              style={{ color: 'var(--accent)', border: '0.5px solid var(--border)' }}
            >
              Enter path…
            </button>
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
  return (
    <>
      <DragOverlay visible={dragHover} />
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={adding}
          onClick={() => void handlePickFolder()}
          className="text-xs px-2 py-1 rounded-md font-medium transition-opacity disabled:opacity-40"
          style={{ background: 'var(--accent)', color: '#fff' }}
          title="Choose a folder"
        >
          + Add
        </button>
        <button
          type="button"
          disabled={adding}
          onClick={() => setShowPathInput((v) => !v)}
          className="text-xs px-2 py-1 rounded-md font-medium transition-colors hover:bg-[var(--bg-active)]"
          style={{ color: 'var(--accent)', border: '0.5px solid var(--border)' }}
          title="Enter path manually"
        >
          Path
        </button>
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
          background: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          minWidth: 220,
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={onSubmit}
        className="text-xs px-2 py-1 rounded-md font-medium disabled:opacity-40"
        style={{ background: 'var(--accent)', color: '#fff' }}
      >
        OK
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onCancel}
        className="text-xs px-2 py-1 rounded-md"
        style={{ color: 'var(--text-secondary)' }}
      >
        Cancel
      </button>
    </div>
  );
}

function DragOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
      style={{
        background: 'rgba(10, 132, 255, 0.10)',
        border: '2px dashed var(--accent)',
      }}
    >
      <div
        className="px-4 py-2 rounded-lg text-sm font-medium"
        style={{
          background: 'var(--bg-secondary)',
          color: 'var(--accent)',
          border: '0.5px solid var(--border)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
        }}
      >
        Drop folder to add as project
      </div>
    </div>
  );
}
