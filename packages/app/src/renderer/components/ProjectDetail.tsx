import { useState, useEffect, useCallback } from 'react';
import { StatusDot } from './StatusDot';

interface ProgressSnapshot {
  phase: string;
  current: number;
  total: number;
  percent: number;
}

interface ProjectStats {
  files: number;
  symbols: number;
  edges: number;
  lastIndexed?: string;
}

interface ProjectDetailProps {
  root: string;
  status?: string;
  progress?: ProgressSnapshot;
  onBack: () => void;
  onReindex: () => void;
}

const BASE = 'http://127.0.0.1:3741';

function projectName(root: string): string {
  return root.split(/[/\\]/).filter(Boolean).pop() || root;
}

function shortPath(root: string): string {
  return root
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^[A-Z]:\\Users\\[^\\]+/, '~');
}

function statusToDot(status?: string): 'active' | 'idle' | 'error' | 'disconnected' {
  if (status === 'indexing') return 'idle';
  if (status === 'error') return 'error';
  if (status === 'ready') return 'active';
  return 'disconnected';
}

export function ProjectDetail({ root, status, progress, onBack, onReindex }: ProjectDetailProps) {
  const [stats, setStats] = useState<ProjectStats | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      // Use the project-scoped MCP endpoint to get index health
      const res = await fetch(`${BASE}/api/projects/stats?project=${encodeURIComponent(root)}`);
      if (res.ok) {
        setStats(await res.json());
      }
    } catch {
      // stats are optional
    }
  }, [root]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats, status]); // refetch when status changes (e.g. after reindex)

  return (
    <div className="space-y-3">
      {/* Header with back button */}
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ color: 'var(--accent)' }}
        >
          ← Back
        </button>
      </div>

      {/* Project name & path */}
      <div>
        <div className="flex items-center gap-2">
          <StatusDot status={statusToDot(status)} />
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {projectName(root)}
          </h2>
        </div>
        <div className="text-[10px] mt-0.5 ml-4" style={{ color: 'var(--text-tertiary)' }}>
          {shortPath(root)}
        </div>
      </div>

      {/* Status */}
      <div
        className="px-3 py-2 rounded-md"
        style={{ background: 'var(--bg-secondary)' }}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Status</span>
          <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
            {status === 'indexing' ? 'Indexing…' : status === 'ready' ? 'Ready' : status || 'Unknown'}
          </span>
        </div>

        {status === 'indexing' && progress?.percent != null && (
          <div className="mt-2">
            <div className="flex justify-between text-[10px] mb-1" style={{ color: 'var(--text-tertiary)' }}>
              <span>{progress.phase}</span>
              <span>{progress.percent}%</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${progress.percent}%`, background: 'var(--accent)' }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Stats */}
      {stats && (
        <div
          className="px-3 py-2 rounded-md space-y-1.5"
          style={{ background: 'var(--bg-secondary)' }}
        >
          <StatRow label="Files indexed" value={stats.files.toLocaleString()} />
          <StatRow label="Symbols" value={stats.symbols.toLocaleString()} />
          <StatRow label="Edges (dependencies)" value={stats.edges.toLocaleString()} />
          {stats.lastIndexed && (
            <StatRow label="Last indexed" value={new Date(stats.lastIndexed).toLocaleString()} />
          )}
        </div>
      )}

      {/* Actions */}
      <div className="space-y-1.5">
        <button
          onClick={onReindex}
          disabled={status === 'indexing'}
          className="w-full text-xs px-3 py-2 rounded-md font-medium transition-colors disabled:opacity-40"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          {status === 'indexing' ? 'Indexing…' : 'Re-index project'}
        </button>
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
