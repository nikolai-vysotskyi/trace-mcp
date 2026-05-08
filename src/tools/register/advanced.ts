import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatToolError } from '../../errors.js';
import { logger } from '../../logger.js';
import { RuntimeIntelligence } from '../../runtime/lifecycle.js';
import type { ServerContext } from '../../server/types.js';
import {
  discoverAndRegisterSubprojects,
  discoverClaudeSessions,
} from '../advanced/claude-sessions.js';
import { discoverHermesSessions } from '../advanced/hermes-sessions.js';
import {
  getCrossDomainDependencies,
  getDomainContext,
  getDomainMap,
  queryByIntent,
} from '../advanced/intent.js';
import {
  getEndpointAnalytics,
  getRuntimeCallGraph,
  getRuntimeDependencies,
  getRuntimeProfile,
} from '../advanced/runtime.js';
import {
  getContractVersions,
  getSubprojectClients,
  getSubprojectGraph,
  getSubprojectImpact,
  subprojectAddRepo,
  subprojectSync,
} from '../advanced/subproject.js';
import { getDataflow } from '../analysis/dataflow.js';
import { graphQuery } from '../analysis/graph-query.js';
import {
  assessChangeRisk,
  detectDrift,
  getHealthTrends,
  getTechDebt,
  predictBugs,
} from '../analysis/predictive-intelligence.js';
import { getDependencyDiagram, visualizeGraph } from '../analysis/visualize.js';
import { visualizeSubprojectTopology } from '../analysis/visualize-subproject.js';
import { searchText } from '../navigation/search-text.js';
import {
  getApiContract,
  getContractDrift,
  getCrossServiceImpact,
  getServiceDependencies,
  getServiceMap,
} from '../project/topology.js';
import { buildNegativeEvidence } from '../shared/evidence.js';

export function registerAdvancedTools(server: McpServer, ctx: ServerContext): void {
  const { store, config, projectRoot, guardPath, j, jh } = ctx;

  // --- Multi-Repo Topology Tools (optional) ---
  if (config.topology?.enabled && ctx.topoStore) {
    const topoStore = ctx.topoStore;
    const additionalRepos = config.topology.repos ?? [];

    server.tool(
      'get_service_map',
      'Get map of all services, their APIs, and inter-service dependencies. Auto-detects services from Docker Compose or treats each repo as a service. Use to understand microservice topology. For subproject-level graph use get_subproject_graph instead. Read-only. Returns JSON: { services: [{ name, endpoints, dependencies }], total }.',
      {
        include_endpoints: z
          .boolean()
          .optional()
          .describe('Include full endpoint list per service (default false)'),
      },
      async ({ include_endpoints }) => {
        const result = getServiceMap(topoStore, projectRoot, additionalRepos, {
          includeEndpoints: include_endpoints,
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
      'get_cross_service_impact',
      'Analyze cross-service impact of changing an endpoint or event. Shows which services would be affected. Use before modifying a shared endpoint. For within-codebase impact use get_change_impact instead. Read-only. Returns JSON: { service, affectedServices: [{ name, reason }], total }.',
      {
        service: z.string().min(1).max(256).describe('Service name'),
        endpoint: z.string().max(512).optional().describe('Endpoint path (e.g. /api/users/{id})'),
        event: z.string().max(256).optional().describe('Event channel name (e.g. user.created)'),
      },
      async ({ service, endpoint, event }) => {
        const result = getCrossServiceImpact(topoStore, projectRoot, additionalRepos, {
          service,
          endpoint,
          event,
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
      'get_api_contract',
      "Get API contract (OpenAPI/gRPC/GraphQL) for a service. Parses spec files found in the service repo. Use to inspect a service's public API. For detecting spec-vs-code mismatches use get_contract_drift instead. Read-only. Returns JSON: { service, contract_type, endpoints, schemas }.",
      {
        service: z.string().min(1).max(256).describe('Service name'),
        contract_type: z
          .enum(['openapi', 'grpc', 'graphql'])
          .optional()
          .describe('Filter by contract type'),
      },
      async ({ service, contract_type }) => {
        const result = getApiContract(topoStore, projectRoot, additionalRepos, {
          service,
          contractType: contract_type,
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
      'get_service_deps',
      "Get external service dependencies: which services this one calls (outgoing) and which call it (incoming). Use to understand a single service's dependency profile. For full topology use get_service_map instead. Read-only. Returns JSON: { service, outgoing, incoming }.",
      {
        service: z.string().min(1).max(256).describe('Service name'),
        direction: z
          .enum(['outgoing', 'incoming', 'both'])
          .optional()
          .describe('Dependency direction (default both)'),
      },
      async ({ service, direction }) => {
        const result = getServiceDependencies(topoStore, projectRoot, additionalRepos, {
          service,
          direction,
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
      'get_contract_drift',
      'Detect mismatches between API spec and implementation: endpoints in spec but not in code, or in code but not in spec. Use to verify API contract accuracy. For reading the contract itself use get_api_contract instead. Read-only. Returns JSON: { service, missingInCode, missingInSpec, total }.',
      {
        service: z.string().min(1).max(256).describe('Service name'),
      },
      async ({ service }) => {
        const result = getContractDrift(topoStore, store, projectRoot, additionalRepos, {
          service,
        });
        if (result.isErr())
          return {
            content: [{ type: 'text', text: j(formatToolError(result.error)) }],
            isError: true,
          };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    // --- Subproject Tools (within topology block) ---

    server.tool(
      'get_subproject_graph',
      'Show all subprojects and their cross-repo connections. A subproject is any working repository in your project ecosystem (microservices, frontends, backends, shared libraries, CLI tools, etc.). Displays repos, endpoints, client calls, and inter-repo dependency edges. Use to understand multi-repo topology. Register repos first with subproject_add_repo. Read-only. Returns JSON: { repos, endpoints, clientCalls, edges }.',
      {},
      async () => {
        const result = getSubprojectGraph(topoStore);
        if (result.isErr())
          return {
            content: [{ type: 'text', text: j(formatToolError(result.error)) }],
            isError: true,
          };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_subproject_impact',
      'Cross-repo impact analysis: find all client code across subprojects that would break if an endpoint changes. Resolves down to symbol level when per-repo indexes exist. Use before modifying a shared API endpoint. Read-only. Returns JSON: { endpoint, affectedClients: [{ repo, file, line, callType }], total }.',
      {
        endpoint: z
          .string()
          .max(512)
          .optional()
          .describe('Endpoint path pattern (e.g. /api/users)'),
        method: z.string().max(10).optional().describe('HTTP method filter (e.g. GET, POST)'),
        service: z.string().max(256).optional().describe('Service name filter'),
      },
      async ({ endpoint, method, service }) => {
        const result = getSubprojectImpact(topoStore, { endpoint, method, service });
        if (result.isErr())
          return {
            content: [{ type: 'text', text: j(formatToolError(result.error)) }],
            isError: true,
          };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'subproject_add_repo',
      'Add a repository as a subproject of the current project. A subproject is any working repository in your ecosystem: microservices, frontends, backends, shared libraries, CLI tools. Discovers services, parses API contracts (OpenAPI/gRPC/GraphQL), scans for HTTP client calls, and links them to known endpoints. Mutates the topology store; idempotent. Use to build multi-repo intelligence. Returns JSON: { added, services, contracts, clientCalls }.',
      {
        repo_path: z
          .string()
          .min(1)
          .max(1024)
          .describe('Absolute or relative path to the repository/service'),
        name: z
          .string()
          .max(256)
          .optional()
          .describe('Display name for the repo (default: directory basename)'),
        project: z
          .string()
          .max(1024)
          .optional()
          .describe('Project root this subproject belongs to (default: current project)'),
        contract_paths: z
          .array(z.string().max(512))
          .optional()
          .describe('Explicit contract file paths relative to repo root'),
      },
      async ({ repo_path, name, project, contract_paths }) => {
        const targetProject = project ?? projectRoot;
        const result = subprojectAddRepo(topoStore, {
          repoPath: repo_path,
          projectRoot: targetProject,
          name,
          contractPaths: contract_paths,
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
      'subproject_sync',
      'Re-scan all subprojects: re-discover services, re-parse contracts, re-scan client calls, and re-link everything. Mutates the topology store; idempotent. Use after code changes in subproject repos. Returns JSON: { synced, services, contracts, clientCalls }.',
      {},
      async () => {
        const result = subprojectSync(topoStore);
        if (result.isErr())
          return {
            content: [{ type: 'text', text: j(formatToolError(result.error)) }],
            isError: true,
          };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_subproject_clients',
      'Find all client calls across subprojects that call a specific endpoint. Shows file, line, call type, and confidence. Use to find all consumers of an endpoint before modifying it. Read-only. Returns JSON: { endpoint, clients: [{ repo, file, line, callType, confidence }], total }.',
      {
        endpoint: z
          .string()
          .min(1)
          .max(512)
          .describe('Endpoint path to search for (e.g. /api/users)'),
        method: z.string().max(10).optional().describe('HTTP method filter'),
      },
      async ({ endpoint, method }) => {
        const result = getSubprojectClients(topoStore, { endpoint, method });
        if (result.isErr())
          return {
            content: [{ type: 'text', text: j(formatToolError(result.error)) }],
            isError: true,
          };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_contract_versions',
      'Show version history for a service API contract with breaking change detection between versions. Compares request/response schemas across snapshots to flag removed fields, type changes, and renames. Use to review API evolution. For current spec-vs-code drift use get_contract_drift instead. Read-only. Returns JSON: { service, versions: [{ version, date, breakingChanges }] }.',
      {
        service: z.string().min(1).max(256).describe('Service name'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max versions to show (default 10)'),
      },
      async ({ service, limit }) => {
        const result = getContractVersions(topoStore, { service, limit });
        if (result.isErr())
          return {
            content: [{ type: 'text', text: j(formatToolError(result.error)) }],
            isError: true,
          };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'discover_claude_sessions',
      'Scan ~/.claude/projects for projects Claude Code has touched on this machine, decode each directory name back to its absolute path, and report which ones still exist plus session-file count and last activity. With add_as_subprojects=true, every existing project is registered as a subproject in one call — useful for spinning up multi-repo intelligence after a fresh clone. Reads local filesystem; with add_as_subprojects=true also mutates topology store. Returns JSON: { projects: [{ path, sessions, lastActivity }], total }.',
      {
        scan_root: z
          .string()
          .max(1024)
          .optional()
          .describe('Override the scan root (default: ~/.claude/projects)'),
        exclude_current: z
          .boolean()
          .optional()
          .describe('Exclude the current project from results (default: true)'),
        only_existing: z
          .boolean()
          .optional()
          .describe('Drop entries whose decoded path no longer exists on disk (default: true)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Max sessions to return, most recently active first (default: 50)'),
        add_as_subprojects: z
          .boolean()
          .optional()
          .describe(
            'Register every discovered project as a subproject in one shot (default: false)',
          ),
      },
      async ({ scan_root, exclude_current, only_existing, limit, add_as_subprojects }) => {
        const opts = {
          scanRoot: scan_root,
          excludePrefix: exclude_current === false ? undefined : projectRoot,
          onlyExisting: only_existing !== false,
          limit: limit ?? 50,
        };
        const result = add_as_subprojects
          ? discoverAndRegisterSubprojects(topoStore, opts)
          : discoverClaudeSessions(opts);
        if (result.isErr())
          return {
            content: [{ type: 'text', text: j(formatToolError(result.error)) }],
            isError: true,
          };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'visualize_subproject_topology',
      'Open interactive HTML visualization of the subproject topology: services as nodes, API calls as edges, health/risk indicators per service. Node size = endpoint count, color = health (green/yellow/red). Writes an HTML file to disk. Use for visual architecture review. Returns JSON: { outputPath, services, edges }.',
      {
        output: z
          .string()
          .max(512)
          .optional()
          .describe('Output file path (default: /tmp/trace-mcp-subproject-topology.html)'),
        layout: z
          .enum(['force', 'hierarchical', 'radial'])
          .optional()
          .describe('Graph layout (default force)'),
      },
      async ({ output, layout }) => {
        const result = visualizeSubprojectTopology(topoStore, { output, layout });
        if (result.isErr())
          return {
            content: [{ type: 'text', text: j(formatToolError(result.error)) }],
            isError: true,
          };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );
  }

  // --- Runtime Intelligence Tools (optional) ---
  if (config.runtime?.enabled) {
    const runtimeIntelligence = new RuntimeIntelligence(store, {
      enabled: true,
      otlp: config.runtime.otlp,
      retention: config.runtime.retention,
      mapping: config.runtime.mapping,
    });
    runtimeIntelligence
      .start()
      .catch((e) => logger.error({ error: e }, 'Failed to start Runtime Intelligence'));

    server.tool(
      'get_runtime_profile',
      'Runtime profile for a symbol or route: call count, latency percentiles (p50/p95/p99), error rate, calls per hour. Requires OTLP trace ingestion. Read-only, queries external runtime data. Use for performance analysis of specific endpoints. Returns JSON: { symbol_id, callCount, latency: { p50, p95, p99 }, errorRate, callsPerHour }.',
      {
        symbol_id: z.string().max(512).optional().describe('Symbol ID to profile'),
        fqn: z.string().max(512).optional().describe('Fully qualified name'),
        route_uri: z.string().max(512).optional().describe('Route URI to profile'),
        since: z.string().max(64).optional().describe('ISO8601 start time (default: 24h ago)'),
      },
      async ({ symbol_id, fqn, route_uri, since }) => {
        const result = getRuntimeProfile(store, {
          symbolId: symbol_id,
          fqn,
          routeUri: route_uri,
          since,
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
      'get_runtime_call_graph',
      'Actual call graph from runtime traces (vs static analysis). Shows observed call paths with call counts and latency. Requires OTLP trace ingestion. Read-only, queries external runtime data. For static call graph use get_call_graph instead. Returns JSON: { root, calls: [{ symbol, count, latency }] }.',
      {
        symbol_id: z.string().max(512).optional().describe('Symbol ID as root'),
        fqn: z.string().max(512).optional().describe('Fully qualified name as root'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Max traversal depth (default 3)'),
        since: z.string().max(64).optional().describe('ISO8601 start time (default: 24h ago)'),
      },
      async ({ symbol_id, fqn, depth, since }) => {
        const result = getRuntimeCallGraph(store, { symbolId: symbol_id, fqn, depth, since });
        if (result.isErr())
          return {
            content: [{ type: 'text', text: j(formatToolError(result.error)) }],
            isError: true,
          };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_endpoint_analytics',
      'Per-route analytics: request count, error rate, latency, caller services. Requires OTLP trace ingestion. Read-only, queries external runtime data. Use to understand endpoint performance and traffic. Returns JSON: { uri, method, requestCount, errorRate, latency, callerServices }.',
      {
        uri: z.string().max(512).describe('Route URI (e.g. "/api/users/{id}")'),
        method: z.string().max(10).optional().describe('HTTP method filter'),
        since: z.string().max(64).optional().describe('ISO8601 start time (default: 24h ago)'),
      },
      async ({ uri, method, since }) => {
        const result = getEndpointAnalytics(store, { uri, method, since });
        if (result.isErr())
          return {
            content: [{ type: 'text', text: j(formatToolError(result.error)) }],
            isError: true,
          };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_runtime_deps',
      'Which external services (databases, caches, APIs, queues) does this code actually call at runtime. Based on OTLP traces. Read-only, queries external runtime data. Use to discover actual runtime dependencies vs static analysis. Returns JSON: { dependencies: [{ type, name, callCount }] }.',
      {
        symbol_id: z.string().max(512).optional().describe('Symbol ID'),
        fqn: z.string().max(512).optional().describe('Fully qualified name'),
        file_path: z.string().max(512).optional().describe('File path'),
      },
      async ({ symbol_id, fqn, file_path }) => {
        if (file_path) {
          const blocked = guardPath(file_path);
          if (blocked) return blocked;
        }
        const result = getRuntimeDependencies(store, {
          symbolId: symbol_id,
          fqn,
          filePath: file_path,
        });
        if (result.isErr())
          return {
            content: [{ type: 'text', text: j(formatToolError(result.error)) }],
            isError: true,
          };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );
  }

  // --- Hermes Agent session discovery ---

  if (config.hermes?.enabled !== false) {
    server.tool(
      'discover_hermes_sessions',
      'List Hermes Agent (NousResearch) sessions visible on this machine. Scans $HERMES_HOME (default ~/.hermes) for state.db plus any profiles/<name>/state.db. Hermes conversations are GLOBAL — results are NOT filtered by the current project. Read-only. Returns JSON: { enabled, sessions: [{ sessionId, sourcePath, profile, lastActivity, sizeBytes }], total }.',
      {
        home_override: z
          .string()
          .max(1024)
          .optional()
          .describe('Override HERMES_HOME resolution (bypasses $HERMES_HOME env)'),
        profile: z
          .string()
          .max(128)
          .optional()
          .describe('Scope discovery to a single profile under <home>/profiles/<name>/'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Max sessions to return, most recently active first (default: 100)'),
      },
      async ({ home_override, profile, limit }) => {
        const result = await discoverHermesSessions({
          homeOverride: home_override ?? config.hermes?.home_override,
          profile: profile ?? config.hermes?.profile,
          limit,
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
  }

  // --- Intent Layer Tools ---

  server.tool(
    'query_by_intent',
    'Map a business question to domain taxonomy → returns domain ownership and relevance scores (no source code). Use when you need to know WHICH DOMAIN owns specific functionality. For actual source code use get_feature_context instead. Read-only. Returns JSON: { symbols: [{ symbol_id, domain, relevance }] }.',
    {
      query: z.string().min(1).max(500).describe('Business-level question about the codebase'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max symbols to return (default 15)'),
    },
    async ({ query, limit }) => {
      const result = queryByIntent(store, query, { limit });
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      if (result.value.symbols.length === 0) {
        const stats = store.getStats();
        const enriched = {
          ...result.value,
          evidence: buildNegativeEvidence(
            stats.totalFiles,
            stats.totalSymbols,
            false,
            'query_by_intent',
          ),
        };
        return { content: [{ type: 'text', text: j(enriched) }] };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_domain_map',
    'Get hierarchical map of business domains with key symbols per domain. Auto-builds domain taxonomy on first call using heuristic classification. Use to understand business domain boundaries. For specific domain code use get_domain_context instead. Read-only. Returns JSON: { domains: [{ name, children, symbols }] }.',
    {
      depth: z.number().int().min(1).max(5).optional().describe('Max taxonomy depth (default 3)'),
      include_symbols: z
        .boolean()
        .optional()
        .describe('Include top symbols per domain (default true)'),
      symbols_per_domain: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Max symbols per domain (default 5)'),
    },
    async ({ depth, include_symbols, symbols_per_domain }) => {
      const result = await getDomainMap(store, {
        depth,
        includeSymbols: include_symbols,
        symbolsPerDomain: symbols_per_domain,
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
    'get_domain_context',
    'Get all code related to a specific business domain. Supports "parent/child" notation (e.g. "payments/refunds"). Use to explore code within a domain boundary. For the full domain taxonomy use get_domain_map instead. Read-only. Returns JSON: { domain, symbols: [{ symbol_id, name, file, source }], relatedDomains }.',
    {
      domain: z
        .string()
        .min(1)
        .max(256)
        .describe('Domain name (e.g. "payments" or "payments/refunds")'),
      include_related: z
        .boolean()
        .optional()
        .describe('Include symbols from related domains (default false)'),
      token_budget: z
        .number()
        .int()
        .min(500)
        .max(16000)
        .optional()
        .describe('Token budget for source context (default 4000)'),
    },
    async ({ domain, include_related, token_budget }) => {
      const result = await getDomainContext(store, domain, {
        includeRelated: include_related,
        tokenBudget: token_budget,
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
    'get_cross_domain_deps',
    'Show which business domains depend on which. Based on edges between symbols in different domains. Use to understand domain coupling. Read-only. Returns JSON: { dependencies: [{ from, to, edgeCount }] }.',
    {
      domain: z.string().max(256).optional().describe('Focus on a specific domain (default: all)'),
    },
    async ({ domain }) => {
      const result = await getCrossDomainDependencies(store, { domain });
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Graph Query (NL → Graph) ---

  server.tool(
    'graph_query',
    'Trace how named symbols relate in the dependency graph → returns subgraph + Mermaid diagram. Input must contain symbol/class names (e.g. "How does AuthService reach Database?", "What depends on UserModel?"). Use for ad-hoc graph exploration. For structured call graph use get_call_graph instead. Read-only. Returns JSON: { nodes, edges, mermaid }.',
    {
      query: z
        .string()
        .min(1)
        .max(500)
        .describe('Natural language question about code relationships'),
      depth: z.number().int().min(1).max(6).optional().describe('Max traversal depth (default 3)'),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max nodes in result graph (default 100)'),
    },
    async ({ query, depth, max_nodes }) => {
      const result = graphQuery(store, query, { depth, max_nodes });
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: jh('graph_query', result.value) }] };
    },
  );

  // --- Dataflow Analysis ---

  server.tool(
    'get_dataflow',
    'Intra-function dataflow analysis: track how each parameter flows through the function body — into which calls, where it gets mutated, and what is returned. Phase 1: single function scope. Use to understand data transformations within a function. For security-focused data flow use taint_analysis instead. Read-only. Returns JSON: { symbol_id, params: [{ name, flows: [{ target, mutated }] }], returnPaths }.',
    {
      symbol_id: z
        .string()
        .max(512)
        .optional()
        .describe('Symbol ID of the function/method to analyze'),
      fqn: z.string().max(512).optional().describe('Fully qualified name of the function/method'),
      direction: z
        .enum(['forward', 'backward', 'both'])
        .optional()
        .describe('Analysis direction (default both)'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe('Max analysis depth for chained calls (default 3)'),
    },
    async ({ symbol_id, fqn, direction, depth }) => {
      const result = getDataflow(store, projectRoot, {
        symbolId: symbol_id,
        fqn,
        direction,
        depth,
      });
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Graph Visualization ---

  server.tool(
    'visualize_graph',
    'Open interactive HTML graph in browser showing file/symbol dependencies. Supports force/hierarchical/radial layouts, community coloring. Use granularity=symbol to see individual functions/classes/methods as nodes instead of files. Writes an HTML file to disk. For static Mermaid/DOT output use get_dependency_diagram instead. Returns JSON: { outputPath, nodes, edges }.',
    {
      scope: z
        .string()
        .min(1)
        .max(512)
        .describe('Scope: file path, directory (e.g. "src/"), or "project"'),
      depth: z.number().int().min(1).max(5).optional().describe('Max hops from scope (default 2)'),
      layout: z
        .enum(['force', 'hierarchical', 'radial'])
        .optional()
        .describe('Graph layout algorithm (default force)'),
      color_by: z
        .enum(['community', 'language', 'framework_role'])
        .optional()
        .describe('Node coloring strategy (default community)'),
      include_edges: z.array(z.string()).optional().describe('Filter edge types (default: all)'),
      output: z
        .string()
        .max(512)
        .optional()
        .describe('Output file path (default: /tmp/trace-mcp-graph.html)'),
      hide_isolated: z
        .boolean()
        .optional()
        .describe('Hide nodes with no edges (default: true — removes disconnected ring)'),
      granularity: z
        .enum(['file', 'symbol'])
        .optional()
        .describe('Node granularity: file (default) or symbol (functions/classes/methods)'),
      symbol_kinds: z
        .array(z.string())
        .optional()
        .describe(
          'Filter symbol kinds when granularity=symbol (e.g. ["function","class","method"])',
        ),
      max_files: z
        .number()
        .int()
        .min(1)
        .max(100000)
        .optional()
        .describe('Max seed files for file-level graph (default 10000)'),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .max(100000)
        .optional()
        .describe('Max viz nodes for symbol-level graph (default 100000)'),
      include_bottlenecks: z
        .boolean()
        .optional()
        .describe(
          'Annotate edges with bottleneckScore/isBridge and nodes with isArticulation (file granularity only). Default false.',
        ),
    },
    async ({
      scope,
      depth,
      layout,
      color_by,
      include_edges,
      output,
      hide_isolated,
      granularity,
      symbol_kinds,
      max_files,
      max_nodes,
      include_bottlenecks,
    }) => {
      const result = visualizeGraph(store, {
        scope,
        depth,
        layout,
        colorBy: color_by,
        includeEdges: include_edges,
        output,
        hideIsolated: hide_isolated,
        granularity,
        symbolKinds: symbol_kinds,
        maxFiles: max_files,
        maxNodes: max_nodes,
        topoStore: ctx.topoStore ?? undefined,
        projectRoot,
        includeBottlenecks: include_bottlenecks,
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
    'get_dependency_diagram',
    'Render dependency diagram for a file/directory path as Mermaid or DOT. Input: a path like "src/tools/" — not a question. Trims to max_nodes most important nodes. Read-only. For interactive HTML visualization use visualize_graph instead. Returns JSON: { format, diagram, nodes, edges }.',
    {
      scope: z.string().min(1).max(512).describe('Scope: file path, directory, or "project"'),
      depth: z.number().int().min(1).max(5).optional().describe('Max hops from scope (default 2)'),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Max nodes in diagram (default 30)'),
      format: z.enum(['mermaid', 'dot']).optional().describe('Output format (default mermaid)'),
    },
    async ({ scope, depth, max_nodes, format }) => {
      const result = getDependencyDiagram(store, { scope, depth, maxNodes: max_nodes, format });
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Text Search ---

  server.tool(
    'search_text',
    'Full-text search across all indexed files. Supports regex, glob file patterns, language filter. Use for finding strings, comments, TODOs, config values, error messages — anything not captured as a symbol. For symbol search (functions, classes) use search instead. Read-only. Returns JSON: { matches: [{ file, line, text, context }], total_matches }.',
    {
      query: z.string().min(1).max(1000).describe('Search string or regex pattern'),
      is_regex: z.boolean().optional().describe('Treat query as regex (default false)'),
      file_pattern: z.string().max(512).optional().describe('Glob filter, e.g. "src/**/*.ts"'),
      language: z
        .string()
        .max(64)
        .optional()
        .describe('Filter by language (e.g. "typescript", "python")'),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max matches to return (default 50)'),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe(
          'Lines of context before/after each match (default 0 — set higher if you need surrounding code)',
        ),
      case_sensitive: z.boolean().optional().describe('Case-sensitive search (default false)'),
      timeout_ms: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .optional()
        .describe(
          'Wall-clock budget in milliseconds. Catastrophic-backtracking regex cannot pin a worker beyond this. Default 2000. Set 0 to disable.',
        ),
    },
    async ({
      query,
      is_regex,
      file_pattern,
      language,
      max_results,
      context_lines,
      case_sensitive,
      timeout_ms,
    }) => {
      const result = searchText(store, projectRoot, {
        query,
        isRegex: is_regex,
        filePattern: file_pattern,
        language,
        maxResults: max_results,
        contextLines: context_lines,
        caseSensitive: case_sensitive,
        timeoutMs: timeout_ms,
      });
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      if (result.value.matches.length === 0) {
        const stats = store.getStats();
        const enriched = {
          ...result.value,
          evidence: buildNegativeEvidence(
            stats.totalFiles,
            stats.totalSymbols,
            false,
            'search_text',
          ),
        };
        return { content: [{ type: 'text', text: jh('search_text', enriched) }] };
      }
      return { content: [{ type: 'text', text: jh('search_text', result.value) }] };
    },
  );

  // --- Predictive Intelligence Tools ---

  server.tool(
    'predict_bugs',
    'Predict which files are most likely to contain bugs. Multi-signal scoring: git churn, fix-commit ratio, complexity, coupling, PageRank importance, author count. Each prediction includes a numeric score, risk bucket (low/medium/high/critical) AND a confidence_level (low/medium/high/multi_signal) counting how many independent signals actually fired. Result envelope includes _methodology disclosure. Cached for 1 hour; use refresh=true to recompute. Requires git. Use for proactive bug hunting. For complexity+churn hotspots only use get_risk_hotspots instead. Read-only. Returns JSON: { predictions: [{ file, score, risk, confidence_level, signals }], total }.',
    {
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default: 50)'),
      min_score: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Min bug probability score to include (default: 0)'),
      file_pattern: z
        .string()
        .max(256)
        .optional()
        .describe('Filter files containing this substring'),
      refresh: z.boolean().optional().describe('Force recomputation (default: false)'),
    },
    async ({ limit, min_score, file_pattern, refresh }) => {
      const result = predictBugs(store, projectRoot, {
        limit,
        minScore: min_score,
        filePattern: file_pattern,
        sinceDays: config.predictive?.git_since_days,
        weights: config.predictive?.weights?.bug,
        refresh,
        cacheTtlMinutes: config.predictive?.cache_ttl_minutes,
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
    'detect_drift',
    'Detect architectural drift: cross-module co-change anomalies (files in different modules that always change together) and shotgun surgery patterns (commits touching 3+ modules). Requires git. Use to identify hidden coupling across modules. For file-pair co-changes use get_co_changes instead. Read-only. Returns JSON: { anomalies, shotgunSurgery, total }.',
    {
      since_days: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Analyze commits from last N days (default: 180)'),
      min_confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Min Jaccard confidence for co-change anomalies (default: 0.3)'),
    },
    async ({ since_days, min_confidence }) => {
      const result = detectDrift(store, projectRoot, {
        sinceDays: since_days ?? config.predictive?.git_since_days,
        minConfidence: min_confidence,
        moduleDepth: config.predictive?.module_depth,
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
    'get_tech_debt',
    'Per-module tech debt score (A–F grade) combining: complexity, coupling instability, test coverage gaps, and git churn. Includes actionable recommendations. Use for architecture review and prioritizing cleanup. Read-only. Returns JSON: { modules: [{ module, grade, score, factors, recommendations }] }.',
    {
      module: z
        .string()
        .max(256)
        .optional()
        .describe('Focus on a specific module path (e.g. "src/tools")'),
      refresh: z.boolean().optional().describe('Force recomputation (default: false)'),
    },
    async ({ module, refresh }) => {
      const result = getTechDebt(store, projectRoot, {
        module,
        moduleDepth: config.predictive?.module_depth,
        sinceDays: config.predictive?.git_since_days,
        weights: config.predictive?.weights?.tech_debt,
        refresh,
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
    'assess_change_risk',
    'Before modifying a file or symbol, predict risk level (low/medium/high/critical) with contributing factors and recommended mitigations. Combines blast radius, complexity, git churn, test coverage, and coupling. Use as a quick risk check. For full impact report with affected tests and dependents use get_change_impact instead. Read-only. Returns JSON: { risk, level, factors: [{ name, value }], mitigations }.',
    {
      file_path: z.string().max(512).optional().describe('File path to assess'),
      symbol_id: z.string().max(512).optional().describe('Symbol ID to assess'),
    },
    async ({ file_path, symbol_id }) => {
      if (file_path) {
        const blocked = guardPath(file_path);
        if (blocked) return blocked;
      }
      const result = assessChangeRisk(store, projectRoot, {
        filePath: file_path,
        symbolId: symbol_id,
        sinceDays: config.predictive?.git_since_days,
        weights: config.predictive?.weights?.change_risk,
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
    'get_health_trends',
    'Time-series health metrics for a file or module: bug score, complexity, coupling, churn over time. Populated by predict_bugs runs. Use to track if a module is improving or degrading. Read-only. Returns JSON: { dataPoints: [{ date, bugScore, complexity, coupling, churn }] }.',
    {
      file_path: z.string().max(512).optional().describe('File path to check'),
      module: z.string().max(256).optional().describe('Module path prefix to check'),
      limit: z.number().int().min(1).max(100).optional().describe('Max data points (default: 50)'),
    },
    async ({ file_path, module, limit }) => {
      if (file_path) {
        const blocked = guardPath(file_path);
        if (blocked) return blocked;
      }
      const result = getHealthTrends(store, { filePath: file_path, module, limit });
      if (result.isErr())
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Workspace / Monorepo ---

  server.tool(
    'get_workspace_map',
    'List all detected monorepo workspaces with file counts, symbol counts, and languages. Returns dependency graph between workspaces showing cross-workspace imports. Use for monorepo structure overview. For impact of changes on other workspaces use get_cross_workspace_impact instead. Read-only. Returns JSON: { workspaces: [{ name, files, symbols, languages }], dependencies }.',
    {
      include_dependencies: z
        .boolean()
        .optional()
        .describe('Include cross-workspace dependency graph (default: true)'),
    },
    async ({ include_dependencies }) => {
      const workspaces = store.getWorkspaceStats();
      if (workspaces.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                workspaces: [],
                note: 'No workspaces detected. This project may not be a monorepo, or it has not been indexed yet.',
              }),
            },
          ],
        };
      }

      const result: Record<string, unknown> = {
        workspaces: workspaces.map((ws) => ({
          name: ws.workspace,
          files: ws.file_count,
          symbols: ws.symbol_count,
          languages: ws.languages ? [...new Set(ws.languages.split(',').filter(Boolean))] : [],
        })),
      };

      if (include_dependencies !== false) {
        const deps = store.getWorkspaceDependencyGraph();
        result.dependencies = deps.map((d) => ({
          from: d.from_workspace,
          to: d.to_workspace,
          edges: d.edge_count,
          types: d.edge_types.split(','),
        }));
      }

      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_cross_workspace_impact',
    'Show which workspaces are affected by changes in a given workspace. Lists all cross-workspace edges, affected symbols, and the public API surface consumed by other workspaces. Use before modifying shared code in a monorepo. Read-only. Returns JSON: { workspace, public_api, consumed_by, depends_on, cross_workspace_edges }.',
    {
      workspace: z.string().max(256).describe('Workspace name to analyze'),
    },
    async ({ workspace }) => {
      const exports = store.getWorkspaceExports(workspace);
      const crossEdges = store
        .getCrossWorkspaceEdges()
        .filter((e) => e.source_workspace === workspace || e.target_workspace === workspace);

      const consumers = new Map<string, Set<string>>();
      for (const edge of crossEdges) {
        if (edge.source_workspace === workspace && edge.target_workspace) {
          // This workspace provides to target
          const key = edge.target_workspace;
          if (!consumers.has(key)) consumers.set(key, new Set());
          if (edge.source_symbol) consumers.get(key)!.add(edge.source_symbol);
        }
      }

      const providers = new Map<string, Set<string>>();
      for (const edge of crossEdges) {
        if (edge.target_workspace === workspace && edge.source_workspace) {
          // This workspace consumes from source
          const key = edge.source_workspace;
          if (!providers.has(key)) providers.set(key, new Set());
          if (edge.target_symbol) providers.get(key)!.add(edge.target_symbol);
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: j({
              workspace,
              public_api: exports.map((s) => ({
                name: s.name,
                kind: s.kind,
                fqn: s.fqn,
                file: s.file_path,
              })),
              consumed_by: Object.fromEntries(
                [...consumers.entries()].map(([ws, symbols]) => [
                  ws,
                  { symbols: [...symbols], count: symbols.size },
                ]),
              ),
              depends_on: Object.fromEntries(
                [...providers.entries()].map(([ws, symbols]) => [
                  ws,
                  { symbols: [...symbols], count: symbols.size },
                ]),
              ),
              cross_workspace_edges: crossEdges.length,
            }),
          },
        ],
      };
    },
  );
}
