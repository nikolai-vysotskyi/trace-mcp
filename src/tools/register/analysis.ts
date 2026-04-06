import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../../server-types.js';
import { getImplementations, getApiSurface, getPluginRegistry, getTypeHierarchy, getDeadExports, getDependencyGraph, getUntestedExports, selfAudit } from '../introspect.js';
import { getCouplingMetrics, getDependencyCycles, getPageRank, getExtractionCandidates, getRepoHealth } from '../graph-analysis.js';
import { getHotspots } from '../git-analysis.js';
import { getLayerViolations, detectLayerPreset, type LayerDefinition } from '../layer-violations.js';
import { getFileOwnership, getSymbolOwnership } from '../git-ownership.js';
import { getComplexityTrend } from '../complexity-trend.js';
import { getCouplingTrend, getSymbolComplexityTrend } from '../history.js';

export function registerAnalysisTools(server: McpServer, ctx: ServerContext): void {
  const { store, registry, projectRoot, guardPath, j, jh } = ctx;

  // Reconstruct frameworkNames from registry for get_plugin_registry
  const frameworkNames = new Set(
    registry.getAllFrameworkPlugins().map((p) => p.manifest.name),
  );

  // --- Self-Development / Introspection Tools ---

  server.tool(
    'get_implementations',
    'Find all classes that implement or extend a given interface or base class',
    {
      name: z.string().max(256).describe('Interface or base class name (e.g. UserRepositoryInterface)'),
    },
    async ({ name }) => {
      const result = getImplementations(store, name);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_api_surface',
    'List all exported symbols (public API) of a file or matching files',
    {
      file_pattern: z.string().max(512).optional().describe('Glob-style pattern to filter files (e.g. src/services/*.ts)'),
    },
    async ({ file_pattern }) => {
      const result = getApiSurface(store, file_pattern);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_plugin_registry',
    'List all registered indexer plugins and the edge types they emit',
    {},
    async () => {
      const result = getPluginRegistry(store, registry, frameworkNames);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_type_hierarchy',
    'Walk TypeScript class/interface hierarchy: ancestors (what it extends/implements) and descendants (what extends/implements it)',
    {
      name: z.string().max(256).describe('Class or interface name (e.g. "LanguagePlugin", "Store")'),
      max_depth: z.number().int().min(1).max(20).optional().describe('Max traversal depth (default 10)'),
    },
    async ({ name, max_depth }) => {
      const result = getTypeHierarchy(store, name, max_depth ?? 10);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_dead_exports',
    'Find exported symbols never imported by any other file — dead code candidates',
    {
      file_pattern: z.string().max(512).optional().describe('Filter files by glob pattern (e.g. "src/tools/*.ts")'),
    },
    async ({ file_pattern }) => {
      const result = getDeadExports(store, file_pattern);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_import_graph',
    'Show file-level dependency graph: what a file imports and what imports it (requires reindex for ESM edge resolution)',
    {
      file_path: z.string().max(512).describe('Relative file path to analyze (e.g. "src/server.ts")'),
    },
    async ({ file_path }) => {
      const blocked = guardPath(file_path);
      if (blocked) return blocked;
      const result = getDependencyGraph(store, file_path);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_untested_exports',
    'Find exported public symbols with no matching test file — test coverage gaps',
    {
      file_pattern: z.string().max(512).optional().describe('Filter by file glob pattern (e.g. "src/tools/%")'),
    },
    async ({ file_pattern }) => {
      const result = getUntestedExports(store, file_pattern);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );


  server.tool('self_audit', 'Dead code & coverage audit: dead exports, untested public symbols, heritage debt. Use for cleanup and coverage tasks.', {}, async () => {
    return { content: [{ type: 'text', text: j(selfAudit(store)) }] };
  });

  // --- Graph Analysis Tools ---

  server.tool(
    'get_coupling',
    'Coupling analysis: afferent (Ca), efferent (Ce), instability index per file. Shows which modules are stable vs unstable',
    {
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default: all)'),
      assessment: z.enum(['stable', 'neutral', 'unstable', 'isolated']).optional().describe('Filter by stability assessment'),
    },
    async ({ limit, assessment }) => {
      let results = getCouplingMetrics(store);
      if (assessment) results = results.filter((r) => r.assessment === assessment);
      if (limit) results = results.slice(0, limit);
      return { content: [{ type: 'text', text: jh('get_coupling_metrics', results) }] };
    },
  );

  server.tool(
    'get_circular_imports',
    'Find circular dependency chains in the import graph (Kosaraju SCC algorithm)',
    {},
    async () => {
      const cycles = getDependencyCycles(store);
      return {
        content: [{
          type: 'text',
          text: jh('get_dependency_cycles', {
            total_cycles: cycles.length,
            cycles,
            ...(cycles.length === 0 ? { message: 'No circular dependencies found' } : {}),
          }),
        }],
      };
    },
  );

  server.tool(
    'get_pagerank',
    'File importance ranking via PageRank on the import graph. Shows most central/important files',
    {
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default: 50)'),
    },
    async ({ limit }) => {
      const results = getPageRank(store);
      return { content: [{ type: 'text', text: jh('get_page_rank', results.slice(0, limit ?? 50)) }] };
    },
  );

  server.tool(
    'get_refactor_candidates',
    'Find functions with high complexity called from many files — candidates for extraction to shared modules',
    {
      min_cyclomatic: z.number().int().min(1).optional().describe('Min cyclomatic complexity (default: 5)'),
      min_callers: z.number().int().min(1).optional().describe('Min distinct caller files (default: 2)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
    },
    async ({ min_cyclomatic, min_callers, limit }) => {
      const results = getExtractionCandidates(store, {
        minCyclomatic: min_cyclomatic,
        minCallers: min_callers,
        limit,
      });
      return { content: [{ type: 'text', text: j(results) }] };
    },
  );

  server.tool(
    'get_project_health',
    'Structural health: coupling instability, dependency cycles, PageRank rankings, refactor candidates. Use for architecture review.',
    {},
    async () => {
      const result = getRepoHealth(store);
      const hotspots = getHotspots(store, projectRoot);
      return { content: [{ type: 'text', text: jh('get_repo_health', { ...result, hotspots: hotspots.slice(0, 10) }) }] };
    },
  );

  // --- Architecture & Ownership Tools ---

  server.tool(
    'check_architecture',
    'Check architectural layer rules: detect forbidden imports between layers (e.g. domain importing infrastructure). Supports auto-detected presets (clean-architecture, hexagonal) or custom layers.',
    {
      preset: z.enum(['clean-architecture', 'hexagonal']).optional().describe('Use a built-in layer preset (auto-detected if omitted)'),
      layers: z.array(z.object({
        name: z.string().min(1).max(64),
        path_prefixes: z.array(z.string().min(1).max(256)).min(1),
        may_not_import: z.array(z.string().min(1).max(64)),
      })).max(20).optional().describe('Custom layer definitions (overrides preset)'),
    },
    async ({ preset, layers: customLayers }) => {
      let layerDefs: LayerDefinition[];

      if (customLayers && customLayers.length > 0) {
        layerDefs = customLayers;
      } else if (preset) {
        const { LAYER_PRESETS } = await import('../layer-violations.js');
        layerDefs = LAYER_PRESETS[preset] ?? [];
      } else {
        // Auto-detect
        const detected = detectLayerPreset(store);
        if (!detected) {
          return { content: [{ type: 'text', text: j({ message: 'No layer structure detected. Provide layers or use a preset.' }) }] };
        }
        layerDefs = detected.layers;
      }

      const result = getLayerViolations(store, layerDefs);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_code_owners',
    'Git-based code ownership: who contributed most to specific files (git shortlog). Requires git.',
    {
      file_paths: z.array(z.string().max(512)).min(1).max(20).describe('File paths to check ownership for'),
    },
    async ({ file_paths }) => {
      for (const fp of file_paths) {
        const blocked = guardPath(fp);
        if (blocked) return blocked;
      }
      const results = getFileOwnership(projectRoot, file_paths);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: j({ message: 'No git history available' }) }] };
      }
      return { content: [{ type: 'text', text: j(results) }] };
    },
  );

  server.tool(
    'get_symbol_owners',
    'Git blame-based symbol ownership: who wrote which lines of a specific symbol. Requires git.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to check ownership for'),
    },
    async ({ symbol_id }) => {
      const result = getSymbolOwnership(store, projectRoot, symbol_id);
      if (!result) {
        return { content: [{ type: 'text', text: j({ message: 'Could not determine ownership (no git or symbol not found)' }) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_complexity_trend',
    'File complexity over git history: cyclomatic complexity at past commits. Shows if a file is getting more or less complex.',
    {
      file_path: z.string().max(512).describe('File path to analyze'),
      snapshots: z.number().int().min(2).max(20).optional().describe('Number of historical snapshots (default: 5)'),
    },
    async ({ file_path, snapshots }) => {
      const blocked = guardPath(file_path);
      if (blocked) return blocked;
      const result = getComplexityTrend(store, projectRoot, file_path, { snapshots });
      if (!result) {
        return { content: [{ type: 'text', text: j({ message: 'No complexity data or git history for this file' }) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_coupling_trend',
    'File coupling over git history: Ca/Ce/instability at past commits. Shows if a module is stabilizing or destabilizing.',
    {
      file_path: z.string().max(512).describe('File path to analyze'),
      since_days: z.number().int().min(1).optional().describe('Analyze last N days (default: 90)'),
      snapshots: z.number().int().min(2).max(20).optional().describe('Number of historical snapshots (default: 6)'),
    },
    async ({ file_path, since_days, snapshots }) => {
      const blocked = guardPath(file_path);
      if (blocked) return blocked;
      const result = getCouplingTrend(store, projectRoot, file_path, {
        sinceDays: since_days,
        snapshots,
      });
      if (!result) {
        return { content: [{ type: 'text', text: j({ message: 'No coupling data or git history for this file' }) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_symbol_complexity_trend',
    'Single symbol complexity over git history: cyclomatic, nesting, params, lines at past commits.',
    {
      symbol_id: z.string().min(1).max(512).describe('Symbol ID to analyze (from search or outline)'),
      since_days: z.number().int().min(1).optional().describe('Analyze last N days (default: all history)'),
      snapshots: z.number().int().min(2).max(20).optional().describe('Number of historical snapshots (default: 6)'),
    },
    async ({ symbol_id, since_days, snapshots }) => {
      const result = getSymbolComplexityTrend(store, projectRoot, symbol_id, {
        sinceDays: since_days,
        snapshots,
      });
      if (!result) {
        return { content: [{ type: 'text', text: j({ message: 'Symbol not found or no git history available' }) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );
}
