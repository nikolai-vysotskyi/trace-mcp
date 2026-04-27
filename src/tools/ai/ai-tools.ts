/**
 * AI-powered MCP tools — require AI to be enabled.
 * Each tool gracefully returns an error message when AI is disabled.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Store, SymbolRow, FileRow } from '../../db/store.js';
import { resolveSymbolInput } from '../shared/resolve.js';
import type {
  InferenceService,
  EmbeddingService,
  VectorStore,
  RerankerService,
} from '../../ai/interfaces.js';
import { PROMPTS } from '../../ai/prompts.js';
import { readByteRange } from '../../utils/source-reader.js';
import {
  assembleStructuredContext,
  renderStructuredContext,
} from '../../scoring/structured-assembly.js';
import type { ContextItem } from '../../scoring/assembly.js';
import { getChangeImpact } from '../analysis/impact.js';
import path from 'node:path';

interface AIToolsContext {
  store: Store;
  smartInference: InferenceService;
  fastInference: InferenceService;
  embeddingService: EmbeddingService | null;
  vectorStore: VectorStore | null;
  reranker: RerankerService | null;
  projectRoot: string;
}

function j(value: unknown): string {
  return JSON.stringify(value);
}

function symbolToContextItem(
  sym: SymbolRow,
  file: FileRow,
  projectRoot: string,
  score = 1,
): ContextItem {
  const source = readSourceSafe(
    file.path,
    sym.byte_start,
    sym.byte_end,
    projectRoot,
    !!file.gitignored,
  );
  return {
    id: sym.symbol_id,
    score,
    source: source ?? undefined,
    signature: sym.signature ?? undefined,
    metadata: `${sym.kind} ${sym.fqn ?? sym.name} — ${file.path}`,
  };
}

function readSourceSafe(
  filePath: string,
  byteStart: number,
  byteEnd: number,
  projectRoot: string,
  gitignored?: boolean,
): string | null {
  try {
    const absPath = path.resolve(projectRoot, filePath);
    return readByteRange(absPath, byteStart, byteEnd, gitignored);
  } catch {
    return null;
  }
}

function resolveSymbol(
  store: Store,
  opts: { symbolId?: string; fqn?: string },
): { sym: SymbolRow; file: FileRow } | null {
  const resolved = resolveSymbolInput(store, opts);
  if (!resolved) return null;
  return { sym: resolved.symbol, file: resolved.file };
}

function gatherRelatedSymbols(
  store: Store,
  sym: SymbolRow,
  projectRoot: string,
): { dependencies: ContextItem[]; callers: ContextItem[]; typeContext: ContextItem[] } {
  const dependencies: ContextItem[] = [];
  const callers: ContextItem[] = [];
  const typeContext: ContextItem[] = [];

  const symNodeId = store.getNodeId('symbol', sym.id);
  if (!symNodeId) return { dependencies, callers, typeContext };

  // Outgoing edges = dependencies
  const outEdges = store.getOutgoingEdges(symNodeId);
  for (const edge of outEdges.slice(0, 10)) {
    const ref = store.getNodeRef(edge.target_node_id);
    if (!ref || ref.nodeType !== 'symbol') continue;
    const depSym = store.getSymbolById(ref.refId);
    if (!depSym) continue;
    const depFile = store.getFileById(depSym.file_id);
    if (!depFile) continue;
    dependencies.push(symbolToContextItem(depSym, depFile, projectRoot, 0.5));
  }

  // Incoming edges = callers
  const inEdges = store.getIncomingEdges(symNodeId);
  for (const edge of inEdges.slice(0, 10)) {
    const ref = store.getNodeRef(edge.source_node_id);
    if (!ref || ref.nodeType !== 'symbol') continue;
    const callerSym = store.getSymbolById(ref.refId);
    if (!callerSym) continue;
    const callerFile = store.getFileById(callerSym.file_id);
    if (!callerFile) continue;
    callers.push(symbolToContextItem(callerSym, callerFile, projectRoot, 0.3));
  }

  // Type hierarchy
  if (sym.metadata) {
    try {
      const meta = JSON.parse(sym.metadata);
      const parents = [...(meta.extends ? [meta.extends].flat() : []), ...(meta.implements ?? [])];
      for (const parentName of parents.slice(0, 5)) {
        const parentSym = store.getSymbolByName(parentName);
        if (!parentSym) continue;
        const parentFile = store.getFileById(parentSym.file_id);
        if (!parentFile) continue;
        typeContext.push(symbolToContextItem(parentSym, parentFile, projectRoot, 0.4));
      }
    } catch {
      /* ignore parse errors */
    }
  }

  return { dependencies, callers, typeContext };
}

export function registerAITools(server: McpServer, ctx: AIToolsContext): void {
  const { store, smartInference, embeddingService, vectorStore, reranker, projectRoot } = ctx;

  // ─── explain_symbol ──────────────────────────────────────
  server.tool(
    'explain_symbol',
    'Explain a symbol in detail using AI — purpose, behavior, relationships, usage patterns',
    {
      symbol_id: z.string().optional().describe('Symbol ID (e.g. src/auth.ts::AuthService#class)'),
      fqn: z.string().optional().describe('Fully qualified name'),
    },
    async ({ symbol_id, fqn }) => {
      const resolved = resolveSymbol(store, { symbolId: symbol_id, fqn });
      if (!resolved) {
        return {
          content: [{ type: 'text', text: j({ error: 'Symbol not found' }) }],
          isError: true,
        };
      }
      const { sym, file } = resolved;
      const primary = [symbolToContextItem(sym, file, projectRoot)];
      const related = gatherRelatedSymbols(store, sym, projectRoot);

      const structured = assembleStructuredContext({
        primary,
        dependencies: related.dependencies,
        callers: related.callers,
        typeContext: related.typeContext,
        totalBudget: 4000,
      });

      const contextStr = renderStructuredContext(structured);
      const prompt = PROMPTS.explain_symbol.build({
        kind: sym.kind,
        name: sym.name,
        fqn: sym.fqn ?? '',
        signature: sym.signature ?? '',
        source: primary[0].source ?? '',
        context: contextStr,
      });

      const explanation = await smartInference.generate(prompt, {
        maxTokens: PROMPTS.explain_symbol.maxTokens,
        temperature: PROMPTS.explain_symbol.temperature,
      });

      return {
        content: [
          {
            type: 'text',
            text: j({
              symbol_id: sym.symbol_id,
              name: sym.name,
              kind: sym.kind,
              file: file.path,
              explanation,
              related_symbols: [
                ...related.dependencies.map((d) => d.id),
                ...related.callers.map((c) => c.id),
                ...related.typeContext.map((t) => t.id),
              ],
            }),
          },
        ],
      };
    },
  );

  // ─── suggest_tests ───────────────────────────────────────
  server.tool(
    'suggest_tests',
    'Suggest test cases for a symbol using AI',
    {
      symbol_id: z.string().optional().describe('Symbol ID'),
      fqn: z.string().optional().describe('Fully qualified name'),
    },
    async ({ symbol_id, fqn }) => {
      const resolved = resolveSymbol(store, { symbolId: symbol_id, fqn });
      if (!resolved) {
        return {
          content: [{ type: 'text', text: j({ error: 'Symbol not found' }) }],
          isError: true,
        };
      }
      const { sym, file } = resolved;
      const source = readSourceSafe(file.path, sym.byte_start, sym.byte_end, projectRoot);
      const related = gatherRelatedSymbols(store, sym, projectRoot);

      const depsStr = related.dependencies.map((d) => d.metadata).join('\n');

      const prompt = PROMPTS.suggest_tests.build({
        kind: sym.kind,
        name: sym.name,
        signature: sym.signature ?? '',
        source: source ?? '',
        dependencies: depsStr,
      });

      const response = await smartInference.generate(prompt, {
        maxTokens: PROMPTS.suggest_tests.maxTokens,
        temperature: PROMPTS.suggest_tests.temperature,
      });

      let suggestions: unknown;
      try {
        suggestions = JSON.parse(response);
      } catch {
        suggestions = [{ description: response, verifies: 'See description' }];
      }

      return {
        content: [
          {
            type: 'text',
            text: j({
              symbol_id: sym.symbol_id,
              name: sym.name,
              suggestions,
            }),
          },
        ],
      };
    },
  );

  // ─── review_change ───────────────────────────────────────
  server.tool(
    'review_change',
    'AI-powered review of a file change — identify issues, risks, and suggestions',
    {
      file_path: z.string().describe('File path relative to project root'),
      diff: z.string().optional().describe('Git diff content (if not provided, reviews full file)'),
    },
    async ({ file_path, diff }) => {
      const impactResult = getChangeImpact(store, { filePath: file_path });
      const blastRadius = impactResult.isOk()
        ? impactResult.value.dependents
            .map((d) => `${d.edgeTypes.join(', ')}: ${d.path}`)
            .join('\n')
        : '';

      const prompt = PROMPTS.review_change.build({
        filePath: file_path,
        diff: diff ?? '',
        blastRadius,
      });

      const response = await smartInference.generate(prompt, {
        maxTokens: PROMPTS.review_change.maxTokens,
        temperature: PROMPTS.review_change.temperature,
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(response);
      } catch {
        parsed = { issues: [], summary: response };
      }

      return { content: [{ type: 'text', text: j(parsed) }] };
    },
  );

  // ─── find_similar ────────────────────────────────────────
  server.tool(
    'find_similar',
    'Find semantically similar symbols using vector search + optional AI reranking',
    {
      symbol_id: z.string().optional().describe('Symbol ID to find similar code to'),
      query: z.string().optional().describe('Free-text query (used if no symbol_id)'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
    },
    async ({ symbol_id, query, limit: maxResults }) => {
      const resultLimit = maxResults ?? 10;

      if (!embeddingService || !vectorStore) {
        return {
          content: [
            {
              type: 'text',
              text: j({ error: 'Vector search requires AI embeddings to be enabled' }),
            },
          ],
          isError: true,
        };
      }

      let queryText: string;
      if (symbol_id) {
        const sym = store.getSymbolBySymbolId(symbol_id);
        if (!sym) {
          return {
            content: [{ type: 'text', text: j({ error: 'Symbol not found' }) }],
            isError: true,
          };
        }
        queryText = [sym.kind, sym.fqn ?? sym.name, sym.signature ?? '', sym.summary ?? ''].join(
          ' ',
        );
      } else if (query) {
        queryText = query;
      } else {
        return {
          content: [{ type: 'text', text: j({ error: 'Provide symbol_id or query' }) }],
          isError: true,
        };
      }

      const embedding = await embeddingService.embed(queryText, 'query');
      if (embedding.length === 0) {
        return { content: [{ type: 'text', text: j({ results: [] }) }] };
      }

      let vectorResults = vectorStore.search(embedding, resultLimit * 3);

      // Exclude the source symbol from results
      if (symbol_id) {
        const srcSym = store.getSymbolBySymbolId(symbol_id);
        if (srcSym) {
          vectorResults = vectorResults.filter((r) => r.id !== srcSym.id);
        }
      }

      // Optional reranking
      if (reranker && vectorResults.length > 1) {
        const docs = vectorResults.map((r) => {
          const sym = store.getSymbolById(r.id);
          return {
            id: r.id,
            text: sym ? `${sym.kind} ${sym.fqn ?? sym.name} ${sym.signature ?? ''}` : '',
          };
        });
        try {
          const reranked = await reranker.rerank(queryText, docs, resultLimit);
          vectorResults = reranked.map((r) => ({ id: r.id, score: r.score }));
        } catch {
          /* keep original order */
        }
      }

      const results = vectorResults
        .slice(0, resultLimit)
        .map((r) => {
          const sym = store.getSymbolById(r.id);
          const file = sym ? store.getFileById(sym.file_id) : undefined;
          return {
            symbol_id: sym?.symbol_id,
            name: sym?.name,
            kind: sym?.kind,
            fqn: sym?.fqn,
            file: file?.path,
            similarity: Math.round(r.score * 1000) / 1000,
            summary: sym?.summary ?? null,
          };
        })
        .filter((r) => r.symbol_id);

      return { content: [{ type: 'text', text: j({ results }) }] };
    },
  );

  // ─── explain_architecture ────────────────────────────────
  server.tool(
    'explain_architecture',
    'AI-powered architecture analysis — layers, patterns, and data flow',
    {
      scope: z
        .string()
        .optional()
        .describe(
          'Scope to analyze (e.g. "authentication", "data layer", or empty for full project)',
        ),
      token_budget: z
        .number()
        .int()
        .min(500)
        .max(16000)
        .optional()
        .describe('Token budget for context (default 6000)'),
    },
    async ({ scope, token_budget }) => {
      const budget = token_budget ?? 6000;

      // Gather key symbols via FTS if scope provided, otherwise top symbols by kind
      const symbols: ContextItem[] = [];

      if (scope) {
        // Use FTS to find relevant symbols
        const ftsQuery = scope
          .split(/\s+/)
          .map((t) => `"${t}"`)
          .join(' OR ');
        const ftsResults = store.db
          .prepare(`
          SELECT s.*, f.path as file_path
          FROM symbols_fts fts
          JOIN symbols s ON s.id = fts.rowid
          JOIN files f ON f.id = s.file_id
          WHERE symbols_fts MATCH ?
          ORDER BY rank
          LIMIT 30
        `)
          .all(ftsQuery) as (SymbolRow & { file_path: string })[];

        for (const row of ftsResults) {
          const file = store.getFileById(row.file_id);
          if (!file) continue;
          symbols.push(symbolToContextItem(row, file, projectRoot, 0.5));
        }
      } else {
        // Get top classes/interfaces as architectural anchors
        const topSymbols = store.db
          .prepare(`
          SELECT s.*, f.path as file_path
          FROM symbols s
          JOIN files f ON f.id = s.file_id
          WHERE s.kind IN ('class', 'interface', 'trait')
          LIMIT 30
        `)
          .all() as (SymbolRow & { file_path: string })[];

        for (const row of topSymbols) {
          const file = store.getFileById(row.file_id);
          if (!file) continue;
          symbols.push(symbolToContextItem(row, file, projectRoot, 0.5));
        }
      }

      const assembled = assembleStructuredContext({
        primary: symbols,
        dependencies: [],
        callers: [],
        typeContext: [],
        totalBudget: budget,
        budgetWeights: { primary: 1.0, dependencies: 0, callers: 0, typeContext: 0 },
      });

      const contextStr = renderStructuredContext(assembled);
      const prompt = PROMPTS.explain_architecture.build({
        scope: scope ?? 'full project',
        context: contextStr,
      });

      const response = await smartInference.generate(prompt, {
        maxTokens: PROMPTS.explain_architecture.maxTokens,
        temperature: PROMPTS.explain_architecture.temperature,
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(response);
      } catch {
        parsed = { overview: response, layers: [], key_patterns: [], data_flow: [] };
      }

      return { content: [{ type: 'text', text: j(parsed) }] };
    },
  );
}
