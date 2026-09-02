import fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { optionalNonEmptyString } from '../_zod-helpers.js';
import { formatToolError, notFound } from '../../../errors.js';
import { LOCKS_DIR, projectHash } from '../../../global.js';
import { IndexingPipeline } from '../../../indexer/pipeline.js';
import { decisionsForImpact } from '../../../memory/enrichment.js';
import { aggregateFreshness, computeFileFreshness } from '../../../scoring/freshness.js';
import { computeRetrievalConfidence } from '../../../scoring/retrieval-confidence.js';
import type { ServerContext } from '../../../server/types.js';
import { validatePath } from '../../../utils/security.js';
import { withLock } from '../../../utils/pid-lock.js';
import { getChangeImpact } from '../../analysis/impact.js';
import { getFileOutline, getSymbol } from '../../navigation/navigation.js';
import { getRelatedSymbols } from '../../navigation/related.js';
import { fallbackOutline } from '../../navigation/zero-index.js';
import { CHANGE_IMPACT_METHODOLOGY } from '../../shared/confidence.js';
import { buildEmptyResultNote } from '../../shared/empty-note.js';
import { compactOutlineSymbols, DetailLevelSchema, isMinimal } from '../../_common/detail-level.js';
import { OutputFormatSchema, encodeResponse } from '../../_common/output-format.js';

/**
 * On a get_outline miss, the file may simply not be indexed yet (new/renamed
 * file, cold start). Rather than surface a bare NOT_FOUND that pushes the
 * caller to a full Read, parse just this one file on demand — the same
 * single-file path `register_edit` already uses — and retry. Returns true
 * when the retry is worth attempting (the file exists on disk).
 */
async function autoIndexOnDemand(ctx: ServerContext, filePath: string): Promise<boolean> {
  const checked = validatePath(filePath, ctx.projectRoot);
  if (checked.isErr()) return false;
  if (!fs.existsSync(checked.value)) return false;
  try {
    const pipeline = new IndexingPipeline(ctx.store, ctx.registry, ctx.config, ctx.projectRoot);
    await withLock(
      {
        lockDir: LOCKS_DIR,
        name: `${projectHash(ctx.projectRoot)}-reindex`,
        op: 'get_outline-autoindex',
      },
      () => pipeline.indexFiles([filePath]),
    );
  } catch {
    // Best-effort: fall through and let the caller re-check the store.
  }
  return true;
}

/**
 * Registers direct symbol/file lookup tools: `get_symbol`, `get_outline`,
 * `get_related_symbols`, and `get_change_impact`. These are the "point
 * queries" of the navigation surface — given an id/path, return its
 * source/signature/impact, as opposed to the open-ended `search` tool.
 */
export function registerLookupTools(server: McpServer, ctx: ServerContext): void {
  const { store, projectRoot, guardPath, j, jh, markExplored, decisionStore } = ctx;

  server.tool(
    'get_symbol',
    'Look up a symbol by symbol_id or FQN and return its source code. Use instead of Read when you need one specific function/class/method — returns only the symbol, not the whole file. For multiple symbols at once, prefer get_context_bundle. Read-only. Returns JSON: { symbol_id, name, kind, fqn, signature, file, line_start, line_end, source }.',
    {
      symbol_id: optionalNonEmptyString(512).describe('The symbol_id to look up'),
      fqn: optionalNonEmptyString(512).describe('The fully qualified name to look up'),
      max_lines: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .describe('Truncate source to this many lines (omit for full source)'),
      verify_against_git: z
        .boolean()
        .optional()
        .describe(
          'Compare the indexed source against the current git HEAD slice; mismatches set `git_mismatch: true` in the response (index may be stale). Read-only. Silently skipped when git is unavailable or the file is untracked.',
        ),
    },
    async ({ symbol_id, fqn, max_lines, verify_against_git }) => {
      const result = getSymbol(store, projectRoot, {
        symbolId: symbol_id,
        fqn,
        maxLines: max_lines,
        verifyAgainstGit: verify_against_git,
      });
      if (result.isErr()) {
        const error =
          result.error.code === 'NOT_FOUND' && !result.error.reason
            ? notFound(result.error.id, result.error.candidates, 'unknown_symbol')
            : result.error;
        return {
          content: [{ type: 'text', text: j(formatToolError(error)) }],
          isError: true,
        };
      }
      const { symbol, file, source, truncated, git_mismatch } = result.value;
      markExplored(file.path);
      // Phase 4a: attribute this read to a recent ranked retrieval event when possible.
      ctx.rankingLedger?.recordAcceptance(projectRoot, symbol.symbol_id);
      const freshness = computeFileFreshness(projectRoot, file);
      const summary = aggregateFreshness([freshness]);
      const confidence = computeRetrievalConfidence({
        scores: [1],
        topName: symbol.name,
        topFqn: symbol.fqn ?? null,
        query: symbol.name,
        freshnessSummary: summary,
      });
      return {
        content: [
          {
            type: 'text',
            text: jh('get_symbol', {
              symbol_id: symbol.symbol_id,
              name: symbol.name,
              kind: symbol.kind,
              fqn: symbol.fqn,
              signature: symbol.signature,
              summary: symbol.summary,
              file: file.path,
              line_start: symbol.line_start,
              line_end: symbol.line_end,
              source,
              ...(truncated ? { truncated: true } : {}),
              ...(git_mismatch ? { git_mismatch: true } : {}),
              _freshness: freshness,
              _meta: {
                freshness: summary,
                ...(confidence
                  ? {
                      confidence: confidence.confidence,
                      confidence_signals: confidence.signals,
                    }
                  : {}),
              },
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'get_outline',
    'Get all symbols for a file (signatures only, no bodies) — cheaper than Read for understanding a file before editing. Follow up with get_symbol to read one symbol\'s source. `nested: true` expands large top-level symbols (default ≥100 LOC) into inner declarations, each carrying `parentId` + `depth` (max 3). Read-only. Returns JSON: { path, language, symbols: [{ symbolId, name, kind, signature, lineStart, lineEnd, parentId?, depth? }] }. Supports `output_format: "toon"`.',
    {
      path: z.string().max(512).describe('Relative file path'),
      detail_level: DetailLevelSchema,
      nested: z
        .boolean()
        .optional()
        .describe(
          'Walk the body of each top-level symbol past min_loc_for_nesting and emit inner declarations as extra rows carrying `parentId` + `depth`. Default false.',
        ),
      min_loc_for_nesting: z
        .number()
        .int()
        .min(10)
        .max(10000)
        .optional()
        .describe(
          'Minimum (line_end - line_start) for a top-level symbol to be expanded when nested=true. Default 100.',
        ),
      output_format: OutputFormatSchema.describe(
        '"json" (default) or "toon" (lossless, 30-60% fewer tokens). "markdown" is unsupported here and behaves as json.',
      ),
    },
    async ({ path: filePath, detail_level, nested, min_loc_for_nesting, output_format }) => {
      const encode = (payload: unknown): string =>
        output_format === 'toon' ? encodeResponse(payload, 'toon') : jh('get_outline', payload);
      const blocked = guardPath(filePath);
      if (blocked) return blocked;

      // Zero-index fallback: if index is empty, use regex-based extraction
      const stats = store.getStats();
      if (stats.totalFiles === 0) {
        try {
          const fbResult = fallbackOutline(projectRoot, filePath);
          return {
            content: [
              {
                type: 'text',
                text: encode({
                  ...fbResult,
                  _hint: 'Index is empty. Run reindex to enable full symbol extraction.',
                }),
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: j({ error: 'File not found or unreadable (index is empty)', path: filePath }),
              },
            ],
            isError: true,
          };
        }
      }

      const outlineOpts = {
        nested: nested === true,
        minLocForNesting: min_loc_for_nesting,
        projectRoot,
      };
      let result = await getFileOutline(store, filePath, outlineOpts);
      let autoIndexed = false;
      let existsOnDisk = false;
      if (result.isErr() && result.error.code === 'NOT_FOUND') {
        existsOnDisk = await autoIndexOnDemand(ctx, filePath);
        if (existsOnDisk) {
          result = await getFileOutline(store, filePath, outlineOpts);
          autoIndexed = result.isOk();
        }
      }
      if (result.isErr()) {
        const error =
          result.error.code === 'NOT_FOUND' && !result.error.reason
            ? notFound(
                result.error.id,
                result.error.candidates,
                existsOnDisk ? 'not_indexed' : 'not_found',
              )
            : result.error;
        return {
          content: [{ type: 'text', text: j(formatToolError(error)) }],
          isError: true,
        };
      }
      markExplored(filePath);
      // A suffix-resolved path was consulted under its canonical name too, so a
      // follow-up Read of either spelling counts as consulted.
      if (result.value.path !== filePath) markExplored(result.value.path);
      const fileRow = store.getFile(result.value.path);
      const freshness = fileRow ? computeFileFreshness(projectRoot, fileRow) : 'fresh';
      const summary = aggregateFreshness([freshness]);
      const confidence = computeRetrievalConfidence({
        scores: [1],
        freshnessSummary: summary,
      });
      const projectedSymbols = isMinimal(detail_level)
        ? compactOutlineSymbols(result.value.symbols)
        : result.value.symbols;
      const outlineWithFreshness = {
        path: result.value.path,
        language: result.value.language,
        symbols: projectedSymbols,
        ...(autoIndexed ? { _auto_indexed: true } : {}),
        ...(isMinimal(detail_level)
          ? { detail_level: 'minimal' as const }
          : {
              _freshness: freshness,
              _meta: {
                freshness: summary,
                ...(confidence
                  ? { confidence: confidence.confidence, confidence_signals: confidence.signals }
                  : {}),
              },
            }),
      };
      return { content: [{ type: 'text', text: encode(outlineWithFreshness) }] };
    },
  );

  server.tool(
    'get_change_impact',
    'Full change impact report: risk score + mitigations, breaking change detection, enriched dependents (complexity, coverage, exports), module groups, affected tests, co-change hidden couplings. Supports diff-aware mode via symbol_ids to scope analysis to only changed symbols. Use before modifying code to understand blast radius. For quick risk assessment without full report, use assess_change_risk instead. Read-only. Returns JSON: { risk, dependents, affectedTests, breakingChanges, totalAffected }.',
    {
      file_path: optionalNonEmptyString(512).describe('Relative file path to analyze'),
      symbol_id: optionalNonEmptyString(512).describe('Symbol ID to analyze'),
      fqn: z
        .string()
        .max(512)
        .optional()
        .describe('Fully qualified name to analyze (alternative to symbol_id)'),
      symbol_ids: z
        .array(z.string().max(512))
        .max(50)
        .optional()
        .describe(
          'Diff-aware: only analyze impact of these specific symbols (e.g. from get_changed_symbols)',
        ),
      decorator_filter: z
        .string()
        .max(256)
        .optional()
        .describe(
          'Filter dependents to only those with this decorator/annotation/attribute (e.g. "Route", "Transactional", "csrf_protect")',
        ),
      depth: z.number().int().min(1).max(20).optional().describe('Max traversal depth (default 3)'),
      max_dependents: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('Cap on returned dependents (default 200)'),
    },
    async ({ file_path, symbol_id, fqn, symbol_ids, decorator_filter, depth, max_dependents }) => {
      if (file_path) {
        const blocked = guardPath(file_path);
        if (blocked) return blocked;
      }
      const result = getChangeImpact(
        store,
        {
          filePath: file_path,
          symbolId: symbol_id,
          fqn,
          symbolIds: symbol_ids,
          decoratorFilter: decorator_filter,
        },
        depth ?? 3,
        max_dependents ?? 200,
        projectRoot,
      );
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      }
      const includeMethodology =
        result.value.totalAffected === 0 ||
        result.value.risk?.level === 'high' ||
        result.value.risk?.level === 'critical';
      const payload: Record<string, unknown> = includeMethodology
        ? { ...result.value, _methodology: CHANGE_IMPACT_METHODOLOGY }
        : { ...result.value };
      if (result.value.totalAffected === 0) {
        const note = buildEmptyResultNote(store, projectRoot, result.value.target.path);
        if (note) payload.empty_result_note = note;
      }
      // Enrich with linked decisions (code-aware memory)
      if (decisionStore) {
        const linkedDecisions = decisionsForImpact(
          decisionStore,
          projectRoot,
          { symbolId: symbol_id ?? fqn, filePath: file_path },
          result.value.dependents?.map((d) => d.path),
          undefined,
          undefined,
          store,
        );
        if (linkedDecisions.length > 0) {
          payload.linked_decisions = linkedDecisions;
        }
      }
      return { content: [{ type: 'text', text: jh('get_change_impact', payload) }] };
    },
  );

  server.tool(
    'get_related_symbols',
    'Find symbols related via co-location (same file), shared importers, and name similarity. Use when exploring a symbol to discover sibling code. For call-graph relationships use get_call_graph instead; for all usages use find_usages. Read-only. Returns JSON: { related: [{ symbol_id, name, kind, file, relation_type, score }] }.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to find related symbols for'),
      max_results: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    async ({ symbol_id, max_results }) => {
      const result = getRelatedSymbols(store, {
        symbolId: symbol_id,
        maxResults: max_results ?? 20,
      });
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: jh('get_related_symbols', result.value) }] };
    },
  );
}
