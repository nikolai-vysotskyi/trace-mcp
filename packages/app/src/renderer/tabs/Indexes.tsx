import { useState } from 'react';
import { ProjectRow } from '../components/ProjectRow';
import { useDaemon } from '../hooks/useDaemon';
import { removeRecentProject } from '../App';

interface IndexesProps {
  onOpenProject: (root: string) => void;
}

export function Indexes({ onOpenProject }: IndexesProps) {
  const { projects, loading, connected, restarting, addProject, removeProject, reindexProject, restartDaemon } = useDaemon();
  const [showAddInput, setShowAddInput] = useState(false);
  const [addPath, setAddPath] = useState('');

  const handleAddManual = () => {
    if (!showAddInput) {
      setShowAddInput(true);
      return;
    }
    if (addPath.trim()) {
      addProject(addPath.trim());
      setAddPath('');
      setShowAddInput(false);
    }
  };

  const handleAddFolder = async () => {
    const folder = await window.electronAPI?.selectFolder();
    if (folder) {
      addProject(folder);
    }
  };

  if (!connected && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          Daemon not reachable
        </div>
        <button
          onClick={() => restartDaemon()}
          disabled={restarting}
          className="text-[11px] px-4 py-1.5 rounded-lg font-medium transition-all"
          style={{
            background: 'var(--fill-control)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            color: 'var(--accent)',
            border: '0.5px solid var(--border)',
            boxShadow: 'var(--shadow-control)',
            cursor: restarting ? 'default' : 'pointer',
            opacity: restarting ? 0.6 : 1,
          }}
        >
          {restarting ? 'Starting…' : 'Restart Daemon'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Projects
        </h2>
        <div className="flex gap-1">
          <button
            onClick={handleAddFolder}
            className="text-xs px-2 py-1 rounded-md font-medium transition-colors"
            style={{ background: 'var(--accent)', color: '#fff' }}
            title="Choose folder"
          >
            + Add
          </button>
          <button
            onClick={handleAddManual}
            className="text-xs px-2 py-1 rounded-md font-medium transition-colors"
            style={{ color: 'var(--accent)', border: '1px solid var(--accent)' }}
            title="Enter path manually"
          >
            Path
          </button>
        </div>
      </div>

      {showAddInput && (
        <div className="flex gap-1">
          <input
            autoFocus
            type="text"
            placeholder="/path/to/project"
            value={addPath}
            onChange={(e) => setAddPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddManual(); if (e.key === 'Escape') { setShowAddInput(false); setAddPath(''); } }}
            className="flex-1 text-xs px-2 py-1 rounded-md outline-none"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          />
          <button
            onClick={handleAddManual}
            className="text-xs px-2 py-1 rounded-md font-medium"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            OK
          </button>
          <button
            onClick={() => { setShowAddInput(false); setAddPath(''); }}
            className="text-xs px-2 py-1 rounded-md"
            style={{ color: 'var(--text-secondary)' }}
          >
            Cancel
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-xs py-4 text-center" style={{ color: 'var(--text-tertiary)' }}>
          Loading…
        </div>
      ) : projects.length === 0 ? (
        <div className="text-xs py-4 text-center" style={{ color: 'var(--text-secondary)' }}>
          No projects registered yet.
          <br />
          <span style={{ color: 'var(--text-tertiary)' }}>
            Click "+ Add" or run: trace-mcp init
          </span>
        </div>
      ) : (
        <div className="space-y-1">
          {projects.map((p) => (
            <ProjectRow
              key={p.root}
              root={p.root}
              status={p.status}
              error={p.error}
              progress={p.progress}
              onReindex={() => reindexProject(p.root)}
              onRemove={() => { removeProject(p.root); removeRecentProject(p.root); }}
              onClick={() => onOpenProject(p.root)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
