import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../../server/types.js';
import { logger } from '../../logger.js';
import { IndexingPipeline } from '../../indexer/pipeline.js';
import { buildProjectContext } from '../../indexer/project-context.js';
import { getIndexHealth, getProjectMap } from '../project/project.js';
import { checkFileForDuplicates } from '../analysis/duplication.js';

export function registerCoreTools(server: McpServer, ctx: ServerContext): void {
  const { store, registry, config, projectRoot, guardPath, j, jh, journal } = ctx;

  // --- Core Tools (always registered) ---

  server.tool(
    'get_index_health',
    'Get index status, statistics, and health information',
    {},
    async () => {
      const result = getIndexHealth(store, config);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'reindex',
    'Trigger (re)indexing of the project or a subdirectory',
    {
      path: z.string().max(512).optional().describe('Subdirectory to index (default: project root)'),
      force: z.boolean().optional().describe('Skip hash check and reindex all files'),
    },
    async ({ path: indexPath, force }) => {
      if (indexPath) {
        const blocked = guardPath(indexPath);
        if (blocked) return blocked;
      }
      logger.info({ path: indexPath, force }, 'Reindex requested');
      const pipeline = new IndexingPipeline(store, registry, config, projectRoot);

      const result = indexPath
        ? await pipeline.indexFiles([indexPath])
        : await pipeline.indexAll(force ?? false);

      return { content: [{ type: 'text', text: j({ status: 'completed', ...result }) }] };
    },
  );

  server.tool(
    'register_edit',
    'Notify trace-mcp that a file was edited. Reindexes the single file and invalidates search caches that reference it. Call after using Edit/Write tools to keep the index fresh — much lighter than full reindex.',
    {
      file_path: z.string().min(1).max(512).describe('Relative path to the edited file'),
    },
    async ({ file_path: filePath }) => {
      const blocked = guardPath(filePath);
      if (blocked) return blocked;

      const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
      const result = await pipeline.indexFiles([filePath]);

      // Record in journal so session knows this file was edited
      journal.record('register_edit', { file_path: filePath }, 1);

      // Best-effort duplication check — never fails register_edit
      let dupWarnings: { message: string; score: number; duplicate_symbol_id: string; duplicate_file: string }[] = [];
      try {
        const dup = checkFileForDuplicates(store, store.db, filePath, { threshold: 0.70, maxResults: 5 });
        dupWarnings = dup.warnings.map((w) => ({
          message: `"${w.source_name}" is similar to "${w.duplicate_name}" in ${w.duplicate_file}:${w.duplicate_line ?? '?'}`,
          score: w.score,
          duplicate_symbol_id: w.duplicate_symbol_id,
          duplicate_file: w.duplicate_file,
        }));
      } catch { /* non-fatal */ }

      return {
        content: [{
          type: 'text',
          text: j({
            status: 'reindexed',
            file: filePath,
            ...result,
            ...(dupWarnings.length > 0 ? { _duplication_warnings: dupWarnings } : {}),
          }),
        }],
      };
    },
  );

  server.tool(
    'get_project_map',
    'Get project overview: detected frameworks, languages, file counts, structure. Call with summary_only=true at session start to orient yourself before diving into code.',
    {
      summary_only: z.boolean().optional().describe('Return only framework list + counts (default false)'),
    },
    async ({ summary_only }) => {
      const ctx = buildProjectContext(projectRoot);
      const result = getProjectMap(store, registry, summary_only ?? false, ctx);
      return { content: [{ type: 'text', text: jh('get_project_map', result) }] };
    },
  );

  // --- Env Vars Tool ---

  server.tool(
    'get_env_vars',
    'List environment variable keys from .env files with inferred value types/formats. Never exposes actual values — only keys, types (string/number/boolean/empty), and formats (url/email/ip/path/uuid/json/base64/csv/dsn/etc). Use to understand project configuration without accessing secrets.',
    {
      pattern: z.string().max(256).optional().describe('Filter keys by pattern (e.g. "DB_" or "REDIS")'),
      file: z.string().max(512).optional().describe('Filter by specific .env file path'),
    },
    async ({ pattern, file }) => {
      let vars = pattern ? store.searchEnvVars(pattern) : store.getAllEnvVars();

      if (file) {
        vars = vars.filter((v) => v.file_path === file || v.file_path.endsWith(file));
      }

      if (vars.length === 0) {
        return { content: [{ type: 'text', text: 'No env vars found. Run indexing first or adjust the filter.' }] };
      }

      // Group by file
      const grouped: Record<string, { key: string; type: string; format: string | null; comment: string | null }[]> = {};
      for (const v of vars) {
        const arr = grouped[v.file_path] ??= [];
        arr.push({
          key: v.key,
          type: v.value_type,
          format: v.value_format,
          comment: v.comment,
        });
      }

      return { content: [{ type: 'text', text: j(grouped) }] };
    },
  );
}
