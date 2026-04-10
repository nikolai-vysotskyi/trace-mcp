import { useState, useCallback, useRef } from 'react';

const BASE = 'http://127.0.0.1:3741';

export function GraphExplorer({ root }: { root: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [graphUrl, setGraphUrl] = useState<string | null>(null);
  const [stats, setStats] = useState<{ nodes: number; edges: number; communities: number } | null>(null);

  // Config
  const [scope, setScope] = useState('project');
  const [granularity, setGranularity] = useState<'file' | 'symbol'>('file');
  const [layout, setLayout] = useState<'force' | 'hierarchical' | 'radial'>('force');
  const [depth, setDepth] = useState(2);
  const [hideIsolated, setHideIsolated] = useState(true);
  const [symbolKinds, setSymbolKinds] = useState('');

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      project: root,
      scope,
      depth: String(depth),
      granularity,
      layout,
      hideIsolated: String(hideIsolated),
    });
    if (symbolKinds.trim()) params.set('symbolKinds', symbolKinds.trim());

    // First fetch JSON to get stats
    try {
      const jsonRes = await fetch(`${BASE}/api/projects/graph?${params}`);
      if (!jsonRes.ok) throw new Error((await jsonRes.json()).error || jsonRes.statusText);
      const data = await jsonRes.json();
      setStats({ nodes: data.nodes.length, edges: data.edges.length, communities: data.communities.length });
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
      return;
    }

    // Load HTML in iframe — embedded mode hides internal controls
    const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    params.set('embedded', 'true');
    params.set('theme', theme);
    setGraphUrl(`${BASE}/api/projects/graph/html?${params}`);
    setLoading(false);
  }, [root, scope, depth, granularity, layout, hideIsolated, symbolKinds]);

  // Auto-load on mount
  useState(() => { loadGraph(); });

  return (
    <div className="flex flex-col h-full gap-2" style={{ minHeight: 0 }}>
      {/* Toolbar row 1 */}
      <div className="flex items-center gap-1.5 flex-wrap shrink-0">
        <select value={granularity} onChange={(e) => setGranularity(e.target.value as any)}
          className="text-[11px] px-1.5 py-1 rounded-md"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
          <option value="file">File-level</option>
          <option value="symbol">Symbol-level</option>
        </select>

        <select value={layout} onChange={(e) => setLayout(e.target.value as any)}
          className="text-[11px] px-1.5 py-1 rounded-md"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
          <option value="force">Force</option>
          <option value="hierarchical">Hierarchical</option>
          <option value="radial">Radial</option>
        </select>

        <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}
          className="text-[11px] px-1.5 py-1 rounded-md"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
          <option value={1}>Depth 1</option>
          <option value={2}>Depth 2</option>
          <option value={3}>Depth 3</option>
        </select>

        <label className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={hideIsolated} onChange={(e) => setHideIsolated(e.target.checked)} />
          Hide isolated
        </label>

        <button onClick={loadGraph} disabled={loading}
          className="text-[11px] px-2.5 py-1 rounded-md font-medium disabled:opacity-40"
          style={{ background: 'var(--accent)', color: '#fff' }}>
          {loading ? 'Loading…' : 'Render'}
        </button>
      </div>

      {/* Toolbar row 2: scope + symbol kinds */}
      <div className="flex items-center gap-1.5 shrink-0">
        <input type="text" value={scope} onChange={(e) => setScope(e.target.value)}
          placeholder="Scope: project, src/, src/server.ts, *.ts"
          className="text-[11px] px-1.5 py-1 rounded-md flex-1"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          onKeyDown={(e) => { if (e.key === 'Enter') loadGraph(); }}
        />
        {granularity === 'symbol' && (
          <input type="text" value={symbolKinds} onChange={(e) => setSymbolKinds(e.target.value)}
            placeholder="Kinds: function,class,method"
            className="text-[11px] px-1.5 py-1 rounded-md w-[180px]"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            onKeyDown={(e) => { if (e.key === 'Enter') loadGraph(); }}
          />
        )}
      </div>

      {error && (
        <div className="text-[11px] px-2 py-1 rounded-md shrink-0" style={{ background: '#ff3b3020', color: '#ff3b30' }}>
          {error}
        </div>
      )}

      {/* Stats bar */}
      {stats && (
        <div className="text-[10px] flex gap-3 shrink-0" style={{ color: 'var(--text-tertiary)' }}>
          <span>{stats.nodes} nodes</span>
          <span>{stats.edges} edges</span>
          <span>{stats.communities} communities</span>
        </div>
      )}

      {/* Graph iframe */}
      <div className="flex-1 min-h-0 rounded-lg overflow-hidden">
        {graphUrl ? (
          <iframe
            ref={iframeRef}
            src={graphUrl}
            className="w-full h-full border-0"
          />
        ) : (
          <div className="flex items-center justify-center h-full text-xs rounded-lg"
            style={{ color: 'var(--text-tertiary)', background: 'var(--bg-secondary)' }}>
            {loading ? 'Building graph…' : 'Configure and click "Render"'}
          </div>
        )}
      </div>
    </div>
  );
}
