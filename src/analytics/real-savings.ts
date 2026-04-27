/**
 * Real Savings Analysis — analyzes actual session logs to compute
 * how much could be saved by using trace-mcp instead of raw file reads.
 */

import type { Store } from '../db/store.js';
import type { ToolCallRow } from './analytics-store.js';

interface FileAlternative {
  file: string;
  reads: number;
  totalReadTokens: number;
  bestAlternative: string;
  alternativeTokens: number;
  savingsPct: number;
}

interface ToolReplacement {
  originalTool: string;
  calls: number;
  tokens: number;
  replaceableCalls: number;
  replaceableTokens: number;
  savingsTokens: number;
}

interface RealSavingsReport {
  period: string;
  sessionsAnalyzed: number;
  fileReadsAnalyzed: number;
  filesInIndex: number;
  filesNotIndexed: number;

  summary: {
    totalReadTokens: number;
    achievableWithTraceMcp: number;
    potentialSavingsTokens: number;
    potentialSavingsPct: number;
    potentialCostSavings: Record<string, string>;
  };

  byFile: FileAlternative[];
  byToolReplaced: Record<string, ToolReplacement>;

  abComparison?: {
    sessionsWithTraceMcp: { count: number; avgTokensPerSession: number; avgToolCalls: number };
    sessionsWithoutTraceMcp: { count: number; avgTokensPerSession: number; avgToolCalls: number };
    difference: { tokensSavedPct: number; fewerToolCallsPct: number };
  };
}

const MODEL_PRICING: Record<string, number> = {
  'claude-opus-4-6': 5.0 / 1_000_000,
  'claude-sonnet-4-6': 3.0 / 1_000_000,
  'claude-haiku-4-5': 1.0 / 1_000_000,
};

const READ_TOOLS = new Set([
  'Read',
  'mcp__phpstorm__read_file',
  'mcp__phpstorm__get_file_text_by_path',
]);

/** Compute alternative token cost for a file using trace-mcp */
function computeAlternativeTokens(
  store: Store,
  filePath: string,
): { tokens: number; tool: string } | null {
  // Normalize path — strip absolute prefix to match index
  const normalized = filePath.replace(/^\/[^/]+\/[^/]+\/[^/]+\/[^/]+\//, '');
  const file = store.getFile(normalized) ?? store.getFile(filePath);
  if (!file) return null;

  const fileBytes = file.byte_length ?? 0;
  if (fileBytes === 0) return null;

  // Get outline size (signatures) — typically 5-15% of file
  const symbols = store.getSymbolsByFile(file.id);
  const signatureBytes = symbols.reduce((s, sym) => s + (sym.signature?.length ?? 0), 0);

  if (symbols.length === 0) {
    // No symbols — outline would still be cheaper than full file
    return { tokens: Math.ceil((fileBytes * 0.15) / 3.5), tool: 'get_outline' };
  }

  // Average symbol size
  const avgSymbolBytes =
    symbols.reduce((s, sym) => s + (sym.byte_end - sym.byte_start), 0) / symbols.length;

  // Best strategy: outline first (~signatures), then get_symbol for 1-2 needed symbols
  const outlineTokens = Math.ceil(signatureBytes / 3.5) || Math.ceil((fileBytes * 0.1) / 3.5);
  const oneSymbolTokens = Math.ceil(avgSymbolBytes / 3.5);
  const alternativeTokens = outlineTokens + oneSymbolTokens;

  return { tokens: alternativeTokens, tool: 'get_outline + get_symbol' };
}

export function analyzeRealSavings(
  store: Store,
  toolCalls: ToolCallRow[],
  period: string,
): RealSavingsReport {
  // Collect file read calls
  const fileReads = toolCalls.filter((tc) => READ_TOOLS.has(tc.tool_name) && tc.target_file);
  const bashCats = toolCalls.filter(
    (tc) =>
      tc.tool_short_name === 'Bash' &&
      tc.input_snippet &&
      /\b(cat|head|tail)\b/.test(tc.input_snippet) &&
      tc.target_file,
  );
  const allReads = [...fileReads, ...bashCats];

  // Group by file
  const fileGroups = new Map<string, { reads: number; tokens: number; tool: string }>();
  for (const tc of allReads) {
    const f = tc.target_file!;
    const rec = fileGroups.get(f) ?? { reads: 0, tokens: 0, tool: tc.tool_name };
    rec.reads++;
    rec.tokens += tc.output_tokens_estimate;
    fileGroups.set(f, rec);
  }

  // Compute alternatives — only count savings from indexed files
  let filesInIndex = 0;
  let filesNotIndexed = 0;
  let totalReadTokens = 0;
  let replaceableTokens = 0;
  let achievableTokens = 0;
  const byFile: FileAlternative[] = [];
  const toolReplacements = new Map<string, ToolReplacement>();

  for (const [file, group] of fileGroups) {
    totalReadTokens += group.tokens;
    const alt = computeAlternativeTokens(store, file);

    const toolKey = READ_TOOLS.has(group.tool) ? group.tool : 'Bash (cat/head/tail)';
    const tr = toolReplacements.get(toolKey) ?? {
      originalTool: toolKey,
      calls: 0,
      tokens: 0,
      replaceableCalls: 0,
      replaceableTokens: 0,
      savingsTokens: 0,
    };
    tr.calls += group.reads;
    tr.tokens += group.tokens;

    if (alt) {
      filesInIndex++;
      const altTotal = Math.min(alt.tokens * group.reads, group.tokens); // cap at original
      replaceableTokens += group.tokens;
      achievableTokens += altTotal;
      byFile.push({
        file,
        reads: group.reads,
        totalReadTokens: group.tokens,
        bestAlternative: alt.tool,
        alternativeTokens: altTotal,
        savingsPct: group.tokens > 0 ? Math.round((1 - altTotal / group.tokens) * 100) : 0,
      });
      tr.replaceableCalls += group.reads;
      tr.replaceableTokens += group.tokens;
      tr.savingsTokens += group.tokens - altTotal;
    } else {
      filesNotIndexed++;
    }
    toolReplacements.set(toolKey, tr);
  }

  byFile.sort(
    (a, b) => b.totalReadTokens - b.alternativeTokens - (a.totalReadTokens - a.alternativeTokens),
  );

  const savingsTokens = replaceableTokens - achievableTokens;
  const costSavings: Record<string, string> = {};
  for (const [model, price] of Object.entries(MODEL_PRICING)) {
    costSavings[model] = `$${(savingsTokens * price).toFixed(2)}`;
  }

  // A/B comparison: sessions with vs without trace-mcp
  const sessionMap = new Map<string, { hasTrace: boolean; tokens: number; toolCalls: number }>();
  for (const tc of toolCalls) {
    const s = sessionMap.get(tc.session_id) ?? { hasTrace: false, tokens: 0, toolCalls: 0 };
    s.tokens += tc.output_tokens_estimate;
    s.toolCalls++;
    if (tc.tool_server === 'trace-mcp' || tc.tool_server === 'trace_mcp') {
      s.hasTrace = true;
    }
    sessionMap.set(tc.session_id, s);
  }

  const withTrace = [...sessionMap.values()].filter((s) => s.hasTrace);
  const withoutTrace = [...sessionMap.values()].filter((s) => !s.hasTrace);

  let abComparison: RealSavingsReport['abComparison'];
  if (withTrace.length >= 2 && withoutTrace.length >= 2) {
    const avgWith = {
      count: withTrace.length,
      avgTokensPerSession: Math.round(
        withTrace.reduce((s, v) => s + v.tokens, 0) / withTrace.length,
      ),
      avgToolCalls: Math.round(withTrace.reduce((s, v) => s + v.toolCalls, 0) / withTrace.length),
    };
    const avgWithout = {
      count: withoutTrace.length,
      avgTokensPerSession: Math.round(
        withoutTrace.reduce((s, v) => s + v.tokens, 0) / withoutTrace.length,
      ),
      avgToolCalls: Math.round(
        withoutTrace.reduce((s, v) => s + v.toolCalls, 0) / withoutTrace.length,
      ),
    };
    abComparison = {
      sessionsWithTraceMcp: avgWith,
      sessionsWithoutTraceMcp: avgWithout,
      difference: {
        tokensSavedPct:
          avgWithout.avgTokensPerSession > 0
            ? Math.round((1 - avgWith.avgTokensPerSession / avgWithout.avgTokensPerSession) * 100)
            : 0,
        fewerToolCallsPct:
          avgWithout.avgToolCalls > 0
            ? Math.round((1 - avgWith.avgToolCalls / avgWithout.avgToolCalls) * 100)
            : 0,
      },
    };
  }

  // Count unique sessions
  const sessionIds = new Set(allReads.map((tc) => tc.session_id));

  return {
    period,
    sessionsAnalyzed: sessionIds.size,
    fileReadsAnalyzed: allReads.length,
    filesInIndex,
    filesNotIndexed,
    summary: {
      totalReadTokens: replaceableTokens,
      achievableWithTraceMcp: achievableTokens,
      potentialSavingsTokens: savingsTokens,
      potentialSavingsPct:
        replaceableTokens > 0 ? Math.round((savingsTokens / replaceableTokens) * 100) : 0,
      potentialCostSavings: costSavings,
    },
    byFile: byFile.slice(0, 20),
    byToolReplaced: Object.fromEntries(toolReplacements),
    abComparison,
  };
}
