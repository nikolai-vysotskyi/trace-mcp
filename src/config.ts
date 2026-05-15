import fs from 'node:fs';
import { cosmiconfig } from 'cosmiconfig';
import { z } from 'zod';
import { configError, err, ok, type TraceMcpResult } from './errors.js';
import { GLOBAL_CONFIG_PATH, stripJsonComments } from './global.js';
import { logger } from './logger.js';

const SecurityConfigSchema = z
  .object({
    secret_patterns: z.array(z.string()).optional(),
    max_file_size_bytes: z.number().positive().optional(),
    max_files: z.number().positive().optional(),
  })
  .optional();

const ArtisanConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    timeout: z.number().positive().default(10000),
  })
  .optional();

const FrameworkConfigSchema = z
  .object({
    laravel: z
      .object({
        artisan: ArtisanConfigSchema,
        graceful_degradation: z.boolean().default(true),
      })
      .optional(),
  })
  .optional();

const AiConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z
      .enum([
        'onnx',
        'ollama',
        'openai',
        'anthropic',
        'lmstudio',
        'gemini',
        'vertex',
        'voyage',
        'mistral',
        'deepseek',
        'groq',
        'together',
        'xai',
      ])
      .default('onnx'),
    /** Per-capability enable flags. Lets users disable inference while keeping embeddings (or vice versa)
     *  without switching provider. Disabled capabilities return fallback services (empty results). */
    features: z
      .object({
        embedding: z.boolean().default(true),
        inference: z.boolean().default(true),
        fast_inference: z.boolean().default(true),
      })
      .prefault({}),
    base_url: z.string().optional(),
    api_key: z.string().optional(),
    inference_model: z.string().optional(),
    fast_model: z.string().optional(),
    embedding_model: z.string().optional(),
    embedding_dimensions: z.number().optional(),
    summarize_on_index: z.boolean().default(false),
    summarize_batch_size: z.number().positive().default(20),
    summarize_kinds: z
      .array(z.string())
      .default(['class', 'function', 'method', 'interface', 'trait', 'enum', 'type']),
    /** Max parallel requests to the AI provider (embedding + inference).
     *  Ollama-side: set OLLAMA_NUM_PARALLEL env var to match this value.
     *  On macOS desktop app: `launchctl setenv OLLAMA_NUM_PARALLEL <N>` + restart app.
     *  Or run from terminal: `OLLAMA_NUM_PARALLEL=<N> ollama serve`. */
    concurrency: z.number().int().min(1).max(32).default(1),
    reranker_model: z.string().optional(),
    /** Vertex AI: GCP project ID hosting the models. */
    vertex_project: z.string().optional(),
    /** Vertex AI: GCP region routing requests (e.g. us-central1, europe-west4). */
    vertex_location: z.string().optional(),
  })
  .optional();

const PredictiveConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    weights: z
      .object({
        bug: z
          .object({
            churn: z.number().default(0.2),
            fix_ratio: z.number().default(0.2),
            complexity: z.number().default(0.2),
            coupling: z.number().default(0.15),
            pagerank: z.number().default(0.1),
            authors: z.number().default(0.15),
          })
          .prefault({}),
        tech_debt: z
          .object({
            complexity: z.number().default(0.3),
            coupling: z.number().default(0.25),
            test_gap: z.number().default(0.25),
            churn: z.number().default(0.2),
          })
          .prefault({}),
        change_risk: z
          .object({
            blast_radius: z.number().default(0.25),
            complexity: z.number().default(0.2),
            churn: z.number().default(0.2),
            test_gap: z.number().default(0.2),
            coupling: z.number().default(0.15),
          })
          .prefault({}),
      })
      .prefault({}),
    cache_ttl_minutes: z.number().default(60),
    git_since_days: z.number().default(180),
    module_depth: z.number().default(2),
  })
  .optional();

const IntentConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    domain_hints: z.record(z.string(), z.array(z.string())).optional(),
    custom_domains: z
      .array(
        z.object({
          name: z.string(),
          parent: z.string().optional(),
          description: z.string().optional(),
          path_patterns: z.array(z.string()),
        }),
      )
      .optional(),
    auto_classify_on_index: z.boolean().default(true),
    classify_batch_size: z.number().positive().default(100),
  })
  .optional();

const RuntimeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    otlp: z
      .object({
        port: z.number().int().min(0).max(65535).default(4318),
        host: z.string().default('127.0.0.1'),
        max_body_bytes: z
          .number()
          .positive()
          .default(4 * 1024 * 1024),
      })
      .prefault({}),
    retention: z
      .object({
        max_span_age_days: z.number().positive().default(7),
        max_aggregate_age_days: z.number().positive().default(90),
        prune_interval: z.number().int().min(0).default(100),
      })
      .prefault({}),
    mapping: z
      .object({
        fqn_attributes: z
          .array(z.string())
          .default(['code.function', 'code.namespace', 'code.filepath']),
        route_patterns: z
          .array(z.string())
          .default(['^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s+(.+)$']),
      })
      .prefault({}),
  })
  .optional();

const ToolDescriptionOverrideSchema = z.union([
  z.string(), // flat: replace entire tool description
  z.record(z.string(), z.string()), // nested: _description + per-parameter overrides
]);

const ToolsConfigSchema = z
  .object({
    preset: z.string().default('full'),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    descriptions: z.record(z.string(), ToolDescriptionOverrideSchema).optional(),
    /** Global description verbosity: full (default), minimal (first sentence only), none (empty) */
    description_verbosity: z.enum(['full', 'minimal', 'none']).default('full'),
    /** Server instructions verbosity: full (default ~2K tokens), minimal (~200 tokens), none (empty) */
    instructions_verbosity: z.enum(['full', 'minimal', 'none']).default('full'),
    /** Agent behavior rules appended to server instructions. strict = full discipline rules (anti-sycophancy, goal-driven execution, 2-strike rule), minimal = anti-fabrication only, off = no behavior rules. Auto-set to "strict" by Max-tier init. */
    agent_behavior: z.enum(['strict', 'minimal', 'off']).default('off'),
    /** Control which meta fields appear in responses. true = all (default), false = none, or list specific fields to include */
    meta_fields: z
      .union([
        z.boolean(),
        z.array(
          z.enum([
            '_hints',
            '_budget_warning',
            '_budget_level',
            '_duplicate_warning',
            '_dedup',
            '_optimization_hint',
            '_meta',
            '_duplication_warnings',
            '_methodology',
          ]),
        ),
      ])
      .default(true),
    /** Strip advanced/optional parameters from tool schemas to reduce token overhead (~40-60% schema size reduction). Only core parameters are exposed; advanced options still work if passed. */
    compact_schemas: z.boolean().default(false),
    /** Wire format for tool responses.
     *  - 'json' (default): standard JSON, unchanged from prior versions.
     *  - 'compact': path-interning + row-packing (~25% token savings on retrieval-heavy responses).
     *      LLM must decode positional rows — only enable for clients that handle it.
     *  - 'auto': encode both, ship compact when it beats JSON by ≥15% bytes; else fall back to JSON.
     *  Per-call override: pass `_format` in tool params to opt one call into a different mode. */
    default_format: z.enum(['json', 'compact', 'auto']).default('json'),
  })
  .optional();

const TelemetryObservabilitySchema = z
  .object({
    /** Master switch for the observability bridge. Off by default. */
    enabled: z.boolean().default(false),
    /** Which sink to export spans/events to. `noop` is a safe default. */
    sink: z.enum(['noop', 'otlp', 'langfuse', 'multi']).default('noop'),
    /** Probabilistic sampling rate in [0,1]. 1 keeps everything (default). */
    sampleRate: z.number().min(0).max(1).default(1),
    /** OTLP/HTTP exporter settings — used when `sink` is `otlp` or `multi`. */
    otlp: z
      .object({
        endpoint: z.string().default('http://localhost:4318/v1/traces'),
        headers: z.record(z.string(), z.string()).default({}),
        serviceName: z.string().default('trace-mcp'),
        /** Cap on buffered spans before oldest are dropped. Bounds memory growth
         *  when the export endpoint is unreachable. Default 5000. */
        maxQueuedSpans: z.number().int().min(1).max(1_000_000).default(5_000),
        /** Per-request timeout (ms). Wraps fetch with AbortController so a hung
         *  endpoint can't pin memory. Default 10000. Set 0 to disable. */
        requestTimeoutMs: z.number().int().min(0).max(600_000).default(10_000),
      })
      .prefault({}),
    /** Langfuse public ingestion settings — used when `sink` is `langfuse` or `multi`. */
    langfuse: z
      .object({
        endpoint: z.string().default('https://cloud.langfuse.com'),
        publicKey: z.string().optional(),
        secretKey: z.string().optional(),
        /** Cap on buffered ingestion events before oldest are dropped. Each span
         *  emits 2 events (create + update), so effective span capacity is ~half.
         *  Default 10000. */
        maxQueuedEvents: z.number().int().min(2).max(1_000_000).default(10_000),
        /** Per-request timeout (ms). Default 10000. Set 0 to disable. */
        requestTimeoutMs: z.number().int().min(0).max(600_000).default(10_000),
      })
      .prefault({}),
  })
  .prefault({});

const TelemetryConfigSchema = z
  .object({
    /** When true, persist tool-call latency to ~/.trace-mcp/telemetry.db. Off by default to avoid
     *  unsolicited disk writes — analyze_perf works without the sink (in-memory ring). */
    enabled: z.boolean().default(false),
    /** Maximum rows to retain. Older rows are pruned when exceeded. 0 disables pruning. */
    max_rows: z.number().int().min(0).max(10_000_000).default(500_000),
    /** Observability bridge: emits OpenTelemetry/Langfuse spans for AI calls + tool execution.
     *  Independent from the local `enabled` switch above — only fires when `observability.enabled`
     *  is explicitly true. Default sink is `noop` (zero overhead). */
    observability: TelemetryObservabilitySchema,
  })
  .optional();

const QualityGatesRuleSchema = z.object({
  threshold: z.union([z.number(), z.string()]),
  severity: z.enum(['error', 'warning']).default('error'),
  scope: z.enum(['all', 'new_symbols', 'changed_symbols']).optional(),
  message: z.string().optional(),
});

const QualityGatesConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    fail_on: z.enum(['error', 'warning', 'none']).default('error'),
    rules: z
      .object({
        max_cyclomatic_complexity: QualityGatesRuleSchema.optional(),
        max_coupling_instability: QualityGatesRuleSchema.optional(),
        max_circular_import_chains: QualityGatesRuleSchema.optional(),
        max_dead_exports_percent: QualityGatesRuleSchema.optional(),
        max_tech_debt_grade: QualityGatesRuleSchema.optional(),
        max_security_critical_findings: QualityGatesRuleSchema.optional(),
        max_antipattern_count: QualityGatesRuleSchema.optional(),
        max_code_smell_count: QualityGatesRuleSchema.optional(),
      })
      .prefault({}),
  })
  .optional();

const IgnoreConfigSchema = z
  .object({
    /** Extra directory names to skip during indexing (added to built-in list). */
    directories: z.array(z.string()).default([]),
    /** Extra gitignore-style patterns to exclude from indexing. */
    patterns: z.array(z.string()).default([]),
  })
  .prefault({});

const LspServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  initializationOptions: z.record(z.string(), z.unknown()).optional(),
  rootUri: z.string().optional(),
  timeout_ms: z.number().int().min(1000).max(120000).default(30000),
});

const LspConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    servers: z.record(z.string(), LspServerConfigSchema).prefault({}),
    auto_detect: z.boolean().default(true),
    max_concurrent_servers: z.number().int().min(1).max(4).default(2),
    enrichment_timeout_ms: z.number().int().min(5000).max(600000).default(120000),
    batch_size: z.number().int().min(10).max(1000).default(100),
  })
  .optional();

const IndexerConfigSchema = z
  .object({
    /** Daemon-shared ExtractPool size. Defaults to half cores capped at 4 in
     *  daemon mode (see plan-indexer-perf §2.1). CLI/per-pipeline pools are
     *  unaffected — they keep the legacy os.cpus()-1 default capped at 8. */
    workers: z.number().int().min(1).max(32).optional(),
    /** Max concurrent pipeline.indexAll() calls in the daemon. Watcher-driven
     *  incremental indexFiles() is NOT gated. Default 2 — see §2.3. */
    parallel_initial_index: z.number().int().min(1).max(16).optional(),
  })
  .optional();

/**
 * Pipeline task-cache configuration. The SQLite-backed `pass_cache` table
 * accumulates one row per (task, input-hash) pair, so a long-running daemon
 * would otherwise grow it forever. `task_cache_ttl_days` bounds row age —
 * `ProjectManager.addProject` calls `SqliteTaskCache.evictExpired()` once at
 * startup using this TTL. Eviction is cheap (single indexed DELETE).
 */
const PipelineConfigSchema = z
  .object({
    /** Maximum age (in days) of `pass_cache` rows before they are evicted at
     *  project start-up. Defaults to 30 days. */
    task_cache_ttl_days: z.number().int().min(1).max(365).default(30),
  })
  .prefault({});

const TopologyConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    repos: z.array(z.string()).default([]),
    auto_detect: z.boolean().default(true),
    auto_discover: z.boolean().default(true),
    contract_globs: z.array(z.string()).optional(),
  })
  .optional();

/**
 * Memoir-style decision capture thresholds — split mined decisions into
 * three tiers so borderline rows surface in a review queue instead of
 * silently entering the active knowledge graph.
 *
 *   confidence ≥ review_threshold  → auto-approved (review_status = NULL)
 *   confidence ≥ reject_threshold  → 'pending'      (queued for human review)
 *   otherwise                      → dropped         (current behaviour)
 *
 * Tunable via `decisions.review_threshold` / `decisions.reject_threshold`
 * in `~/.trace-mcp/.config.json` or `.trace-mcp.json` per project.
 * Defaults match `DEFAULT_REVIEW_THRESHOLD` / `DEFAULT_REJECT_THRESHOLD`
 * in `src/memory/conversation-miner.ts` (kept in sync).
 */
const DecisionsConfigSchema = z
  .object({
    review_threshold: z.number().min(0).max(1).default(0.75),
    reject_threshold: z.number().min(0).max(1).default(0.45),
  })
  .prefault({});

const VaultConfigSchema = z
  .object({
    /**
     * Treat the project (or specific roots) as a markdown knowledge vault
     * (Obsidian / Logseq / plain MD). Enables wikilink resolution and the
     * `note` / `section` / `tag` symbol kinds in indexing output.
     */
    enabled: z.boolean().default(true),
    /**
     * Subdirectories that contain the vault. Defaults to the project root.
     * Use this when notes live alongside code (e.g. ['docs/vault']).
     */
    roots: z.array(z.string()).default([]),
    /**
     * Glob patterns the vault scanner picks up beyond the regular `include`
     * list. Useful when you keep the rest of the include narrow but still
     * want every `.md` under `roots` indexed.
     */
    extra_globs: z.array(z.string()).default(['**/*.md', '**/*.mdx', '**/*.markdown']),
  })
  .prefault({});

export const TraceMcpConfigSchema = z.object({
  root: z.string().default('.'),
  db: z
    .object({
      path: z.string().default('.trace-mcp/index.db'),
    })
    .prefault({}),
  include: z.array(z.string()).default([
    'src/**/*.{ts,tsx,js,jsx,py,go,rs,java,kt,rb,php,vue,svelte}',
    'lib/**/*.{ts,tsx,js,jsx,py,go,rs,java,kt,rb,php}',
    'app/**/*.{ts,tsx,js,jsx,php,rb,vue,svelte}',
    'test/**/*.{ts,tsx,js,jsx,py,go,rs,java,kt,rb,php}',
    'tests/**/*.{ts,tsx,js,jsx,py,go,rs,java,kt,rb,php}',
    'routes/**/*.{ts,js,php}',
    'database/migrations/**/*.php',
    'resources/js/**/*.{vue,ts,tsx,js,jsx}',
    'resources/assets/**/*.{vue,ts,tsx,js,jsx}',
    'resources/views/**/*.{blade.php,js}',
    // Laravel release-based deployments (e.g., resources/release-v8/js/...)
    'resources/release-*/**/*.{vue,ts,tsx,js,jsx}',
    // Public assets that are hand-written (not compiled)
    'public/js/**/*.js',
    // Laravel auto-registered package providers (composer.json extra.laravel)
    'composer.json',
    'nova-components/*/composer.json',
    'pages/**/*.{vue,ts,tsx,js,jsx}',
    'components/**/*.{vue,ts,tsx,js,jsx}',
    'composables/**/*.{ts,tsx,js,jsx}',
    'server/**/*.{ts,tsx,js,jsx}',
    // Markdown knowledge graph — Obsidian/Logseq/plain MD vaults
    '**/*.{md,mdx,markdown}',
  ]),
  exclude: z
    .array(z.string())
    .default([
      '**/vendor/**',
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/storage/**',
      '**/bootstrap/cache/**',
      '**/.nuxt/**',
      '**/.next/**',
      '**/.env',
      '**/.env.*',
    ]),
  ignore: IgnoreConfigSchema,
  frameworks: FrameworkConfigSchema,
  ai: AiConfigSchema,
  plugins: z.array(z.string()).default([]),
  security: SecurityConfigSchema,
  predictive: PredictiveConfigSchema,
  intent: IntentConfigSchema,
  runtime: RuntimeConfigSchema,
  lsp: LspConfigSchema,
  topology: TopologyConfigSchema,
  indexer: IndexerConfigSchema,
  pipeline: PipelineConfigSchema,
  vault: VaultConfigSchema,
  decisions: DecisionsConfigSchema,
  quality_gates: QualityGatesConfigSchema,
  telemetry: TelemetryConfigSchema,
  tools: ToolsConfigSchema,
  watch: z
    .object({
      enabled: z.boolean().default(true),
      debounceMs: z.number().int().min(500).max(30000).default(2000),
    })
    .prefault({}),
  logging: z
    .object({
      file: z.boolean().default(false),
      path: z.string().default('~/.trace-mcp/run.log'),
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      max_size_mb: z.number().positive().max(500).default(10),
    })
    .prefault({}),
  git: z
    .object({
      defaultBaseBranch: z
        .string()
        .max(256)
        .optional()
        .describe(
          'Default base branch for diff tools (e.g. "develop"). Auto-detects main/master if omitted.',
        ),
    })
    .prefault({}),
  /**
   * Minutes of stdin silence before the stdio process releases full-mode
   * resources (DB, indexer, watcher). The process itself stays alive and
   * re-initializes on the next client message. Set to 0 to disable.
   */
  idle_timeout_minutes: z.number().min(0).max(1440).default(30),
  /**
   * Seconds the daemon /health state must be stable before the stdio process
   * actually switches modes (promote/demote). Prevents flapping on a restart.
   */
  daemon_stability_seconds: z.number().min(0).max(600).default(30),
  /**
   * Milliseconds to wait for pending MCP requests to finish during a backend
   * swap. Requests still in-flight after this are answered with a synthetic
   * JSON-RPC error so the client doesn't hang.
   */
  backend_swap_drain_ms: z.number().min(0).max(60000).default(5000),
  /**
   * When the stdio CLI can't find a running daemon, try to spawn one instead
   * of immediately starting in local mode. Set to false for CI / sandboxed
   * environments where spawning detached processes is undesirable.
   */
  auto_spawn_daemon: z.boolean().default(true),
  /**
   * Seconds to wait for an auto-spawned daemon's /health to respond. If the
   * daemon isn't up in time, the stdio session falls back to local mode.
   */
  daemon_spawn_timeout_seconds: z.number().min(1).max(60).default(5),
  /**
   * Minutes the HTTP daemon (`serve-http`) stays alive with zero connected
   * clients before self-exiting. 0 disables (launchd-managed daemons get 0
   * automatically via TRACE_MCP_MANAGED_BY=launchd env).
   */
  daemon_idle_exit_minutes: z.number().min(0).max(1440).default(15),
  /**
   * Hermes Agent (NousResearch) session provider.
   *
   * - `enabled: 'auto'` (default) registers the provider; discovery is a no-op
   *   unless a state.db is actually found at the resolved Hermes home.
   * - `enabled: false` skips registration entirely.
   * - `home_override` replaces the default resolution order
   *   ($HERMES_HOME → ~/.hermes).
   * - `profile` scopes discovery to one profile under `<home>/profiles/<name>/`.
   *
   * Hermes sessions are global (no per-project binding); mining is gated
   * on the caller supplying a `project_root` — see mineSessions semantics.
   */
  hermes: z
    .object({
      enabled: z.union([z.literal('auto'), z.boolean()]).default('auto'),
      home_override: z.string().optional(),
      profile: z.string().optional(),
    })
    .prefault({}),
  children: z.array(z.string()).optional(),
});

export type TraceMcpConfig = z.infer<typeof TraceMcpConfigSchema>;

/** Validate an incoming config update against known section schemas.
 *  Returns an array of error strings (empty = valid). */
export function validateConfigUpdate(incoming: Record<string, unknown>): string[] {
  const sectionSchemas: Record<string, z.ZodTypeAny> = {
    ai: AiConfigSchema,
    security: SecurityConfigSchema,
    predictive: PredictiveConfigSchema,
    intent: IntentConfigSchema,
    runtime: RuntimeConfigSchema,
    lsp: LspConfigSchema,
    topology: TopologyConfigSchema,
    indexer: IndexerConfigSchema,
    pipeline: PipelineConfigSchema,
    quality_gates: QualityGatesConfigSchema,
    decisions: DecisionsConfigSchema,
    telemetry: TelemetryConfigSchema,
    tools: ToolsConfigSchema,
    ignore: IgnoreConfigSchema,
    frameworks: FrameworkConfigSchema,
    logging: z.object({
      file: z.boolean().optional(),
      path: z.string().optional(),
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
      max_size_mb: z.number().positive().max(500).optional(),
    }),
    watch: z.object({
      enabled: z.boolean().optional(),
      debounceMs: z.number().int().min(100).max(30000).optional(),
    }),
  };

  const rootSchema = z.object({
    auto_update: z.boolean().optional(),
    auto_update_check_interval_hours: z.number().positive().optional(),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  });

  const errors: string[] = [];

  // Validate known sections
  for (const [key, schema] of Object.entries(sectionSchemas)) {
    if (key in incoming && incoming[key] != null) {
      const result = (schema as z.ZodTypeAny).safeParse(incoming[key]);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push(`${key}.${issue.path.join('.')}: ${issue.message}`);
        }
      }
    }
  }

  // Validate root-level keys
  const rootPick: Record<string, unknown> = {};
  for (const key of ['auto_update', 'auto_update_check_interval_hours', 'logLevel']) {
    if (key in incoming) rootPick[key] = incoming[key];
  }
  if (Object.keys(rootPick).length > 0) {
    const result = rootSchema.safeParse(rootPick);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`${issue.path.join('.')}: ${issue.message}`);
      }
    }
  }

  return errors;
}

/** Load global config from ~/.trace-mcp/.config.json */
export function loadGlobalConfigRaw(): Record<string, unknown> {
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return {};
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')));
  } catch {
    return {};
  }
}

/** Load per-project config overrides via cosmiconfig (optional, for local overrides). */
async function loadProjectConfigRaw(searchFrom: string): Promise<Record<string, unknown>> {
  const explorer = cosmiconfig('trace-mcp', {
    searchPlaces: [
      '.trace-mcp/.config.json',
      '.trace-mcp.json',
      '.trace-mcp',
      '.config/trace-mcp.json',
      'package.json',
    ],
  });

  try {
    const result = await explorer.search(searchFrom);
    return result?.config ?? {};
  } catch {
    return {};
  }
}

/** Shallow-merge two raw configs: project overrides global per top-level key. */
function mergeConfigs(
  global: Record<string, unknown>,
  project: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...global };
  for (const [key, value] of Object.entries(project)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Load config for a project.
 * Merge order: global defaults → per-project overrides → Zod schema defaults.
 * The `projectRoot` key in the global config (keyed by absolute path) is also checked.
 */
export async function loadConfig(searchFrom?: string): Promise<TraceMcpResult<TraceMcpConfig>> {
  try {
    const globalRaw = loadGlobalConfigRaw();

    // Check if global config has per-project section
    let projectSection: Record<string, unknown> = {};
    if (searchFrom) {
      const projects = globalRaw.projects as Record<string, unknown> | undefined;
      if (projects?.[searchFrom]) {
        projectSection = projects[searchFrom] as Record<string, unknown>;
      }
    }

    // Remove 'projects' key from global raw — it's not part of TraceMcpConfig
    const { projects: _projects, ...globalDefaults } = globalRaw;

    // Load local cosmiconfig overrides (if any .trace-mcp.json exists in project)
    const localRaw = searchFrom ? await loadProjectConfigRaw(searchFrom) : {};

    // Merge: global defaults → per-project section from global config → local overrides
    let merged = mergeConfigs(globalDefaults as Record<string, unknown>, projectSection);
    merged = mergeConfigs(merged, localRaw);

    // Env var overrides
    if (process.env.TRACE_MCP_DB_PATH) {
      merged.db = merged.db ?? {};
      (merged.db as Record<string, unknown>).path = process.env.TRACE_MCP_DB_PATH;
    }
    if (process.env.TRACE_MCP_LOG_LEVEL) {
      // Log level is handled by pino directly
    }

    const parsed = TraceMcpConfigSchema.safeParse(merged);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return err(configError(`Config validation failed: ${issues}`));
    }

    // Normalize exclude patterns and ensure essential directories are always excluded.
    const essentialExcludes = ['**/vendor/**', '**/node_modules/**', '**/.git/**'];
    const deepExcludeDirs = [
      'vendor',
      'node_modules',
      '.git',
      'dist',
      'build',
      'out',
      'storage',
      'bootstrap/cache',
      '.nuxt',
      '.next',
    ];
    parsed.data.exclude = parsed.data.exclude.map((pattern) => {
      for (const dir of deepExcludeDirs) {
        if (pattern === `${dir}/**` || pattern === `${dir}`) {
          return `**/${dir}/**`;
        }
      }
      return pattern;
    });
    // Ensure essential excludes are present even if user config overrides defaults
    for (const essential of essentialExcludes) {
      if (!parsed.data.exclude.includes(essential)) {
        parsed.data.exclude.push(essential);
      }
    }

    logger.debug({ searchFrom: searchFrom ?? 'defaults' }, 'Config loaded');
    return ok(parsed.data);
  } catch (e) {
    return err(configError(e instanceof Error ? e.message : String(e)));
  }
}

/** Save per-project config section in the global config file (JSONC-safe). */
/** Remove a per-project config section from the global config file (JSONC-safe). */
export {
  removeProjectConfigJsonc as removeProjectConfig,
  saveProjectConfigJsonc as saveProjectConfig,
} from './config-jsonc.js';
