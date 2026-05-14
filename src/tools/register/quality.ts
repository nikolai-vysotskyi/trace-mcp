import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { optionalNonEmptyString } from './_zod-helpers.js';
import { formatToolError } from '../../errors.js';
import type { ServerContext } from '../../server/types.js';
import { detectCommunities, getCommunities, getCommunityDetail } from '../analysis/communities.js';
import { getControlFlow } from '../analysis/control-flow.js';
import { getSurprises } from '../analysis/surprises.js';
import { generateDocs } from '../project/generate-docs.js';
import { getPackageDeps } from '../project/package-deps.js';
import { auditConfig, scanInstalledSkills, scanPnpmScripts } from '../quality/audit-config.js';
import { compareBranches, getChangedSymbols } from '../quality/changed-symbols.js';
import { collectCoChanges, getCoChanges, persistCoChanges } from '../quality/co-changes.js';
import {
  evaluateQualityGates,
  type QualityGatesConfig,
  QualityGatesConfigSchema,
} from '../quality/quality-gates.js';
import { exportSecurityContext } from '../quality/security-context-export.js';
import { packContext } from '../refactoring/pack-context.js';

// E14 — Introspect the MCP server's registered tools so audit_config can
// emit dead_tool_ref findings against the live tool surface. We reach into
// the SDK's private field; the runtime shape is { [name]: { enabled, ... } }
// per @modelcontextprotocol/sdk/dist/esm/server/mcp.js. Returns an empty set
// if the SDK ever changes shape, so the audit silently degrades instead of
// throwing.
function collectRegisteredToolNames(server: McpServer): Set<string> {
  try {
    const reg = (server as unknown as { _registeredTools?: Record<string, { enabled?: boolean }> })
      ._registeredTools;
    if (!reg || typeof reg !== 'object') return new Set();
    const names = new Set<string>();
    for (const [name, tool] of Object.entries(reg)) {
      if (tool && tool.enabled !== false) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

export function registerQualityTools(server: McpServer, ctx: ServerContext): void {
  const { store, registry, config, projectRoot, j } = ctx;

  // --- Co-Change Analysis ---
  server.tool(
    'get_co_changes',
    'Find files that frequently change together in git history (temporal coupling). Requires git. Use to discover hidden dependencies between files. For cross-module co-change anomalies use detect_drift instead. Read-only. Returns JSON: { file, coChanges: [{ file, confidence, count }] }.',
    {
      file: z.string().min(1).max(512).describe('File path to analyze'),
      min_confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Minimum confidence threshold (default 0.3)'),
      min_count: z.number().int().min(1).optional().describe('Minimum co-change count (default 3)'),
      window_days: z
        .number()
        .int()
        .min(1)
        .max(730)
        .optional()
        .describe('Git history window in days (default 180)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    async ({ file, min_confidence, min_count, window_days, limit: lim }) => {
      const result = getCoChanges(store, {
        file,
        minConfidence: min_confidence,
        minCount: min_count,
        windowDays: window_days,
        limit: lim,
      });
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );
  server.tool(
    'refresh_co_changes',
    'Rebuild co-change index from git history. Mutates the co-change index; idempotent. Use after significant git history changes. Returns JSON: { status, pairs_stored, window_days }.',
    {
      window_days: z
        .number()
        .int()
        .min(1)
        .max(730)
        .optional()
        .describe('Git history window in days (default 180)'),
    },
    async ({ window_days }) => {
      const days = window_days ?? 180;
      const pairs = collectCoChanges(projectRoot, days);
      const count = persistCoChanges(store, pairs, projectRoot, days);
      return {
        content: [
          {
            type: 'text',
            text: j({ status: 'completed', pairs_stored: count, window_days: days }),
          },
        ],
      };
    },
  );
  // --- Changed Symbols ---
  server.tool(
    'get_changed_symbols',
    'Map a git diff to affected symbols (functions, classes, methods). For PR review. If "since" is omitted, auto-detects main/master as the base. Requires git. Use for PR review to see which symbols changed. For full branch comparison with risk assessment use compare_branches instead. Read-only. Returns JSON: { changes: [{ symbol_id, name, kind, file, changeType }], total }.',
    {
      since: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe(
          'Git ref to compare from (SHA, branch, tag). If omitted, auto-detects main/master merge-base',
        ),
      until: optionalNonEmptyString(256).describe('Git ref to compare to (default: HEAD)'),
      include_blast_radius: z
        .boolean()
        .optional()
        .describe('Include blast radius for each changed symbol (default false)'),
      max_blast_depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Max blast radius traversal depth (default 3)'),
    },
    async ({ since, until, include_blast_radius, max_blast_depth }) => {
      const result = getChangedSymbols(store, projectRoot, {
        since,
        until,
        includeBlastRadius: include_blast_radius,
        maxBlastDepth: max_blast_depth,
        defaultBaseBranch: config.git?.defaultBaseBranch,
      });
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'compare_branches',
    'Compare two branches at symbol level: what was added, modified, removed. Resolves merge-base automatically, groups by category/file/risk, includes blast radius and risk assessment. Requires git. Use for comprehensive PR comparison. For a quick list of changed symbols without risk analysis use get_changed_symbols instead. Read-only. Returns JSON: { branch, base, mergeBase, changes: [{ symbol_id, category, risk }], summary }.',
    {
      branch: z.string().min(1).max(256).describe('Branch to compare (e.g. "feature/payments")'),
      base: optionalNonEmptyString(256).describe('Base branch (default: "main")'),
      include_blast_radius: z
        .boolean()
        .optional()
        .describe('Include blast radius per symbol (default true)'),
      max_blast_depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Max blast radius depth (default 3)'),
      group_by: z
        .enum(['file', 'category', 'risk'])
        .optional()
        .describe(
          'Group results by: file, category (added/modified/removed), or risk level (default: category)',
        ),
    },
    async ({ branch, base, include_blast_radius, max_blast_depth, group_by }) => {
      const result = compareBranches(store, projectRoot, {
        branch,
        base,
        includeBlastRadius: include_blast_radius,
        maxBlastDepth: max_blast_depth,
        groupBy: group_by,
        defaultBaseBranch: config.git?.defaultBaseBranch,
      });
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Community Detection ---
  server.tool(
    'detect_communities',
    'Run Leiden community detection on the file dependency graph. Identifies tightly-coupled file clusters (modules). Mutates the community index (stores results); idempotent. Deterministic — same `seed` produces identical assignments across runs. Use before get_communities or get_community. Returns JSON: { communities: [{ id, files, size }], modularity, seed }.',
    {
      resolution: z
        .number()
        .min(0.1)
        .max(5)
        .optional()
        .describe('Resolution parameter — higher values produce more communities (default 1.0)'),
      seed: z
        .number()
        .int()
        .min(0)
        .max(0xffffffff)
        .optional()
        .describe(
          'PRNG seed for the Leiden node-shuffle. Same seed reproduces identical community IDs across runs. Default 0.',
        ),
    },
    async ({ resolution, seed }) => {
      const result = await detectCommunities(store, resolution ?? 1.0, seed ?? 0);
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );
  server.tool(
    'get_communities',
    'Get previously detected communities (file clusters). Run detect_communities first. Read-only. Returns JSON: { communities: [{ id, files, size }], total }.',
    {},
    async () => {
      const result = getCommunities(store);
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );
  server.tool(
    'get_community',
    'Get details for a specific community: files, inter-community dependencies. Read-only. Use after detect_communities to drill into a specific cluster. Returns JSON: { id, files, interCommunityDeps }.',
    { id: z.number().int().min(0).describe('Community ID') },
    async ({ id }) => {
      const result = getCommunityDetail(store, id);
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Surprising Connections ---
  server.tool(
    'get_surprises',
    'Rank cross-module file edges by how unexpected they look (deep folder distance + popular target + few edges = high surprise). Surfaces hidden coupling that shotgun-changes through unrelated modules. Requires detect_communities to have been run first. Read-only. Returns JSON: { edges: [{ sourceFile, targetFile, surpriseScore, ... }], totalCommunities }.',
    {
      top_n: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Number of top surprising edges to return (default 20)'),
    },
    async ({ top_n }) => {
      const result = getSurprises(store, { topN: top_n ?? 20 });
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Audit Config ---
  server.tool(
    'audit_config',
    'Scan AI agent config files (CLAUDE.md, AGENTS.md, .cursorrules, etc.) for stale references, dead paths, token bloat, and (when include_drift is set) drift between agent rules and the live MCP tool / skill / command surface. Read-only. Returns JSON: { issues: [{ file, line, category, issue, severity, fix? }], total }.',
    {
      config_files: z
        .array(z.string().max(512))
        .optional()
        .describe('Specific config files to audit (default: auto-detect)'),
      fix_suggestions: z.boolean().optional().describe('Include fix suggestions (default true)'),
      include_drift: z
        .boolean()
        .optional()
        .describe(
          'E14 — add CLAUDE.md drift detection (dead_tool_ref, dead_skill_ref, dead_command_ref, oversized_section). Default false for back-compat.',
        ),
      drift_only: z
        .boolean()
        .optional()
        .describe(
          'E14 — restrict output to drift-class categories only (dead_path + dead_*_ref + oversized_section). Implies include_drift. Use when you only care about agent-config drift.',
        ),
    },
    async ({ config_files, fix_suggestions, include_drift, drift_only }) => {
      const registeredTools = collectRegisteredToolNames(server);
      const result = auditConfig(store, projectRoot, {
        configFiles: config_files,
        fixSuggestions: fix_suggestions ?? true,
        includeDrift: include_drift,
        driftOnly: drift_only,
        registeredTools,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- CLAUDE.md drift detector alias ---
  // Thin wrapper that calls auditConfig with driftOnly=true so users can
  // surface "what is broken in my agent-config" without sifting through
  // bloat/redundancy noise.
  server.tool(
    'check_claudemd_drift',
    'Detect drift between AI agent config files (CLAUDE.md, AGENTS.md, .cursorrules) and the live tool/skill/command surface: dead path references, references to non-existent MCP tools, references to missing skills/commands, oversized sections. Convenience alias for `audit_config { drift_only: true }`. Read-only. Returns JSON: { issues: [{ file, line, category, issue, severity, fix? }], files_scanned, total_tokens, summary }.',
    {
      config_files: z
        .array(z.string().max(512))
        .optional()
        .describe(
          'Specific config files to scan (default: auto-detect CLAUDE.md / AGENTS.md / .cursorrules / .windsurfrules etc.)',
        ),
      fix_suggestions: z.boolean().optional().describe('Include fix suggestions (default true)'),
    },
    async ({ config_files, fix_suggestions }) => {
      const registeredTools = collectRegisteredToolNames(server);
      const result = auditConfig(store, projectRoot, {
        configFiles: config_files,
        fixSuggestions: fix_suggestions ?? true,
        driftOnly: true,
        registeredTools,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Control Flow Graph ---
  server.tool(
    'get_control_flow',
    'Build a Control Flow Graph (CFG) for a function/method: if/else branches, loops, try/catch, returns, throws. Shows logical paths through the code. Outputs Mermaid diagram, ASCII, or JSON. Use to understand branching logic before modifying complex functions. For call-level graph (who calls whom) use get_call_graph instead. Read-only. Returns Mermaid/ASCII/JSON: { nodes, edges, entryPoint, exitPoints }.',
    {
      symbol_id: optionalNonEmptyString(512).describe('Symbol ID of the function/method'),
      fqn: optionalNonEmptyString(512).describe('Fully qualified name of the function/method'),
      format: z
        .enum(['json', 'mermaid', 'ascii'])
        .optional()
        .describe('Output format (default: mermaid)'),
      simplify: z.boolean().optional().describe('Collapse sequential statements (default: true)'),
    },
    async ({ symbol_id, fqn, format: fmt, simplify }) => {
      const result = getControlFlow(store, projectRoot, {
        symbolId: symbol_id,
        fqn,
        format: fmt ?? 'mermaid',
        simplify: simplify ?? true,
      });
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Cross-Repo Package Dependencies ---
  server.tool(
    'get_package_deps',
    'Cross-repo package dependency analysis: find which registered projects depend on a package, or what packages a project publishes. Scans package.json/composer.json/pyproject.toml across all repos in the registry. Use for cross-project dependency mapping. For impact of upgrading a specific package use plan_batch_change instead. Read-only. Returns JSON: { dependents, dependencies, package }.',
    {
      package: z
        .string()
        .max(256)
        .optional()
        .describe('Package name to analyze (e.g. "@myorg/shared-utils")'),
      project: z
        .string()
        .max(256)
        .optional()
        .describe('Project name — analyze all packages it publishes'),
      direction: z
        .enum(['dependents', 'dependencies', 'both'])
        .optional()
        .describe('Direction (default: both)'),
    },
    async ({ package: pkg, project, direction }) => {
      const result = getPackageDeps({
        package: pkg,
        project,
        direction: direction ?? 'both',
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Documentation Generation ---
  server.tool(
    'generate_docs',
    'Auto-generate project documentation from the code graph. Produces structured docs with architecture, API surface, data models, components, and dependency analysis. Writes output file (markdown or HTML). Use when you need a comprehensive documentation snapshot. Returns JSON: { format, sections, outputPath }.',
    {
      scope: z
        .enum(['project', 'module', 'directory'])
        .optional()
        .describe('Scope (default: project)'),
      path: optionalNonEmptyString(512).describe('Path for module/directory scope'),
      format: z.enum(['markdown', 'html']).optional().describe('Output format (default: markdown)'),
      sections: z
        .array(
          z.enum([
            'overview',
            'architecture',
            'api_surface',
            'data_model',
            'components',
            'events',
            'dependencies',
          ]),
        )
        .optional()
        .describe('Sections to include (default: all)'),
    },
    async ({ scope, path: scopePath, format: fmt, sections: secs }) => {
      const result = generateDocs(store, registry, {
        scope: scope ?? 'project',
        path: scopePath,
        format: fmt ?? 'markdown',
        sections: secs ?? [
          'overview',
          'architecture',
          'api_surface',
          'data_model',
          'components',
          'events',
          'dependencies',
        ],
        projectRoot,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Repo Packing ---
  server.tool(
    'pack_context',
    'Pack project context into a single document for external LLMs. Intelligent selection by graph importance, fits within token budget. Better than Repomix for focused context. Strategies: most_relevant (default — feature/PageRank ranked), core_first (PageRank always wins, surfaces architecturally central code), compact (signatures only — drops source bodies, lets outlines cover much more of the repo per token). Read-only. Use when sharing project context with external tools. Returns XML/Markdown/JSON with selected code within budget.',
    {
      scope: z
        .enum(['project', 'module', 'feature'])
        .describe('Scope: project (whole repo), module (subdirectory), feature (NL query)'),
      path: optionalNonEmptyString(512).describe('Subdirectory path (for module scope)'),
      query: optionalNonEmptyString(500).describe('Natural language query (for feature scope)'),
      format: z
        .enum(['xml', 'markdown', 'json'])
        .optional()
        .describe('Output format (default: markdown)'),
      max_tokens: z
        .number()
        .int()
        .min(1000)
        .max(200000)
        .optional()
        .describe('Token budget (default: 50000)'),
      include: z
        .array(
          z.enum(['file_tree', 'outlines', 'source', 'dependencies', 'routes', 'models', 'tests']),
        )
        .optional()
        .describe('Sections to include (default: outlines + source + routes)'),
      compress: z
        .boolean()
        .optional()
        .describe('Strip function bodies, keep signatures (default: true)'),
      strategy: z
        .enum(['most_relevant', 'core_first', 'compact'])
        .optional()
        .describe(
          'Packing strategy (default: most_relevant). core_first = PageRank always wins. compact = drops source bodies, allows much wider outline coverage.',
        ),
      include_budget_report: z
        .boolean()
        .optional()
        .describe('Include per-section token breakdown + headroom in result (default false)'),
    },
    async ({
      scope,
      path: scopePath,
      query,
      format: fmt,
      max_tokens,
      include: inc,
      compress,
      strategy,
      include_budget_report,
    }) => {
      const result = packContext(store, registry, {
        scope,
        path: scopePath,
        query,
        format: fmt ?? 'markdown',
        maxTokens: max_tokens ?? 50000,
        include: inc ?? ['outlines', 'source', 'routes'],
        compress: compress ?? true,
        projectRoot,
        strategy,
        includeBudgetReport: include_budget_report,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Suggested Review Questions ---

  server.tool(
    'get_suggested_questions',
    'Auto-generated, prioritized review questions derived from the analyses we already cache (untested framework entry points, circular imports, ast-clone clusters, dead-export drift, untested-but-exported symbols). Use during PR review to surface "what should I be looking at?" without manually chaining six tools. Each question carries a severity (high/medium/low) and the follow-up tool to drill in. Read-only. Returns JSON: { questions: [{ id, severity, question, reason, follow_up }], total, generated_at }.',
    {},
    async () => {
      const { getSuggestedQuestions } = await import('../quality/suggested-questions.js');
      const result = getSuggestedQuestions(store);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Quality Gates ---

  server.tool(
    'check_quality_gates',
    'Run configurable quality gate checks against the project. Returns pass/fail for each gate (complexity, coupling, circular imports, dead exports, tech debt, security, antipatterns, code smells). Designed for CI integration — AI can verify gates pass before committing. Use before PR/commit to ensure quality standards. Read-only. Returns JSON: { passed, gates: [{ name, status, value, threshold }], summary }.',
    {
      scope: z
        .enum(['project', 'changed'])
        .optional()
        .describe('Scope: "project" (all) or "changed" (git diff). Default: project'),
      since: optionalNonEmptyString(128).describe('Git ref for "changed" scope (e.g. "main")'),
      config: z
        .object({
          fail_on: z.enum(['error', 'warning', 'none']).optional(),
          rules: z
            .record(
              z.string(),
              z.object({
                threshold: z.union([z.number(), z.string()]),
                severity: z.enum(['error', 'warning']).optional(),
              }),
            )
            .optional(),
        })
        .optional()
        .describe('Inline config overrides (merged with project config)'),
    },
    async ({ scope: _scope, since: _since, config: inlineConfig }) => {
      // Load quality gates config from project config
      let gatesConfig: QualityGatesConfig;
      const rawQG = (config as Record<string, unknown>).quality_gates;
      if (rawQG) {
        const parsed = QualityGatesConfigSchema.safeParse(rawQG);
        gatesConfig = parsed.success
          ? parsed.data
          : {
              enabled: true,
              fail_on: 'error',
              rules: {
                max_cyclomatic_complexity: { threshold: 30, severity: 'warning' },
                max_circular_import_chains: { threshold: 0, severity: 'error' },
                max_security_critical_findings: { threshold: 0, severity: 'error' },
              },
            };
      } else {
        gatesConfig = {
          enabled: true,
          fail_on: 'error',
          rules: {
            max_cyclomatic_complexity: { threshold: 30, severity: 'warning' },
            max_circular_import_chains: { threshold: 0, severity: 'error' },
            max_security_critical_findings: { threshold: 0, severity: 'error' },
          },
        };
      }

      // Apply inline overrides
      if (inlineConfig?.fail_on) gatesConfig.fail_on = inlineConfig.fail_on;
      if (inlineConfig?.rules) {
        for (const [key, val] of Object.entries(inlineConfig.rules)) {
          (gatesConfig.rules as Record<string, unknown>)[key] = {
            ...((gatesConfig.rules as Record<string, unknown>)[key] as
              | Record<string, unknown>
              | undefined),
            ...val,
          };
        }
      }

      const report = evaluateQualityGates(store, projectRoot, gatesConfig, {
        sinceDays: config.predictive?.git_since_days,
        moduleDepth: config.predictive?.module_depth,
      });

      return { content: [{ type: 'text', text: j(report) }] };
    },
  );

  // --- Security Context Export ---
  server.tool(
    'export_security_context',
    'Export security context for MCP server analysis. Generates enrichment JSON for skill-scan: tool registrations with annotations, transitive call graphs classified by security category (file_read, file_write, network_outbound, env_read, shell_exec, crypto, serialization), sensitive data flows, and per-file capability maps. Use to analyze MCP server security before installation. Read-only. Returns JSON: { tool_registrations, sensitive_flows, capability_map, warnings }.',
    {
      scope: z
        .string()
        .max(512)
        .optional()
        .describe('Limit analysis to directory (relative to project root)'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe('Call graph traversal depth (default: 3)'),
    },
    async ({ scope, depth }) => {
      const result = exportSecurityContext(store, projectRoot, { scope, depth });
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );
}
