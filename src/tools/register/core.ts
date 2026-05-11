import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { optionalNonEmptyString } from './_zod-helpers.js';
import { EmbeddingPipeline } from '../../ai/embedding-pipeline.js';
import { repairIndex, type RepairMode } from '../../db/repair.js';
import { verifyIndex } from '../../db/verify.js';
import { LOCKS_DIR, projectHash } from '../../global.js';
import { IndexingPipeline } from '../../indexer/pipeline.js';
import { buildProjectContext } from '../../indexer/project-context.js';
import { shouldSkipRecentReindex } from '../../indexer/recent-reindex-cache.js';
import { logger } from '../../logger.js';
import type { ServerContext } from '../../server/types.js';
import { LockError, withLock } from '../../utils/pid-lock.js';
import { checkFileForDuplicates } from '../analysis/duplication.js';
import { getMinimalContext } from '../project/minimal-context.js';
import { getIndexHealth, getProjectMap } from '../project/project.js';

export function registerCoreTools(server: McpServer, ctx: ServerContext): void {
  const {
    store,
    registry,
    config,
    projectRoot,
    guardPath,
    j,
    jh,
    journal,
    vectorStore,
    embeddingService,
    progress,
  } = ctx;

  // --- Core Tools (always registered) ---

  server.tool(
    'get_index_health',
    'Get index status, statistics, health information, and pipeline progress (indexing, summarization, embedding). Read-only, no side effects. Use to verify the index is ready before running queries. Returns JSON: { totalFiles, totalSymbols, languages, frameworks, pipelineProgress }.',
    {},
    async () => {
      const result = getIndexHealth(store, config);
      if (ctx.progress) {
        result.progress = ctx.progress.snapshot();
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'reindex',
    'Trigger (re)indexing of the project or a subdirectory. Mutates the local index (SQLite). Use after major file changes; for single-file updates prefer register_edit instead. The optional `postprocess` flag controls how much work runs after raw symbol extraction: "full" (default) does everything; "minimal" skips LSP enrichment + env-var scan + git history snapshots (~30-50% faster on warm CI runs); "none" also skips edge resolution and gives you raw symbols only. Idempotent — safe to re-run. Returns JSON: { status, totalFiles, indexed, skipped, errors, durationMs, postprocess }.',
    {
      path: z
        .string()
        .max(512)
        .optional()
        .describe('Subdirectory to index (default: project root)'),
      force: z.boolean().optional().describe('Skip hash check and reindex all files'),
      postprocess: z
        .enum(['full', 'minimal', 'none'])
        .optional()
        .describe(
          'Postprocess level. full = everything (default). minimal = skips LSP/env/snapshots. none = also skips edge resolution.',
        ),
    },
    async ({ path: indexPath, force, postprocess }) => {
      if (indexPath) {
        const blocked = guardPath(indexPath);
        if (blocked) return blocked;
      }
      logger.info({ path: indexPath, force, postprocess }, 'Reindex requested');
      const pipeline = new IndexingPipeline(store, registry, config, projectRoot);

      try {
        const result = await withLock(
          { lockDir: LOCKS_DIR, name: `${projectHash(projectRoot)}-reindex`, op: 'reindex' },
          async () =>
            indexPath
              ? pipeline.indexFiles([indexPath], { postprocess })
              : pipeline.indexAll(force ?? false, { postprocess }),
        );
        return { content: [{ type: 'text', text: j({ status: 'completed', ...result }) }] };
      } catch (e) {
        if (e instanceof LockError) {
          return {
            content: [
              {
                type: 'text',
                text: j({
                  status: 'busy',
                  error: 'reindex_in_progress',
                  message: e.message,
                  holder: e.holder,
                }),
              },
            ],
            isError: true,
          };
        }
        throw e;
      }
    },
  );

  server.tool(
    'embed_repo',
    'Precompute and cache symbol embeddings for semantic / hybrid search. Embeddings are also computed lazily on first semantic query, but calling this once after a fresh index avoids the first-query latency spike. Requires AI provider to be enabled in config (ollama/openai). Set force=true to drop and recompute all existing embeddings. Mutates the vector store; idempotent. Use after reindex when you plan to use semantic search. Returns JSON: { status, indexed_this_run, total_embedded, coverage_pct, duration_ms }.',
    {
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Symbols per embedding API batch (default 50)'),
      force: z
        .boolean()
        .optional()
        .describe('Drop existing embeddings and re-embed everything (default false — incremental)'),
    },
    async ({ batch_size, force }) => {
      if (!vectorStore || !embeddingService) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                status: 'disabled',
                message:
                  'Semantic search disabled. Enable an AI provider in trace-mcp.config.json (ai.enabled=true, ai.provider=ollama|openai).',
              }),
            },
          ],
          isError: true,
        };
      }
      logger.info({ force, batch_size }, 'embed_repo requested');
      const pipeline = new EmbeddingPipeline(
        store,
        embeddingService,
        vectorStore,
        progress ?? undefined,
      );
      try {
        const startedAt = Date.now();
        const indexed = await withLock(
          { lockDir: LOCKS_DIR, name: `${projectHash(projectRoot)}-embed`, op: 'embed_repo' },
          async () => (force ? pipeline.reindexAll() : pipeline.indexUnembedded(batch_size ?? 50)),
        );
        const totalEmbedded = vectorStore.count();
        const totalSymbols = store.getStats().totalSymbols;
        return {
          content: [
            {
              type: 'text',
              text: j({
                status: 'completed',
                indexed_this_run: indexed,
                total_embedded: totalEmbedded,
                total_symbols: totalSymbols,
                coverage_pct:
                  totalSymbols > 0 ? Math.round((totalEmbedded / totalSymbols) * 100) : 0,
                duration_ms: Date.now() - startedAt,
                force: !!force,
              }),
            },
          ],
        };
      } catch (e) {
        if (e instanceof LockError) {
          return {
            content: [
              {
                type: 'text',
                text: j({
                  status: 'busy',
                  error: 'embed_repo_in_progress',
                  message: e.message,
                  holder: e.holder,
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: j({
                status: 'error',
                error: e instanceof Error ? e.message : String(e),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'verify_index',
    'Read-only structural check of the local SQLite index: SQLite integrity_check, foreign-key violations, required-table presence, FTS5 integrity-check, embedding dimension consistency, and orphan embedding detection. Returns a check-by-check report with status (ok/warn/error) and a suggested repair mode for any non-ok finding. Never writes. Use as a preflight before reindex/embed_repo or when search is misbehaving. Returns JSON: { ok, status, checks: [{ name, status, detail, count?, suggested_repair? }] }.',
    {},
    async () => {
      const report = verifyIndex(store.db);
      return {
        content: [{ type: 'text', text: j(report) }],
        isError: report.status === 'error',
      };
    },
  );

  server.tool(
    'repair_index',
    'Apply a targeted repair to the local SQLite index. Modes: drop-orphans (delete embedding rows whose symbol_id no longer exists), drop-vec (drop the entire vector store — search falls back to BM25; embed_repo rebuilds), rebuild-fts (drop and reload symbols_fts from the symbols table). Each mode runs in a transaction so a partial failure leaves the DB unchanged. DESTRUCTIVE — verify_index first to find out which mode is needed. Returns JSON: { mode, ok, detail, affected }.',
    {
      mode: z
        .enum(['drop-orphans', 'drop-vec', 'rebuild-fts'])
        .describe(
          'Repair mode: drop-orphans, drop-vec (forces a re-embed), or rebuild-fts (refreshes the FTS5 inverted index from symbols).',
        ),
    },
    async ({ mode }) => {
      try {
        const result = await withLock(
          { lockDir: LOCKS_DIR, name: `${projectHash(projectRoot)}-repair`, op: 'repair_index' },
          async () => repairIndex(store.db, mode as RepairMode),
        );
        return { content: [{ type: 'text', text: j(result) }] };
      } catch (e) {
        if (e instanceof LockError) {
          return {
            content: [
              {
                type: 'text',
                text: j({
                  status: 'busy',
                  error: 'index_busy',
                  message: e.message,
                  holder: e.holder,
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: j({
                ok: false,
                mode,
                detail: e instanceof Error ? e.message : String(e),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'register_edit',
    'Notify trace-mcp that a file was edited. Reindexes the single file and invalidates search caches. Call after Edit/Write to keep index fresh — much lighter than full reindex. Also checks for duplicate symbols — if `_duplication_warnings` appears in the response, you may be recreating existing logic; review the referenced symbols before continuing. Mutates the index; idempotent. Returns JSON: { status, file, totalFiles, indexed, _duplication_warnings? }.',
    {
      file_path: z.string().min(1).max(512).describe('Relative path to the edited file'),
    },
    async ({ file_path: filePath }) => {
      const blocked = guardPath(filePath);
      if (blocked) return blocked;

      // Phase 1.3 dedup: skip when the PostToolUse hook (or another caller)
      // already reindexed this file in the last 500 ms. Journaling still runs
      // so observability is preserved.
      // Key must match the HTTP handler's normalization (POSIX-relative)
      // so the two paths collide on the same file regardless of input form.
      const absForDedup = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(projectRoot, filePath);
      const relForDedup = path.relative(projectRoot, absForDedup);
      const dedupKey = path.sep === '\\' ? relForDedup.split('\\').join('/') : relForDedup;
      if (shouldSkipRecentReindex(projectRoot, dedupKey)) {
        journal.record('register_edit', { file_path: filePath, skipped_recent: true }, 1);
        return {
          content: [
            {
              type: 'text',
              text: j({
                status: 'skipped_recent',
                file: filePath,
                skipped_recent: true,
              }),
            },
          ],
        };
      }

      const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
      let result: Awaited<ReturnType<typeof pipeline.indexFiles>>;
      try {
        // Share the reindex lock so a single-file edit cannot race with a
        // running full-project reindex. The two paths mutate the same SQLite
        // database (and vector store), and concurrent writers were called out
        // as a corruption risk in the original PID-guard rollout.
        result = await withLock(
          { lockDir: LOCKS_DIR, name: `${projectHash(projectRoot)}-reindex`, op: 'register_edit' },
          () => pipeline.indexFiles([filePath]),
        );
      } catch (e) {
        if (e instanceof LockError) {
          return {
            content: [
              {
                type: 'text',
                text: j({
                  status: 'busy',
                  error: 'reindex_in_progress',
                  message: e.message,
                  holder: e.holder,
                }),
              },
            ],
            isError: true,
          };
        }
        throw e;
      }

      // Record in journal so session knows this file was edited
      journal.record('register_edit', { file_path: filePath }, 1);

      // Best-effort duplication check — never fails register_edit
      let dupWarnings: {
        message: string;
        score: number;
        duplicate_symbol_id: string;
        duplicate_file: string;
      }[] = [];
      try {
        const dup = checkFileForDuplicates(store, store.db, filePath, {
          threshold: 0.7,
          maxResults: 5,
        });
        dupWarnings = dup.warnings.map((w) => ({
          message: `"${w.source_name}" is similar to "${w.duplicate_name}" in ${w.duplicate_file}:${w.duplicate_line ?? '?'}`,
          score: w.score,
          duplicate_symbol_id: w.duplicate_symbol_id,
          duplicate_file: w.duplicate_file,
        }));
      } catch {
        /* non-fatal */
      }

      return {
        content: [
          {
            type: 'text',
            text: j({
              status: 'reindexed',
              file: filePath,
              ...result,
              ...(dupWarnings.length > 0 ? { _duplication_warnings: dupWarnings } : {}),
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'get_minimal_context',
    'Single-call orientation context (~150 tokens). Returns project shape, top 3 risk hotspots, top 3 PageRank-central files, top 3 communities, and 3-5 task-routed next-tool suggestions. Use at session start instead of chaining get_project_map + get_pagerank + get_risk_hotspots + get_communities. The optional `task` argument biases the suggestions toward review / refactor / debug / add_feature / understand. Read-only. Returns JSON: { project, health, communities, next_steps }.',
    {
      task: z
        .string()
        .max(500)
        .optional()
        .describe(
          'Natural-language description of what you are about to do — drives the next_steps ranking. If omitted, returns the "understand" suggestion set.',
        ),
      intent: z
        .enum(['understand', 'review', 'refactor', 'debug', 'add_feature'])
        .optional()
        .describe('Explicit intent override. Wins over keyword inference from `task`.'),
    },
    async ({ task, intent }) => {
      const projectCtx = buildProjectContext(projectRoot);
      const result = getMinimalContext(store, registry, config, projectRoot, projectCtx, {
        task,
        intent,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_project_map',
    'Get project overview: detected frameworks, languages, file counts, structure. Read-only, no side effects. Call with summary_only=true at session start to orient yourself before diving into code. Use instead of manual ls/find. Returns JSON: { frameworks, languages, fileCount, symbolCount, structure }.',
    {
      summary_only: z
        .boolean()
        .optional()
        .describe('Return only framework list + counts (default false)'),
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
    'List environment variable keys from .env files with inferred value types/formats. Never exposes actual values — only keys, types (string/number/boolean/empty), and formats (url/email/ip/path/uuid/json/base64/csv/dsn/etc). Read-only, no side effects, safe for secrets. Use to understand project configuration without accessing actual values. Returns JSON grouped by file: { [file]: [{ key, type, format, comment }] }.',
    {
      pattern: z
        .string()
        .max(256)
        .optional()
        .describe('Filter keys by pattern (e.g. "DB_" or "REDIS")'),
      file: optionalNonEmptyString(512).describe('Filter by specific .env file path'),
    },
    async ({ pattern, file }) => {
      let vars = pattern ? store.searchEnvVars(pattern) : store.getAllEnvVars();

      if (file) {
        vars = vars.filter((v) => v.file_path === file || v.file_path.endsWith(file));
      }

      if (vars.length === 0) {
        return {
          content: [
            { type: 'text', text: 'No env vars found. Run indexing first or adjust the filter.' },
          ],
        };
      }

      // Group by file
      const grouped: Record<
        string,
        { key: string; type: string; format: string | null; comment: string | null }[]
      > = {};
      for (const v of vars) {
        const arr = (grouped[v.file_path] ??= []);
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
