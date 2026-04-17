import { cosmiconfig } from 'cosmiconfig';
import { z } from 'zod';
import fs from 'node:fs';
import { ok, err, type TraceMcpResult } from './errors.js';
import { configError } from './errors.js';
import { logger } from './logger.js';
import { GLOBAL_CONFIG_PATH, stripJsonComments } from './global.js';

const SecurityConfigSchema = z.object({
  secret_patterns: z.array(z.string()).optional(),
  max_file_size_bytes: z.number().positive().optional(),
  max_files: z.number().positive().optional(),
}).optional();

const ArtisanConfigSchema = z.object({
  enabled: z.boolean().default(true),
  timeout: z.number().positive().default(10000),
}).optional();

const FrameworkConfigSchema = z.object({
  laravel: z.object({
    artisan: ArtisanConfigSchema,
    graceful_degradation: z.boolean().default(true),
  }).optional(),
}).optional();

const AiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['onnx', 'ollama', 'openai', 'anthropic', 'lmstudio', 'gemini', 'mistral', 'deepseek', 'groq', 'together', 'xai']).default('onnx'),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  inference_model: z.string().optional(),
  fast_model: z.string().optional(),
  embedding_model: z.string().optional(),
  embedding_dimensions: z.number().optional(),
  summarize_on_index: z.boolean().default(false),
  summarize_batch_size: z.number().positive().default(20),
  summarize_kinds: z.array(z.string()).default([
    'class', 'function', 'method', 'interface', 'trait', 'enum', 'type',
  ]),
  /** Max parallel requests to the AI provider (embedding + inference).
   *  Ollama-side: set OLLAMA_NUM_PARALLEL env var to match this value.
   *  On macOS desktop app: `launchctl setenv OLLAMA_NUM_PARALLEL <N>` + restart app.
   *  Or run from terminal: `OLLAMA_NUM_PARALLEL=<N> ollama serve`. */
  concurrency: z.number().int().min(1).max(32).default(1),
  reranker_model: z.string().optional(),
}).optional();

const PredictiveConfigSchema = z.object({
  enabled: z.boolean().default(true),
  weights: z.object({
    bug: z.object({
      churn: z.number().default(0.20),
      fix_ratio: z.number().default(0.20),
      complexity: z.number().default(0.20),
      coupling: z.number().default(0.15),
      pagerank: z.number().default(0.10),
      authors: z.number().default(0.15),
    }).default({}),
    tech_debt: z.object({
      complexity: z.number().default(0.30),
      coupling: z.number().default(0.25),
      test_gap: z.number().default(0.25),
      churn: z.number().default(0.20),
    }).default({}),
    change_risk: z.object({
      blast_radius: z.number().default(0.25),
      complexity: z.number().default(0.20),
      churn: z.number().default(0.20),
      test_gap: z.number().default(0.20),
      coupling: z.number().default(0.15),
    }).default({}),
  }).default({}),
  cache_ttl_minutes: z.number().default(60),
  git_since_days: z.number().default(180),
  module_depth: z.number().default(2),
}).optional();

const IntentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  domain_hints: z.record(z.string(), z.array(z.string())).optional(),
  custom_domains: z.array(z.object({
    name: z.string(),
    parent: z.string().optional(),
    description: z.string().optional(),
    path_patterns: z.array(z.string()),
  })).optional(),
  auto_classify_on_index: z.boolean().default(true),
  classify_batch_size: z.number().positive().default(100),
}).optional();

const RuntimeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  otlp: z.object({
    port: z.number().int().min(0).max(65535).default(4318),
    host: z.string().default('127.0.0.1'),
    max_body_bytes: z.number().positive().default(4 * 1024 * 1024),
  }).default({}),
  retention: z.object({
    max_span_age_days: z.number().positive().default(7),
    max_aggregate_age_days: z.number().positive().default(90),
    prune_interval: z.number().int().min(0).default(100),
  }).default({}),
  mapping: z.object({
    fqn_attributes: z.array(z.string()).default(['code.function', 'code.namespace', 'code.filepath']),
    route_patterns: z.array(z.string()).default(['^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s+(.+)$']),
  }).default({}),
}).optional();

const ToolDescriptionOverrideSchema = z.union([
  z.string(),                                // flat: replace entire tool description
  z.record(z.string(), z.string()),          // nested: _description + per-parameter overrides
]);

const ToolsConfigSchema = z.object({
  preset: z.string().default('full'),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  descriptions: z.record(z.string(), ToolDescriptionOverrideSchema).optional(),
  /** Global description verbosity: full (default), minimal (first sentence only), none (empty) */
  description_verbosity: z.enum(['full', 'minimal', 'none']).default('full'),
  /** Server instructions verbosity: full (default ~2K tokens), minimal (~200 tokens), none (empty) */
  instructions_verbosity: z.enum(['full', 'minimal', 'none']).default('full'),
  /** Control which meta fields appear in responses. true = all (default), false = none, or list specific fields to include */
  meta_fields: z.union([
    z.boolean(),
    z.array(z.enum(['_hints', '_budget_warning', '_budget_level', '_duplicate_warning', '_dedup', '_optimization_hint', '_meta', '_duplication_warnings', '_methodology'])),
  ]).default(true),
  /** Strip advanced/optional parameters from tool schemas to reduce token overhead (~40-60% schema size reduction). Only core parameters are exposed; advanced options still work if passed. */
  compact_schemas: z.boolean().default(false),
}).optional();

const QualityGatesRuleSchema = z.object({
  threshold: z.union([z.number(), z.string()]),
  severity: z.enum(['error', 'warning']).default('error'),
  scope: z.enum(['all', 'new_symbols', 'changed_symbols']).optional(),
  message: z.string().optional(),
});

const QualityGatesConfigSchema = z.object({
  enabled: z.boolean().default(true),
  fail_on: z.enum(['error', 'warning', 'none']).default('error'),
  rules: z.object({
    max_cyclomatic_complexity: QualityGatesRuleSchema.optional(),
    max_coupling_instability: QualityGatesRuleSchema.optional(),
    max_circular_import_chains: QualityGatesRuleSchema.optional(),
    max_dead_exports_percent: QualityGatesRuleSchema.optional(),
    max_tech_debt_grade: QualityGatesRuleSchema.optional(),
    max_security_critical_findings: QualityGatesRuleSchema.optional(),
    max_antipattern_count: QualityGatesRuleSchema.optional(),
    max_code_smell_count: QualityGatesRuleSchema.optional(),
  }).default({}),
}).optional();

const IgnoreConfigSchema = z.object({
  /** Extra directory names to skip during indexing (added to built-in list). */
  directories: z.array(z.string()).default([]),
  /** Extra gitignore-style patterns to exclude from indexing. */
  patterns: z.array(z.string()).default([]),
}).default({});

const LspServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  initializationOptions: z.record(z.string(), z.unknown()).optional(),
  rootUri: z.string().optional(),
  timeout_ms: z.number().int().min(1000).max(120000).default(30000),
});

const LspConfigSchema = z.object({
  enabled: z.boolean().default(false),
  servers: z.record(z.string(), LspServerConfigSchema).default({}),
  auto_detect: z.boolean().default(true),
  max_concurrent_servers: z.number().int().min(1).max(4).default(2),
  enrichment_timeout_ms: z.number().int().min(5000).max(600000).default(120000),
  batch_size: z.number().int().min(10).max(1000).default(100),
}).optional();

const TopologyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  repos: z.array(z.string()).default([]),
  auto_detect: z.boolean().default(true),
  auto_discover: z.boolean().default(true),
  contract_globs: z.array(z.string()).optional(),
}).optional();

export const TraceMcpConfigSchema = z.object({
  root: z.string().default('.'),
  db: z.object({
    path: z.string().default('.trace-mcp/index.db'),
  }).default({}),
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
  ]),
  exclude: z.array(z.string()).default([
    '**/vendor/**', '**/node_modules/**', '**/.git/**',
    '**/dist/**', '**/build/**', '**/out/**',
    '**/storage/**', '**/bootstrap/cache/**', '**/.nuxt/**', '**/.next/**',
    '**/.env', '**/.env.*',
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
  quality_gates: QualityGatesConfigSchema,
  tools: ToolsConfigSchema,
  watch: z.object({
    enabled: z.boolean().default(true),
    debounceMs: z.number().int().min(500).max(30000).default(2000),
  }).default({}),
  logging: z.object({
    file: z.boolean().default(false),
    path: z.string().default('~/.trace-mcp/run.log'),
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    max_size_mb: z.number().positive().max(500).default(10),
  }).default({}),
  git: z.object({
    defaultBaseBranch: z.string().max(256).optional().describe('Default base branch for diff tools (e.g. "develop"). Auto-detects main/master if omitted.'),
  }).default({}),
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
    quality_gates: QualityGatesConfigSchema,
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
function mergeConfigs(global: Record<string, unknown>, project: Record<string, unknown>): Record<string, unknown> {
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
      if (projects && projects[searchFrom]) {
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
    const deepExcludeDirs = ['vendor', 'node_modules', '.git', 'dist', 'build', 'out', 'storage', 'bootstrap/cache', '.nuxt', '.next'];
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
export { saveProjectConfigJsonc as saveProjectConfig } from './config-jsonc.js';

/** Remove a per-project config section from the global config file (JSONC-safe). */
export { removeProjectConfigJsonc as removeProjectConfig } from './config-jsonc.js';
