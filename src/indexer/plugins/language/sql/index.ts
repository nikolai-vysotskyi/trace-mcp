/**
 * SQL Language Plugin — tree-sitter-sql AST for CTEs (Phase 3) with regex fallback.
 */

import { ok } from 'neverthrow';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawSymbol,
} from '../../../../plugin-api/types.js';
import { annotateSymbolsWithFileMeta, buildCteSymbolsFromSpike } from './build-ast-symbols.js';
import { extractSqlDdlSymbolsRegex, extractSqlSymbolsRegex } from './sql-regex-config.js';
import { spikeParseSqlSource } from './spike-parse.js';

const manifest: PluginManifest = {
  name: 'sql-language',
  version: '2.0.0',
  priority: 6,
};

function parseFileStatus(spikeStatus: 'ok' | 'partial' | 'failed'): 'ok' | 'partial' | 'error' {
  if (spikeStatus === 'failed') return 'error';
  if (spikeStatus === 'partial') return 'partial';
  return 'ok';
}

export const SqlLanguagePlugin = class implements LanguagePlugin {
  manifest = manifest;
  supportedExtensions = ['.sql'];
  supportedVersions = undefined;

  async extractSymbols(filePath: string, content: Buffer) {
    const source = content.toString('utf-8');
    const useAst = process.env.TRACE_SQL_AST !== '0';

    if (!useAst) {
      return extractSqlSymbolsRegex(filePath, content);
    }

    const spike = await spikeParseSqlSource(source);

    if (spike.status === 'failed') {
      const fallback = extractSqlSymbolsRegex(filePath, content);
      if (fallback.isErr()) return fallback;
      const symbols = annotateSymbolsWithFileMeta(
        fallback.value.symbols ?? [],
        spike,
        'regex-fallback',
        spike.error ?? 'ast_parse_failed',
      );
      const body: FileParseResult = {
        ...fallback.value,
        status: 'partial',
        symbols,
        warnings: [...(fallback.value.warnings ?? []), 'sql: ast parse failed; regex fallback'],
      };
      return ok(body);
    }

    const merged: RawSymbol[] = [];
    const ddlResult = extractSqlDdlSymbolsRegex(filePath, content);
    if (ddlResult.isOk() && ddlResult.value.symbols?.length) {
      merged.push(
        ...annotateSymbolsWithFileMeta(ddlResult.value.symbols, spike, 'tree-sitter-sql'),
      );
    }
    merged.push(...buildCteSymbolsFromSpike(filePath, spike));

    const seen = new Set<string>();
    const symbols = merged.filter((s) => {
      const id = s.symbolId;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    return ok({
      language: 'sql',
      status: parseFileStatus(spike.status),
      symbols,
    });
  }
};
