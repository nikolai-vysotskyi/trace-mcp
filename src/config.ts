import { cosmiconfig } from 'cosmiconfig';
import { z } from 'zod';
import { ok, err, type TraceMcpResult } from './errors.js';
import { configError } from './errors.js';
import { logger } from './logger.js';

const SecurityConfigSchema = z.object({
  secret_patterns: z.array(z.string()).optional(),
  max_file_size_bytes: z.number().positive().optional(),
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

export const TraceMcpConfigSchema = z.object({
  root: z.string().default('.'),
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
  db: z.object({
    path: z.string().default('.trace-mcp/index.db'),
  }).default({}),
  frameworks: FrameworkConfigSchema,
  ai: AiConfigSchema,
  plugins: z.array(z.string()).default([]),
  security: SecurityConfigSchema,
});

export type TraceMcpConfig = z.infer<typeof TraceMcpConfigSchema>;

export async function loadConfig(searchFrom?: string): Promise<TraceMcpResult<TraceMcpConfig>> {
  const explorer = cosmiconfig('trace-mcp', {
    searchPlaces: [
      '.trace-mcp.json',
      '.trace-mcp',
      '.config/trace-mcp.json',
      'package.json',
    ],
  });

  try {
    const result = searchFrom
      ? await explorer.search(searchFrom)
      : await explorer.search();

    const rawConfig = result?.config ?? {};

    // Env var overrides
    if (process.env.TRACE_MCP_DB_PATH) {
      rawConfig.db = rawConfig.db ?? {};
      rawConfig.db.path = process.env.TRACE_MCP_DB_PATH;
    }

    if (process.env.TRACE_MCP_LOG_LEVEL) {
      // Log level is handled by pino directly, but note it's available
    }

    const parsed = TraceMcpConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return err(configError(`Config validation failed: ${issues}`));
    }

    logger.debug({ configPath: result?.filepath ?? 'defaults' }, 'Config loaded');
    return ok(parsed.data);
  } catch (e) {
    return err(configError(e instanceof Error ? e.message : String(e)));
  }
}
