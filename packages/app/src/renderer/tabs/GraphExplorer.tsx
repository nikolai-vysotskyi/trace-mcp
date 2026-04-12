import { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';

const BASE = 'http://127.0.0.1:3741';

export interface GraphExplorerHandle {
  focusFile: (filePath: string) => void;
}

export interface GraphSettings {
  scope: string;
  granularity: 'file' | 'symbol';
  layout: 'force' | 'hierarchical' | 'radial';
  depth: number;
  highlightDepth: number;
  hideIsolated: boolean;
  symbolKinds: string;
  maxNodes: string;
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  scope: 'project',
  granularity: 'file',
  layout: 'force',
  depth: 2,
  highlightDepth: 2,
  hideIsolated: true,
  symbolKinds: '',
  maxNodes: '',
};

interface GraphExplorerProps {
  root: string;
  settings: GraphSettings;
  onSettingsChange: (patch: Partial<GraphSettings>) => void;
}

export const GraphExplorer = forwardRef<GraphExplorerHandle, GraphExplorerProps>(function GraphExplorer({ root, settings, onSettingsChange }, ref) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [graphUrl, setGraphUrl] = useState<string | null>(null);
  const [stats, setStats] = useState<{ nodes: number; edges: number; communities: number } | null>(null);

  // Destructure settings for convenience
  const { scope, granularity, layout, depth, highlightDepth, hideIsolated, symbolKinds, maxNodes } = settings;
  const setScope = (v: string) => onSettingsChange({ scope: v });
  const setGranularity = (v: GraphSettings['granularity']) => onSettingsChange({ granularity: v });
  const setLayout = (v: GraphSettings['layout']) => onSettingsChange({ layout: v });
  const setDepth = (v: number) => onSettingsChange({ depth: v });
  const setHighlightDepth = (v: number) => onSettingsChange({ highlightDepth: v });
  const setHideIsolated = (v: boolean) => onSettingsChange({ hideIsolated: v });
  const setSymbolKinds = (v: string) => onSettingsChange({ symbolKinds: v });
  const setMaxNodes = (v: string) => onSettingsChange({ maxNodes: v });
  const isScopedView = scope.trim() !== '' && scope.trim() !== 'project';

  // Federation repos for quick scope switching
  const [fedRepos, setFedRepos] = useState<Array<{ name: string; repoRoot: string; services: number; endpoints: number }>>([]);
  useEffect(() => {
    fetch(`${BASE}/api/projects/federation`)
      .then((r) => r.ok ? r.json() : { repos: [] })
      .then((data) => setFedRepos(data.repos ?? []))
      .catch(() => {});
  }, []);

  // Refs for debounced values — loadGraph reads these instead of raw state
  // so it doesn't re-create on every keystroke
  const scopeRef = useRef(scope);
  const symbolKindsRef = useRef(symbolKinds);
  const maxNodesRef = useRef(maxNodes);
  const highlightDepthRef = useRef(highlightDepth);
  scopeRef.current = scope;
  symbolKindsRef.current = symbolKinds;
  maxNodesRef.current = maxNodes;
  highlightDepthRef.current = highlightDepth;

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);

    const curScope = scopeRef.current;
    const curSymbolKinds = symbolKindsRef.current;
    const curMaxNodes = maxNodesRef.current;
    const curHighlightDepth = highlightDepthRef.current;

    const params = new URLSearchParams({
      project: root,
      scope: curScope,
      depth: String(depth),
      granularity,
      layout,
      hideIsolated: String(hideIsolated),
      highlightDepth: String(curHighlightDepth),
    });
    if (curSymbolKinds.trim()) params.set('symbolKinds', curSymbolKinds.trim());
    if (curMaxNodes.trim()) params.set(granularity === 'symbol' ? 'maxNodes' : 'maxFiles', curMaxNodes.trim());

    // Single request: fetch HTML and extract stats from response headers
    // (avoids running buildGraphData twice — was the #1 server-side bottleneck)
    const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    params.set('embedded', 'true');
    params.set('theme', theme);

    try {
      const htmlRes = await fetch(`${BASE}/api/projects/graph/html?${params}`);
      if (!htmlRes.ok) {
        const errText = await htmlRes.text();
        throw new Error(errText || htmlRes.statusText);
      }
      // Extract stats from headers
      const nNodes = parseInt(htmlRes.headers.get('X-Graph-Nodes') || '0', 10);
      const nEdges = parseInt(htmlRes.headers.get('X-Graph-Edges') || '0', 10);
      const nCommunities = parseInt(htmlRes.headers.get('X-Graph-Communities') || '0', 10);
      setStats({ nodes: nNodes, edges: nEdges, communities: nCommunities });

      // Create blob URL from HTML response to load into iframe
      const blob = new Blob([await htmlRes.arrayBuffer()], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);
      iframeReady.current = false;
      setGraphUrl(blobUrl);
    } catch (e: any) {
      setError(e.message);
      setGraphUrl(null);
      setStats(null);
    }
    setLoading(false);
  }, [root, depth, granularity, layout, hideIsolated]);

  // Expose focusFile to parent — waits for iframe load if needed
  const iframeReady = useRef(false);
  const pendingFocus = useRef<string | null>(null);

  const sendFocusToIframe = useCallback((filePath: string) => {
    if (iframeReady.current && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'focusNode', id: filePath }, '*');
    } else {
      pendingFocus.current = filePath;
    }
  }, []);

  useImperativeHandle(ref, () => ({
    focusFile: sendFocusToIframe,
  }), [sendFocusToIframe]);

  // Reload graph on system theme change
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (graphUrl) loadGraph(); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [graphUrl, loadGraph]);

  // Auto-reload: immediate for dropdowns/checkboxes, debounced for text inputs
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const [debouncedScope, setDebouncedScope] = useState(scope);
  const [debouncedSymbolKinds, setDebouncedSymbolKinds] = useState(symbolKinds);
  const [debouncedMaxNodes, setDebouncedMaxNodes] = useState(maxNodes);

  // Debounce text inputs (500ms)
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedScope(scope);
      setDebouncedSymbolKinds(symbolKinds);
      setDebouncedMaxNodes(maxNodes);
    }, 500);
    return () => clearTimeout(debounceRef.current);
  }, [scope, symbolKinds, maxNodes]);

  // Auto-reload on parameter changes (except highlightDepth which is client-only)
  useEffect(() => {
    loadGraph();
  }, [loadGraph, depth, granularity, layout, hideIsolated, debouncedScope, debouncedSymbolKinds, debouncedMaxNodes]);

  // highlightDepth change: send to iframe without full reload
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'setHighlightDepth', depth: highlightDepth }, '*');
  }, [highlightDepth]);

  // Flush pending focus when iframe finishes loading
  const onIframeLoad = useCallback(() => {
    // Small delay so the graph JS initializes (d3 simulation, event listeners)
    setTimeout(() => {
      iframeReady.current = true;
      if (pendingFocus.current) {
        sendFocusToIframe(pendingFocus.current);
        pendingFocus.current = null;
      }
    }, 300);
  }, [sendFocusToIframe]);

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

        {isScopedView && (
          <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}
            title="Expansion depth from scoped files"
            className="text-[11px] px-1.5 py-1 rounded-md"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
            <option value={1}>Depth 1</option>
            <option value={2}>Depth 2</option>
            <option value={3}>Depth 3</option>
          </select>
        )}

        <select value={highlightDepth} onChange={(e) => setHighlightDepth(Number(e.target.value))}
          title="How many levels of connections to highlight when clicking a node"
          className="text-[11px] px-1.5 py-1 rounded-md"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
          {[1,2,3,4,5,6,7,8,9,10].map(n => (
            <option key={n} value={n}>Highlight {n}</option>
          ))}
        </select>

        <label className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={hideIsolated} onChange={(e) => setHideIsolated(e.target.checked)} />
          Hide isolated
        </label>

        {loading && (
          <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Loading…</span>
        )}
      </div>

      {/* Toolbar row 2: scope + symbol kinds + max nodes */}
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
        <input type="text" value={maxNodes} onChange={(e) => setMaxNodes(e.target.value)}
          placeholder={granularity === 'symbol' ? 'Max nodes' : 'Max files'}
          className="text-[11px] px-1.5 py-1 rounded-md w-[90px]"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          onKeyDown={(e) => { if (e.key === 'Enter') loadGraph(); }}
        />
      </div>

      {/* Federation quick-scope chips */}
      {fedRepos.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap shrink-0">
          <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Federation:</span>
          {fedRepos.map((repo) => (
            <button key={repo.name}
              onClick={() => setScope(`federation:${repo.name}`)}
              title={`${repo.repoRoot}\n${repo.services} services, ${repo.endpoints} endpoints`}
              className="text-[10px] px-1.5 py-0.5 rounded-full cursor-pointer transition-colors"
              style={{
                background: scope === `federation:${repo.name}` ? 'var(--accent, #007aff)' : 'var(--bg-secondary)',
                color: scope === `federation:${repo.name}` ? '#fff' : 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}>
              {repo.name}
            </button>
          ))}
        </div>
      )}

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
            onLoad={onIframeLoad}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-xs rounded-lg"
            style={{ color: 'var(--text-tertiary)', background: 'var(--bg-secondary)' }}>
            {loading ? 'Building graph…' : 'Loading…'}
          </div>
        )}
      </div>
    </div>
  );
});
