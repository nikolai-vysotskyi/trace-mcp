import { useState, useEffect, useCallback } from 'react';
import { StatusDot } from '../components/StatusDot';
import { useDaemon } from '../hooks/useDaemon';

interface ProjectStats {
  files: number;
  symbols: number;
  edges: number;
  lastIndexed?: string;
}

const BASE = 'http://127.0.0.1:3741';

function shortPath(root: string): string {
  return root.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

export function ProjectOverview({ root }: { root: string }) {
  const { projects, reindexProject } = useDaemon();
  const project = projects.find((p) => p.root === root);
  const status = project?.status ?? 'unknown';
  const progress = project?.progress;

  const [stats, setStats] = useState<ProjectStats | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/projects/stats?project=${encodeURIComponent(root)}`);
      if (res.ok) setStats(await res.json());
    } catch { /* optional */ }
  }, [root]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats, status]);

  const statusDot = status === 'indexing' ? 'idle' as const
    : status === 'error' ? 'error' as const
    : status === 'ready' ? 'active' as const
    : 'disconnected' as const;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <StatusDot status={statusDot} />
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            {root.split('/').filter(Boolean).pop()}
          </h2>
        </div>
        <div className="text-[11px] mt-0.5 ml-5" style={{ color: 'var(--text-tertiary)' }}>
          {shortPath(root)}
        </div>
      </div>

      {/* Status card */}
      <div className="px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Status</span>
          <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
            {status === 'indexing' ? 'Indexing…' : status === 'ready' ? 'Ready' : status}
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

      {/* Stats card */}
      {stats && (
        <div className="px-3 py-2.5 rounded-lg space-y-2" style={{ background: 'var(--bg-secondary)' }}>
          <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
            Index Stats
          </div>
          <Row label="Files indexed" value={stats.files.toLocaleString()} />
          <Row label="Symbols" value={stats.symbols.toLocaleString()} />
          <Row label="Edges (dependencies)" value={stats.edges.toLocaleString()} />
          {stats.lastIndexed && (
            <Row label="Last indexed" value={new Date(stats.lastIndexed).toLocaleString()} />
          )}
        </div>
      )}

      {/* Actions */}
      <div className="space-y-2">
        <button
          onClick={() => reindexProject(root)}
          disabled={status === 'indexing'}
          className="w-full text-xs px-3 py-2 rounded-lg font-medium transition-colors disabled:opacity-40"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          {status === 'indexing' ? 'Indexing…' : 'Re-index project'}
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="text-[11px] font-medium tabular-nums" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
