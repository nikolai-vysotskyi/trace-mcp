import type { Tree } from 'web-tree-sitter';
import {
  extractCtesFromTree,
  extractRelationRefsFromTree,
  type ExtractedCte,
  type ExtractedRelationRef,
} from './ast-extract.js';
import { preprocessSqlForParse, type SqlPreprocessResult } from './preprocess.js';
import { parseSqlSource } from './sql-parser.js';

export type SqlParseStatus = 'ok' | 'partial' | 'failed';

export interface SqlSpikeParseResult {
  status: SqlParseStatus;
  hasError: boolean;
  preprocess: SqlPreprocessResult;
  ctes: ExtractedCte[];
  relationRefs: ExtractedRelationRef[];
  error?: string;
}

export async function spikeParseSqlSource(original: string): Promise<SqlSpikeParseResult> {
  const preprocess = preprocessSqlForParse(original);
  let tree: Tree;
  try {
    tree = await parseSqlSource(preprocess.source);
  } catch (e) {
    return {
      status: 'failed',
      hasError: true,
      preprocess,
      ctes: [],
      relationRefs: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    const root = tree.rootNode;
    const ctes = extractCtesFromTree(root);
    const relationRefs = extractRelationRefsFromTree(root);
    const hasError = root.hasError || root.type === 'ERROR';
    const rootOk = root.type === 'program' || root.type === 'statement';

    if (!rootOk && ctes.length === 0) {
      return {
        status: 'failed',
        hasError: true,
        preprocess,
        ctes: [],
        relationRefs: [],
        error: `unexpected root node type: ${root.type}`,
      };
    }

    const status: SqlParseStatus = !rootOk || hasError ? 'partial' : 'ok';
    return { status, hasError, preprocess, ctes, relationRefs };
  } finally {
    tree.delete();
  }
}
