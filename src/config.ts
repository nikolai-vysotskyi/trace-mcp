import { cosmiconfig } from 'cosmiconfig';
import { z } from 'zod';
import fs from 'node:fs';
import { ok, err, type TraceMcpResult } from './errors.js';
import { configError } from './errors.js';
import { logger } from './logger.js';
import { GLOBAL_CONFIG_PATH, ensureGlobalDirs } from './global.js';

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
  provider: z.enum(['ollama', 'openai']).default('ollama'),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  inference_model: z.string().optional(),
  fast_model: z.string().optional(),
  embedding_model: z.string().optional(),
  embedding_dimensions: z.number().optional(),
  summarize_on_index: z.boolean().default(true),
  summarize_batch_size: z.number().positive().default(20),
  summarize_kinds: z.array(z.string()).default([
    'class', 'function', 'method', 'interface', 'trait', 'enum', 'type',
  ]),
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

const ToolsConfigSchema = z.object({
  preset: z.string().default('full'),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  descriptions: z.record(z.string(), z.string()).optional(),
}).optional();

const TopologyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  repos: z.array(z.string()).default([]),
  auto_detect: z.boolean().default(true),
  auto_federation: z.boolean().default(true),
  contract_globs: z.array(z.string()).optional(),
}).optional();

export const TraceMcpConfigSchema = z.object({
  root: z.string().default('.'),
  db: z.object({
    path: z.string().default('.trace-mcp/index.db'),
  }).default({}),
  include: z.array(z.string()).default([
    'app/**/*.php',
    'routes/**/*.php',
    'database/migrations/**/*.php',
    'resources/js/**/*.{vue,ts,tsx,js,jsx}',
    'resources/views/**/*.blade.php',
  ]),
  exclude: z.array(z.string()).default([
    'vendor/**', 'node_modules/**', '.git/**',
    'storage/**', 'bootstrap/cache/**', '.nuxt/**',
    '**/.env', '**/.env.*',
  ]),
  frameworks: FrameworkConfigSchema,
  ai: AiConfigSchema,
  plugins: z.array(z.string()).default([]),
  security: SecurityConfigSchema,
  predictive: PredictiveConfigSchema,
  intent: IntentConfigSchema,
  runtime: RuntimeConfigSchema,
  topology: TopologyConfigSchema,
  tools: ToolsConfigSchema,
});

export type TraceMcpConfig = z.infer<typeof TraceMcpConfigSchema>;

/** Load global config from ~/.trace-mcp/.config.json */
function loadGlobalConfigRaw(): Record<string, unknown> {
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/** Load per-project config overrides via cosmiconfig (optional, for local overrides). */
async function loadProjectConfigRaw(searchFrom: string): Promise<Record<string, unknown>> {
  const explorer = cosmiconfig('trace-mcp', {
    searchPlaces: [
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

    logger.debug({ searchFrom: searchFrom ?? 'defaults' }, 'Config loaded');
    return ok(parsed.data);
  } catch (e) {
    return err(configError(e instanceof Error ? e.message : String(e)));
  }
}

/** Save global config to ~/.trace-mcp/.config.json (preserving existing content). */
export function saveGlobalConfig(updates: Record<string, unknown>): void {
  ensureGlobalDirs();
  const existing = loadGlobalConfigRaw();
  const merged = { ...existing, ...updates };
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n');
}

/** Save per-project config section in the global config file. */
export function saveProjectConfig(projectRoot: string, config: Record<string, unknown>): void {
  ensureGlobalDirs();
  const existing = loadGlobalConfigRaw();
  const projects = (existing.projects as Record<string, unknown>) ?? {};
  projects[projectRoot] = config;
  existing.projects = projects;
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(existing, null, 2) + '\n');
}
