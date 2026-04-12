import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../../server/types.js';
import { formatToolError } from '../../errors.js';
import { getChurnRate, getHotspots, isGitRepo, HOTSPOT_METHODOLOGY } from '../git/git-analysis.js';
import { getDeadCodeV2, getDeadCodeReachability } from '../refactoring/dead-code.js';
import { scanSecurity, type RuleName, type Severity } from '../quality/security-scan.js';
import { detectAntipatterns, type AntipatternCategory, type Severity as AntipatternSeverity } from '../quality/antipatterns.js';
import { scanCodeSmells, type SmellCategory, type SmellPriority } from '../quality/code-smells.js';
import { taintAnalysis, type TaintSourceKind, type TaintSinkKind } from '../quality/taint-analysis.js';
import { generateSbom, type SbomFormat } from '../project/sbom.js';
import { getArtifacts, type ArtifactCategory } from '../project/artifacts.js';
import { planBatchChange } from '../project/batch-changes.js';
import { checkRenameSafe } from '../refactoring/rename-check.js';
import { buildNegativeEvidence } from '../shared/evidence.js';
import { GIT_CHURN_METHODOLOGY, COMPLEXITY_METHODOLOGY } from '../shared/confidence.js';

export function registerGitTools(server: McpServer, ctx: ServerContext): void {
  const { store, projectRoot, registry, guardPath, j, jh } = ctx;
  const detectedFrameworks = registry.getAllFrameworkPlugins().map((p) => p.manifest.name);

  // --- Git Analysis Tools ---

  server.tool(
    'get_git_churn',
    'Per-file git churn: commits, unique authors, frequency, volatility assessment. Requires git.',
    {
      since_days: z.number().int().min(1).optional().describe('Analyze commits from last N days (default: all history)'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default: 50)'),
      file_pattern: z.string().max(256).optional().describe('Filter files containing this substring'),
    },
    async ({ since_days, limit, file_pattern }) => {
      const results = getChurnRate(projectRoot, {
        sinceDays: since_days,
        limit,
        filePattern: file_pattern,
      });
      if (results.length === 0) {
        return { content: [{ type: 'text', text: j({ message: 'No git history available or no matching files', _methodology: GIT_CHURN_METHODOLOGY }) }] };
      }
      return { content: [{ type: 'text', text: j({ results, total: results.length }) }] };
    },
  );

  server.tool(
    'get_risk_hotspots',
    'Code hotspots: files with both high complexity AND high git churn (Adam Tornhill methodology). Score = complexity × log(1 + commits). Each entry includes a confidence_level (low/medium/multi_signal) counting how many of the two independent signals fired strongly. Result envelope includes _methodology disclosure and _warnings when git is unavailable.',
    {
      since_days: z.number().int().min(1).optional().describe('Git churn window in days (default: 90)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
      min_cyclomatic: z.number().int().min(1).optional().describe('Min cyclomatic complexity to consider (default: 3)'),
    },
    async ({ since_days, limit, min_cyclomatic }) => {
      const results = getHotspots(store, projectRoot, {
        sinceDays: since_days,
        limit,
        minCyclomatic: min_cyclomatic,
      });
      const warnings: string[] = [];
      if (!isGitRepo(projectRoot)) {
        warnings.push(
          'Git history unavailable. Falling back to complexity-only ranking; ' +
          'churn signal cannot fire, so all results are confidence_level=low.',
        );
      }
      if (results.length === 0) {
        return { content: [{ type: 'text', text: j({ message: 'No hotspots found (no complex files with git churn)', _methodology: HOTSPOT_METHODOLOGY, ...(warnings.length > 0 ? { _warnings: warnings } : {}) }) }] };
      }
      const envelope = {
        hotspots: results,
        total: results.length,
        ...(warnings.length > 0 ? { _warnings: warnings } : {}),
      };
      return { content: [{ type: 'text', text: jh('get_hotspots', envelope) }] };
    },
  );

  server.tool(
    'get_dead_code',
    'Dead code detection. Two modes: (1) "multi-signal" (default) combines import graph, call graph, and barrel export analysis with confidence scores. (2) "reachability" runs forward BFS from auto-detected entry points (tests, package.json main/bin, src/{cli,main,index}, routes, framework-tagged controllers) — stricter but more accurate when entry points are enumerable. Pass entry_points to add custom roots. Both modes emit _methodology and _warnings.',
    {
      file_pattern: z.string().max(512).optional().describe('Filter by file glob pattern (e.g. "src/tools/%")'),
      threshold: z.number().min(0).max(1).optional().describe('[multi-signal mode] Min confidence to report (default: 0.5 = at least 2 of 3 signals)'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default: 50)'),
      mode: z.enum(['multi-signal', 'reachability']).optional().describe('Detection algorithm (default: multi-signal)'),
      entry_points: z.array(z.string().max(512)).max(200).optional().describe('[reachability mode] Extra entry-point file paths (repo-relative)'),
    },
    async ({ file_pattern, threshold, limit, mode, entry_points }) => {
      const result = mode === 'reachability'
        ? getDeadCodeReachability(store, {
            filePattern: file_pattern,
            limit,
            detectedFrameworks,
            projectRoot,
            entryPoints: entry_points,
          })
        : getDeadCodeV2(store, {
            filePattern: file_pattern,
            threshold,
            limit,
            detectedFrameworks,
          });
      if (result.dead_symbols.length === 0) {
        const stats = store.getStats();
        return { content: [{ type: 'text', text: jh('get_dead_code', { ...result, evidence: buildNegativeEvidence(stats.totalFiles, stats.totalSymbols, false, 'get_dead_code') }) }] };
      }
      return { content: [{ type: 'text', text: jh('get_dead_code', result) }] };
    },
  );

  server.tool(
    'scan_security',
    'Scan project files for OWASP Top-10 security vulnerabilities using pattern matching. Detects SQL injection (CWE-89), XSS (CWE-79), command injection (CWE-78), path traversal (CWE-22), hardcoded secrets (CWE-798), insecure crypto (CWE-327), open redirects (CWE-601), and SSRF (CWE-918). Skips test files.',
    {
      scope: z.string().max(512).optional().describe('Directory to scan (default: whole project)'),
      rules: z.array(z.enum([
        'sql_injection', 'xss', 'command_injection', 'path_traversal',
        'hardcoded_secrets', 'insecure_crypto', 'open_redirect', 'ssrf', 'all',
      ])).min(1).describe('Rules to apply (use ["all"] for full scan)'),
      severity_threshold: z.enum(['critical', 'high', 'medium', 'low']).optional()
        .describe('Minimum severity to report (default: low)'),
    },
    async ({ scope, rules, severity_threshold }) => {
      if (scope) {
        const blocked = guardPath(scope);
        if (blocked) return blocked;
      }
      const result = scanSecurity(store, projectRoot, {
        scope,
        rules: rules as RuleName[],
        severityThreshold: severity_threshold as Severity | undefined,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'detect_antipatterns',
    'Detect performance antipatterns: N+1 query risks, missing eager loading, unbounded queries, event listener leaks, circular model dependencies, missing indexes, memory leaks (unbounded caches, closure leaks). Static analysis across all indexed ORMs (Eloquent, Sequelize, Mongoose, Django, Prisma, TypeORM, Drizzle).',
    {
      category: z.array(z.enum([
        'n_plus_one_risk', 'missing_eager_load', 'unbounded_query',
        'event_listener_leak', 'circular_dependency', 'missing_index', 'memory_leak',
      ])).optional().describe('Antipattern categories to check (default: all)'),
      file_pattern: z.string().max(512).optional().describe('Filter to files matching this pattern'),
      severity_threshold: z.enum(['critical', 'high', 'medium', 'low']).optional()
        .describe('Minimum severity to report (default: low)'),
      limit: z.number().int().min(1).max(500).optional().describe('Max findings to return (default: 100)'),
    },
    async ({ category, file_pattern, severity_threshold, limit }) => {
      const result = detectAntipatterns(store, projectRoot, {
        category: category as AntipatternCategory[] | undefined,
        file_pattern,
        severity_threshold: severity_threshold as AntipatternSeverity | undefined,
        limit,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: jh('detect_antipatterns', result.value) }] };
    },
  );

  server.tool(
    'scan_code_smells',
    'Find deferred work and shortcuts: TODO/FIXME/HACK/XXX comments, empty functions & stubs, hardcoded values (IPs, URLs, credentials, magic numbers, feature flags). Surfaces technical debt that grep alone misses by combining comment scanning, symbol body analysis, and context-aware false-positive filtering.',
    {
      category: z.array(z.enum([
        'todo_comment', 'empty_function', 'hardcoded_value',
      ])).optional().describe('Categories to scan (default: all)'),
      scope: z.string().max(512).optional().describe('Directory to scan (default: whole project)'),
      priority_threshold: z.enum(['high', 'medium', 'low']).optional()
        .describe('Minimum priority to report (default: low)'),
      include_tests: z.boolean().optional()
        .describe('Include test files in scan (default: false)'),
      tags: z.array(z.string().max(64)).optional()
        .describe('Filter TODO comments by tag (e.g. ["FIXME","HACK"]). Only applies to todo_comment category'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max findings to return (default: 200)'),
    },
    async ({ category, scope, priority_threshold, include_tests, tags, limit }) => {
      if (scope) {
        const blocked = guardPath(scope);
        if (blocked) return blocked;
      }
      const result = scanCodeSmells(store, projectRoot, {
        category: category as SmellCategory[] | undefined,
        scope,
        priority_threshold: priority_threshold as SmellPriority | undefined,
        include_tests,
        tags,
        limit,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: jh('scan_code_smells', result.value) }] };
    },
  );

  server.tool(
    'taint_analysis',
    'Track flow of untrusted data from sources (HTTP params, env vars, file reads) to dangerous sinks (SQL queries, exec, innerHTML, redirects). Framework-aware: knows Express req.params, Laravel $request->input, Django request.GET, FastAPI Query(), etc. Reports unsanitized flows with CWE IDs and fix suggestions. More accurate than pattern-based scanning — traces actual data flow paths.',
    {
      scope: z.string().max(512).optional().describe('Directory to scan (default: whole project)'),
      sources: z.array(z.enum([
        'http_param', 'http_body', 'http_header', 'cookie',
        'env', 'file_read', 'db_result', 'user_input',
      ])).optional().describe('Filter by source kinds (default: all)'),
      sinks: z.array(z.enum([
        'sql_query', 'exec', 'eval', 'innerHTML', 'redirect',
        'file_write', 'response_body', 'template_raw',
      ])).optional().describe('Filter by sink kinds (default: all)'),
      include_sanitized: z.boolean().optional().describe('Include flows with sanitizers (default: false)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max flows to return (default: 100)'),
    },
    async ({ scope, sources, sinks, include_sanitized, limit }) => {
      if (scope) {
        const blocked = guardPath(scope);
        if (blocked) return blocked;
      }
      const result = taintAnalysis(store, projectRoot, {
        scope,
        sources: sources as TaintSourceKind[] | undefined,
        sinks: sinks as TaintSinkKind[] | undefined,
        includeSanitized: include_sanitized,
        limit,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'generate_sbom',
    'Generate a Software Bill of Materials (SBOM) from package manifests and lockfiles. Supports npm, Composer, pip, Go, Cargo, Bundler, Maven. Outputs CycloneDX, SPDX, or plain JSON. Includes license compliance warnings for copyleft licenses.',
    {
      format: z.enum(['cyclonedx', 'spdx', 'json']).optional().describe('Output format (default: json)'),
      include_dev: z.boolean().optional().describe('Include devDependencies (default: false)'),
      include_transitive: z.boolean().optional().describe('Include transitive dependencies (default: true)'),
    },
    async ({ format, include_dev, include_transitive }) => {
      const result = generateSbom(projectRoot, {
        format: format as SbomFormat | undefined,
        includeDev: include_dev,
        includeTransitive: include_transitive,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_artifacts',
    'Surface non-code knowledge from the index: DB schemas (migrations, ORM models), API specs (routes, OpenAPI endpoints), infrastructure (docker-compose services, K8s resources), CI pipelines (jobs, stages), and config (env vars). All data from the existing index — no extra I/O.',
    {
      category: z.enum(['database', 'api', 'infra', 'ci', 'config', 'all']).optional()
        .describe('Filter by artifact category (default: all)'),
      query: z.string().max(256).optional().describe('Text filter on name/kind/file'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max results (default: 200)'),
    },
    async ({ category, query, limit }) => {
      const result = getArtifacts(store, {
        category: category as ArtifactCategory | undefined,
        query,
        limit,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'plan_batch_change',
    'Analyze the impact of updating a package/dependency. Shows all affected files, import references, and generates a PR template with checklist. Use before upgrading a dependency to understand blast radius.',
    {
      package: z.string().min(1).max(256).describe('Package name (e.g. "express", "laravel/framework", "react")'),
      from_version: z.string().max(64).optional().describe('Current version'),
      to_version: z.string().max(64).optional().describe('Target version'),
      breaking_changes: z.array(z.string().max(500)).max(20).optional().describe('Known breaking changes to include in the report'),
    },
    async ({ package: pkg, from_version, to_version, breaking_changes }) => {
      const result = planBatchChange(store, {
        package: pkg,
        fromVersion: from_version,
        toVersion: to_version,
        breakingChanges: breaking_changes,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_complexity_report',
    'Get complexity metrics (cyclomatic, max nesting, param count) for symbols in a file or across the project. Useful for identifying complex code before refactoring.',
    {
      file_path: z.string().max(512).optional().describe('File path to report on (omit for project-wide top complex symbols)'),
      min_cyclomatic: z.number().int().min(1).optional().describe('Min cyclomatic complexity to include (default: 1 for file, 5 for project)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default: 30)'),
      sort_by: z.enum(['cyclomatic', 'nesting', 'params']).optional().describe('Sort by metric (default: cyclomatic)'),
    },
    async ({ file_path, min_cyclomatic, limit: lim, sort_by }) => {
      if (file_path) {
        const blocked = guardPath(file_path);
        if (blocked) return blocked;
      }
      const sortCol = sort_by === 'nesting' ? 's.max_nesting' : sort_by === 'params' ? 's.param_count' : 's.cyclomatic';
      const threshold = min_cyclomatic ?? (file_path ? 1 : 5);
      const maxRows = lim ?? 30;

      const conditions = ['s.cyclomatic IS NOT NULL', `s.cyclomatic >= ?`];
      const params: unknown[] = [threshold];
      if (file_path) {
        conditions.push('f.path = ?');
        params.push(file_path);
      }
      params.push(maxRows);

      const rows = store.db.prepare(`
        SELECT s.symbol_id, s.name, s.kind, f.path as file, s.line_start as line,
               s.cyclomatic, s.max_nesting, s.param_count
        FROM symbols s JOIN files f ON s.file_id = f.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${sortCol} DESC
        LIMIT ?
      `).all(...params);

      return { content: [{ type: 'text', text: j({ symbols: rows, total: rows.length }) }] };
    },
  );

  server.tool(
    'check_rename',
    'Pre-rename collision detection: checks the symbol\'s own file and all importing files for existing symbols with the target name',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to rename'),
      target_name: z.string().min(1).max(256).describe('Proposed new name'),
    },
    async ({ symbol_id, target_name }) => {
      const result = checkRenameSafe(store, symbol_id, target_name);
      return { content: [{ type: 'text', text: jh('check_rename_safe', result) }] };
    },
  );
}
