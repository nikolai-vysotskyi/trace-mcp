/**
 * Optimization rule engine — detects wasteful tool call patterns
 * and recommends trace-mcp alternatives.
 */

import type { ToolCallRow } from './analytics-store.js';

interface OptimizationHit {
  rule: string;
  severity: 'high' | 'medium' | 'low';
  occurrences: number;
  details: string[];
  currentTokens: number;
  potentialTokens: number;
  recommendation: string;
}

export interface OptimizationReport {
  period: string;
  currentUsage: {
    totalTokens: number;
    estimatedCostUsd: number;
  };
  optimizations: OptimizationHit[];
  totalPotentialSavings: {
    tokens: number;
    costUsd: number;
    pct: number;
  };
}

interface Rule {
  id: string;
  detect(calls: ToolCallRow[]): OptimizationHit | null;
}

const BASH_GREP_RE = /\b(grep|rg|ack|ag)\b/;
const BASH_CAT_RE = /\b(cat|head|tail)\b/;
const COST_PER_MTOK = 5; // Opus default

function costUsd(tokens: number): number {
  return Math.round((tokens / 1_000_000) * COST_PER_MTOK * 10000) / 10000;
}

// 1. repeated-file-read — Read of the same file 3+ times in a session
const repeatedFileRead: Rule = {
  id: 'repeated-file-read',
  detect(calls) {
    const fileCounts = new Map<string, { count: number; tokens: number }>();
    for (const c of calls) {
      if (
        c.tool_name !== 'Read' &&
        c.tool_name !== 'mcp__phpstorm__read_file' &&
        c.tool_name !== 'mcp__phpstorm__get_file_text_by_path'
      )
        continue;
      if (!c.target_file) continue;
      const key = `${c.session_id}::${c.target_file}`;
      const rec = fileCounts.get(key) ?? { count: 0, tokens: 0 };
      rec.count++;
      rec.tokens += c.output_tokens_estimate;
      fileCounts.set(key, rec);
    }

    const repeated = [...fileCounts.entries()]
      .filter(([, v]) => v.count >= 3)
      .sort((a, b) => b[1].tokens - a[1].tokens);
    if (repeated.length === 0) return null;

    const currentTokens = repeated.reduce((s, [, v]) => s + v.tokens, 0);
    const potentialTokens = Math.round(currentTokens * 0.2);
    return {
      rule: 'repeated-file-read',
      severity: 'high',
      occurrences: repeated.reduce((s, [, v]) => s + v.count, 0),
      details: repeated
        .slice(0, 5)
        .map(([k, v]) => `${k.split('::')[1]} (${v.count}x, ~${v.tokens} tokens)`),
      currentTokens,
      potentialTokens,
      recommendation:
        'Use get_outline to understand file structure, then get_symbol for specific symbols instead of reading the full file repeatedly.',
    };
  },
};

// 2. bash-grep — Bash with grep/rg/ack in command
const bashGrep: Rule = {
  id: 'bash-grep',
  detect(calls) {
    const hits: string[] = [];
    let currentTokens = 0;

    for (const c of calls) {
      if (c.tool_short_name !== 'Bash' && c.tool_short_name !== 'bash') continue;
      if (!c.input_snippet || !BASH_GREP_RE.test(c.input_snippet)) continue;
      hits.push(c.input_snippet.slice(0, 120));
      currentTokens += c.output_tokens_estimate;
    }

    if (hits.length === 0) return null;

    return {
      rule: 'bash-grep',
      severity: 'high',
      occurrences: hits.length,
      details: hits.slice(0, 5),
      currentTokens,
      potentialTokens: Math.round(currentTokens * 0.2),
      recommendation:
        'Use trace-mcp `search` tool instead of Bash grep/rg. It returns structured, token-efficient results with symbol context.',
    };
  },
};

// 3. bash-cat — Bash with cat/head/tail in command
const bashCat: Rule = {
  id: 'bash-cat',
  detect(calls) {
    const hits: string[] = [];
    let currentTokens = 0;

    for (const c of calls) {
      if (c.tool_short_name !== 'Bash' && c.tool_short_name !== 'bash') continue;
      if (!c.input_snippet || !BASH_CAT_RE.test(c.input_snippet)) continue;
      hits.push(c.input_snippet.slice(0, 120));
      currentTokens += c.output_tokens_estimate;
    }

    if (hits.length === 0) return null;

    return {
      rule: 'bash-cat',
      severity: 'medium',
      occurrences: hits.length,
      details: hits.slice(0, 5),
      currentTokens,
      potentialTokens: Math.round(currentTokens * 0.4),
      recommendation:
        'Use get_symbol or Read tool instead of Bash cat/head/tail. These provide structured output and better token efficiency.',
    };
  },
};

// 4. large-file-read — Read with output > 5000 chars
const largeFileRead: Rule = {
  id: 'large-file-read',
  detect(calls) {
    const large = calls.filter(
      (c) =>
        (c.tool_name === 'Read' ||
          c.tool_name === 'mcp__phpstorm__read_file' ||
          c.tool_name === 'mcp__phpstorm__get_file_text_by_path') &&
        c.output_size_chars > 5000 &&
        c.target_file,
    );
    if (large.length === 0) return null;

    const currentTokens = large.reduce((s, c) => s + c.output_tokens_estimate, 0);
    const potentialTokens = Math.round(currentTokens * 0.15);
    return {
      rule: 'large-file-read',
      severity: 'medium',
      occurrences: large.length,
      details: large.slice(0, 5).map((c) => `${c.target_file} (${c.output_size_chars} chars)`),
      currentTokens,
      potentialTokens,
      recommendation:
        'Use get_outline for file overview (signatures only), then get_symbol to read specific functions/classes.',
    };
  },
};

// 5. phpstorm-read-indexed — PhpStorm get_file_text_by_path or read_file
const phpstormReadIndexed: Rule = {
  id: 'phpstorm-read-indexed',
  detect(calls) {
    const phpstormReads = calls.filter(
      (c) =>
        (c.tool_name === 'mcp__phpstorm__read_file' ||
          c.tool_name === 'mcp__phpstorm__get_file_text_by_path') &&
        c.target_file,
    );
    if (phpstormReads.length === 0) return null;

    const currentTokens = phpstormReads.reduce((s, c) => s + c.output_tokens_estimate, 0);
    const potentialTokens = Math.round(currentTokens * 0.3);
    return {
      rule: 'phpstorm-read-indexed',
      severity: 'medium',
      occurrences: phpstormReads.length,
      details: phpstormReads.slice(0, 5).map((c) => `${c.tool_name} → ${c.target_file}`),
      currentTokens,
      potentialTokens,
      recommendation:
        'Use trace-mcp get_symbol instead of PhpStorm file reading. It returns only the relevant symbol, saving tokens.',
    };
  },
};

// 6. phpstorm-search-indexed — PhpStorm search_in_files_by_text or similar
const phpstormSearchIndexed: Rule = {
  id: 'phpstorm-search-indexed',
  detect(calls) {
    const searchTools = new Set([
      'mcp__phpstorm__search_in_files_by_text',
      'mcp__phpstorm__search_in_files_by_regex',
      'mcp__phpstorm__search_text',
      'mcp__phpstorm__search_file',
    ]);
    const searches = calls.filter((c) => searchTools.has(c.tool_name));
    if (searches.length === 0) return null;

    const currentTokens = searches.reduce((s, c) => s + c.output_tokens_estimate, 0);
    const potentialTokens = Math.round(currentTokens * 0.25);
    return {
      rule: 'phpstorm-search-indexed',
      severity: 'medium',
      occurrences: searches.length,
      details: [`${searches.length} PhpStorm search calls`],
      currentTokens,
      potentialTokens,
      recommendation:
        'Use trace-mcp `search` instead of PhpStorm text search. It understands symbols, FQNs, and language filters.',
    };
  },
};

// 7. unused-trace-tools — trace-mcp tools available but never called in session
const unusedTraceTools: Rule = {
  id: 'unused-trace-tools',
  detect(calls) {
    if (calls.length < 3) return null;

    const sessions = new Map<string, { hasTrace: boolean; navTokens: number; hasNav: boolean }>();
    for (const c of calls) {
      let entry = sessions.get(c.session_id);
      if (!entry) {
        entry = { hasTrace: false, navTokens: 0, hasNav: false };
        sessions.set(c.session_id, entry);
      }
      if (c.tool_server === 'trace-mcp' || c.tool_server === 'trace_mcp') {
        entry.hasTrace = true;
      }
      const sn = c.tool_short_name;
      if (
        sn === 'Read' ||
        sn === 'Grep' ||
        sn === 'Glob' ||
        ((sn === 'Bash' || sn === 'bash') && c.input_snippet && BASH_GREP_RE.test(c.input_snippet))
      ) {
        entry.hasNav = true;
        entry.navTokens += c.output_tokens_estimate;
      }
    }

    const flagged = [...sessions.entries()].filter(([, v]) => !v.hasTrace && v.hasNav);
    if (flagged.length === 0) return null;

    let currentTokens = 0;
    const details: string[] = [];
    for (const [sid, v] of flagged) {
      currentTokens += v.navTokens;
      details.push(`Session ${sid.slice(0, 8)}...`);
    }

    return {
      rule: 'unused-trace-tools',
      severity: 'low',
      occurrences: flagged.length,
      details: details.slice(0, 10),
      currentTokens,
      potentialTokens: Math.round(currentTokens * 0.35),
      recommendation:
        'Enable trace-mcp tools for code navigation. Useful: search, get_outline, get_symbol, get_feature_context, find_usages.',
    };
  },
};

// 8. agent-for-indexed — Agent subagent calls
const agentForIndexed: Rule = {
  id: 'agent-for-indexed',
  detect(calls) {
    const agentCalls = calls.filter(
      (c) =>
        c.tool_short_name === 'Agent' ||
        c.tool_short_name === 'agent' ||
        c.tool_short_name === 'dispatch_agent',
    );
    if (agentCalls.length === 0) return null;

    // Agents consume ~50K tokens internally per call (not visible in output)
    const estimatedInternalTokens = agentCalls.length * 50000;
    const potentialTokens = Math.round(estimatedInternalTokens * 0.15);

    return {
      rule: 'agent-for-indexed',
      severity: 'medium',
      occurrences: agentCalls.length,
      details: [`${agentCalls.length} Agent subagent calls (~50K internal tokens each)`],
      currentTokens: estimatedInternalTokens,
      potentialTokens,
      recommendation:
        'Use get_feature_context or get_task_context instead of Agent subagents for code exploration. They return focused context within a token budget.',
    };
  },
};

const ALL_RULES: Rule[] = [
  repeatedFileRead,
  bashGrep,
  bashCat,
  largeFileRead,
  phpstormReadIndexed,
  phpstormSearchIndexed,
  unusedTraceTools,
  agentForIndexed,
];

export function analyzeOptimizations(toolCalls: ToolCallRow[], period: string): OptimizationReport {
  const totalTokens = toolCalls.reduce((sum, tc) => sum + tc.output_tokens_estimate, 0);

  const optimizations: OptimizationHit[] = [];
  for (const rule of ALL_RULES) {
    const hit = rule.detect(toolCalls);
    if (hit) optimizations.push(hit);
  }

  optimizations.sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    const diff = severityOrder[a.severity] - severityOrder[b.severity];
    if (diff !== 0) return diff;
    return b.currentTokens - b.potentialTokens - (a.currentTokens - a.potentialTokens);
  });

  const savingsTokens = optimizations.reduce(
    (sum, o) => sum + (o.currentTokens - o.potentialTokens),
    0,
  );

  return {
    period,
    currentUsage: {
      totalTokens,
      estimatedCostUsd: costUsd(totalTokens),
    },
    optimizations,
    totalPotentialSavings: {
      tokens: savingsTokens,
      costUsd: costUsd(savingsTokens),
      pct: totalTokens > 0 ? Math.round((savingsTokens / totalTokens) * 100) : 0,
    },
  };
}
