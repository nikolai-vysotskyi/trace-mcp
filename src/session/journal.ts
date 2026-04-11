/**
 * Session journal — tracks tool calls, deduplicates queries, and flags zero-result repeats.
 *
 * Two-phase API:
 *  1. checkDuplicate(tool, params) — before executing, returns warning if duplicate
 *  2. record(tool, params, resultCount) — after executing, logs the result
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface JournalEntry {
  tool: string;
  params_hash: string;
  params_summary: string;
  result_count: number;
  timestamp: number;
  /** Compact snapshot of the result (no source bodies) for dedup responses */
  compact_result?: Record<string, unknown>;
  /** Estimated token size of the full response */
  result_tokens?: number;
}

/**
 * Returned by checkDuplicate when a previous result exists.
 * `action` tells the caller what to do:
 *  - 'warn'  → still execute, but prepend warning (search tools — results may differ)
 *  - 'dedup' → skip execution, return compact_result instead (content-heavy tools)
 */
interface DuplicateInfo {
  action: 'warn' | 'dedup';
  message: string;
  compact_result: Record<string, unknown> | null;
  saved_tokens: number;
}

interface JournalSummary {
  total_entries: number;
  files_read: string[];
  searches_with_zero_results: string[];
  duplicate_queries: string[];
}

interface PrefetchBoost {
  /** File path that was frequently accessed after get_task_context */
  file: string;
  /** Number of times this follow-up pattern was observed */
  frequency: number;
}

/** Structural landmark — a central symbol that should survive context compaction */
export interface StructuralLandmark {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  /** Why this symbol is a landmark */
  reason: 'pagerank' | 'recently_edited';
  /** PageRank score (only for pagerank landmarks) */
  score?: number;
}

/** Provider callback that returns landmarks from the index */
export type LandmarkProvider = () => StructuralLandmark[];

/** Structured snapshot for programmatic consumption */
interface SessionSnapshotStructured {
  duration_seconds: number;
  total_calls: number;
  files_explored: number;
  focus_files: Array<{ path: string; reads: number; last_tool: string }>;
  edited_files: string[];
  key_searches: Array<{ query: string; results: number }>;
  dead_ends: Array<{ query: string; reason: string }>;
  /** Structural landmarks: central + recently changed symbols */
  landmarks?: StructuralLandmark[];
}

/** Full snapshot result returned by getSnapshot() */
interface SessionSnapshot {
  snapshot: string;   // compact markdown for context injection
  structured: SessionSnapshotStructured;
  estimated_tokens: number;
}

export class SessionJournal {
  private entries: JournalEntry[] = [];
  private filesRead = new Set<string>();
  private zeroResultQueries = new Map<string, string>(); // hash → summary
  private allHashes = new Map<string, JournalEntry>(); // hash → first entry
  private dedupSavedTokens = 0;
  /** Tracks timestamps of get_task_context calls for follow-up analysis */
  private taskContextTimestamps: number[] = [];
  /** Path for periodic snapshot flushing (set via enablePeriodicSnapshot) */
  private snapshotPath: string | null = null;
  private snapshotFlushInterval = 5;
  /** Optional provider for structural landmarks (PageRank + recently edited symbols) */
  private landmarkProvider: LandmarkProvider | null = null;

  /** Tools whose results are content-heavy and safe to dedup (deterministic for same params) */
  private static readonly DEDUP_TOOLS = new Set([
    'get_symbol', 'get_outline', 'get_context_bundle', 'get_call_graph',
    'get_type_hierarchy', 'get_import_graph', 'get_dependency_diagram',
    'get_component_tree', 'get_dataflow', 'get_control_flow',
    'get_middleware_chain', 'get_di_tree', 'get_model_context',
    'get_schema',
  ]);

  /**
   * Check if this exact call was made before. Call BEFORE executing the tool.
   * Returns DuplicateInfo with action='dedup' for content-heavy tools (skip execution),
   * or action='warn' for search tools (still execute but warn).
   * Returns null for first-time calls.
   */
  checkDuplicate(tool: string, params: Record<string, unknown>): DuplicateInfo | null {
    const hash = this.hash(tool, params);
    const prev = this.allHashes.get(hash);
    if (!prev) return null;

    const summary = this.buildSummary(tool, params);

    // Content-heavy tools with stored compact result → dedup (skip execution)
    if (SessionJournal.DEDUP_TOOLS.has(tool) && prev.compact_result) {
      return {
        action: 'dedup',
        message: `Deduplicated: "${summary}" was already returned this session (saved ~${prev.result_tokens ?? 0} tokens). Showing compact reference.`,
        compact_result: prev.compact_result,
        saved_tokens: prev.result_tokens ?? 0,
      };
    }

    // Zero-result or search tools → warn only
    if (prev.result_count === 0) {
      return {
        action: 'warn',
        message: `Duplicate query: "${summary}" was already executed with 0 results. This pattern does not exist in the codebase.`,
        compact_result: null,
        saved_tokens: 0,
      };
    }
    return {
      action: 'warn',
      message: `Duplicate query: "${summary}" was already executed (returned ${prev.result_count} results).`,
      compact_result: null,
      saved_tokens: 0,
    };
  }

  /**
   * Record a tool call AFTER execution with the result count.
   * For dedup-able tools, also store a compact snapshot of the result.
   */
  record(
    tool: string,
    params: Record<string, unknown>,
    resultCount: number,
    opts?: { compactResult?: Record<string, unknown>; resultTokens?: number },
  ): void {
    const summary = this.buildSummary(tool, params);
    const hash = this.hash(tool, params);

    const entry: JournalEntry = {
      tool,
      params_hash: hash,
      params_summary: summary,
      result_count: resultCount,
      timestamp: Date.now(),
      compact_result: opts?.compactResult,
      result_tokens: opts?.resultTokens,
    };
    this.entries.push(entry);

    // Track file reads
    if (tool === 'get_symbol' || tool === 'get_outline') {
      const path = (params.path ?? params.file_path ?? '') as string;
      if (path) this.filesRead.add(path);
    }

    // Track zero-result searches
    if (resultCount === 0 && this.isSearchTool(tool)) {
      this.zeroResultQueries.set(hash, summary);
    }

    // Store first occurrence
    if (!this.allHashes.has(hash)) {
      this.allHashes.set(hash, entry);
    }

    // Track task context calls for prefetch learning
    if (tool === 'get_task_context' || tool === 'get_feature_context') {
      this.taskContextTimestamps.push(entry.timestamp);
    }

    // Periodic snapshot flush for PreCompact hook
    if (this.snapshotPath && this.entries.length % this.snapshotFlushInterval === 0) {
      try { this.flushSnapshotFile(this.snapshotPath); } catch { /* best-effort */ }
    }
  }

  /**
   * Enable periodic snapshot flushing to a file.
   * After enabling, every `interval` tool calls the snapshot is written to disk
   * so that the PreCompact hook can read it.
   */
  enablePeriodicSnapshot(snapshotPath: string, interval = 5): void {
    this.snapshotPath = snapshotPath;
    this.snapshotFlushInterval = interval;
  }

  /**
   * Set a provider for structural landmarks (PageRank top symbols + recently edited).
   * Called during snapshot generation to inject landmarks that survive context compaction.
   */
  setLandmarkProvider(provider: LandmarkProvider): void {
    this.landmarkProvider = provider;
  }

  /** Record tokens saved by deduplication */
  recordDedupSaving(tokens: number): void {
    this.dedupSavedTokens += tokens;
  }

  /** Total tokens saved by dedup this session */
  getDedupSavedTokens(): number {
    return this.dedupSavedTokens;
  }

  /**
   * Analyze what files/symbols agents typically request AFTER a get_task_context call.
   * Returns files that are frequently accessed as follow-ups, suggesting they should
   * be included in future task context results.
   *
   * Uses only data from the current session. Cross-session learning uses
   * persisted session summaries (see session-resume.ts).
   */
  getPrefetchBoosts(): PrefetchBoost[] {
    if (this.taskContextTimestamps.length === 0) return [];

    // For each task_context call, collect files accessed within the next N calls
    const FOLLOW_UP_WINDOW = 10; // Look at the next 10 tool calls
    const fileCounts = new Map<string, number>();

    for (const tcTimestamp of this.taskContextTimestamps) {
      // Find the index of this task context call
      const tcIdx = this.entries.findIndex(e => e.timestamp === tcTimestamp);
      if (tcIdx < 0) continue;

      // Look at the next FOLLOW_UP_WINDOW entries
      const followUps = this.entries.slice(tcIdx + 1, tcIdx + 1 + FOLLOW_UP_WINDOW);
      for (const entry of followUps) {
        const file = this.extractFileFromEntry(entry);
        if (file) {
          fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
        }
      }
    }

    return [...fileCounts.entries()]
      .filter(([, count]) => count >= 2) // Only boost files accessed 2+ times
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([file, frequency]) => ({ file, frequency }));
  }

  private extractFileFromEntry(entry: JournalEntry): string | null {
    // Extract file from params_summary (e.g., get_symbol("src/server.ts::foo#function"))
    const match = entry.params_summary.match(/\("([^"]+)/);
    if (!match) return null;
    const val = match[1];

    // symbol_id format: "file.ts::symbol#kind"
    const symMatch = val.match(/^([^:]+)::/);
    if (symMatch) return symMatch[1];

    // Direct path
    if (val.includes('/') || val.includes('.')) return val;
    return null;
  }

  /** Get a summary of the session journal */
  getSummary(): JournalSummary {
    const duplicateHashes = new Set<string>();
    const seen = new Set<string>();
    for (const entry of this.entries) {
      if (seen.has(entry.params_hash)) {
        duplicateHashes.add(entry.params_hash);
      }
      seen.add(entry.params_hash);
    }

    return {
      total_entries: this.entries.length,
      files_read: [...this.filesRead],
      searches_with_zero_results: [...this.zeroResultQueries.values()],
      duplicate_queries: [...duplicateHashes].map(h => this.allHashes.get(h)?.params_summary ?? h),
    };
  }

  /** Get all entries */
  getEntries(): JournalEntry[] {
    return [...this.entries];
  }

  /**
   * Detect wasteful usage patterns and return an optimization hint, or null if everything looks fine.
   * Called after each tool execution to provide real-time coaching.
   */
  getOptimizationHint(currentTool: string, currentParams: Record<string, unknown>): string | null {
    const recentEntries = this.entries.slice(-20); // Look at recent activity only

    // Pattern 1: Reading many symbols from the same file → suggest get_context_bundle or Read
    if (currentTool === 'get_symbol') {
      const currentFile = this.extractFile(currentParams);
      if (currentFile) {
        const sameFileReads = recentEntries.filter(
          e => e.tool === 'get_symbol' && e.params_summary.includes(currentFile),
        ).length;
        if (sameFileReads >= 4) {
          return `You've read ${sameFileReads} symbols from "${currentFile}" individually. Consider using get_context_bundle with multiple symbol_ids[] or Read for the full file — it would be cheaper.`;
        }
      }
    }

    // Pattern 2: search → get_symbol chain when get_task_context would be better
    if (currentTool === 'get_symbol') {
      const recentSearches = recentEntries.filter(e => e.tool === 'search').length;
      const recentGetSymbol = recentEntries.filter(e => e.tool === 'get_symbol').length;
      if (recentSearches >= 2 && recentGetSymbol >= 3 && this.entries.length <= 10) {
        return 'You\'re chaining search → get_symbol calls. Consider starting with get_task_context("your task description") — it returns all relevant context in one call.';
      }
    }

    // Pattern 3: Multiple independent tool calls → suggest batch
    if (this.entries.length >= 6) {
      const lastN = this.entries.slice(-6);
      const uniqueTools = new Set(lastN.map(e => e.tool));
      const allIndependent = lastN.every(e =>
        ['get_outline', 'get_symbol', 'search', 'find_usages'].includes(e.tool),
      );
      if (uniqueTools.size >= 3 && allIndependent) {
        return 'You\'re making many small independent queries. Consider using the batch tool to combine them into a single request — reduces round-trips.';
      }
    }

    // Pattern 4: get_outline followed by get_symbol for every symbol in it
    if (currentTool === 'get_symbol') {
      const lastOutline = [...this.entries].reverse().find(e => e.tool === 'get_outline');
      if (lastOutline) {
        const symbolCallsAfterOutline = this.entries
          .filter(e => e.timestamp >= lastOutline.timestamp && e.tool === 'get_symbol')
          .length;
        if (symbolCallsAfterOutline >= 5) {
          return `You fetched an outline then read ${symbolCallsAfterOutline} symbols individually. For bulk reading, use get_context_bundle with symbol_ids[] or Read the full file.`;
        }
      }
    }

    return null;
  }

  /**
   * Generate a compact session snapshot (~200 tokens) for context injection after compaction.
   * Returns both human-readable markdown and structured data.
   */
  getSnapshot(opts?: {
    maxFiles?: number;
    maxSearches?: number;
    maxEdits?: number;
    includeNegativeEvidence?: boolean;
  }): SessionSnapshot {
    const maxFiles = opts?.maxFiles ?? 10;
    const maxSearches = opts?.maxSearches ?? 5;
    const maxEdits = opts?.maxEdits ?? 10;
    const includeNegative = opts?.includeNegativeEvidence ?? true;

    // Calculate duration
    const firstTs = this.entries.length > 0 ? this.entries[0].timestamp : Date.now();
    const durationSec = Math.round((Date.now() - firstTs) / 1000);

    // Focus files: count reads per file, track last tool used
    const fileReads = new Map<string, { reads: number; lastTool: string }>();
    for (const entry of this.entries) {
      const file = this.extractFileFromEntry(entry);
      if (file) {
        const existing = fileReads.get(file) ?? { reads: 0, lastTool: '' };
        existing.reads++;
        existing.lastTool = entry.tool;
        fileReads.set(file, existing);
      }
    }
    const focusFiles = [...fileReads.entries()]
      .sort((a, b) => b[1].reads - a[1].reads)
      .slice(0, maxFiles)
      .map(([p, v]) => ({ path: p, reads: v.reads, last_tool: v.lastTool }));

    // Edited files: entries where tool was register_edit or tool_input had edit-like semantics
    const editedSet = new Set<string>();
    for (const entry of this.entries) {
      if (entry.tool === 'register_edit') {
        const file = this.extractFileFromEntry(entry);
        if (file) editedSet.add(file);
      }
    }
    const editedFiles = [...editedSet].slice(0, maxEdits);

    // Key searches: search-like tool calls with their result counts
    const searches: Array<{ query: string; results: number }> = [];
    const seenQueries = new Set<string>();
    for (const entry of this.entries) {
      if (this.isSearchTool(entry.tool)) {
        const queryKey = entry.params_summary;
        if (!seenQueries.has(queryKey) && entry.result_count > 0) {
          seenQueries.add(queryKey);
          searches.push({ query: entry.params_summary, results: entry.result_count });
        }
      }
    }
    const keySearches = searches.slice(0, maxSearches);

    // Dead ends: zero-result searches
    const deadEnds: Array<{ query: string; reason: string }> = [];
    if (includeNegative) {
      for (const [, summary] of this.zeroResultQueries) {
        deadEnds.push({
          query: summary,
          reason: `0 results (scanned ${this.entries.length} calls)`,
        });
      }
    }

    // Collect structural landmarks if provider is set
    let landmarks: StructuralLandmark[] | undefined;
    if (this.landmarkProvider) {
      try {
        landmarks = this.landmarkProvider();
      } catch { /* best-effort — don't break snapshot on landmark failure */ }
    }

    const structured: SessionSnapshotStructured = {
      duration_seconds: durationSec,
      total_calls: this.entries.length,
      files_explored: this.filesRead.size,
      focus_files: focusFiles,
      edited_files: editedFiles,
      key_searches: keySearches,
      dead_ends: deadEnds,
      landmarks,
    };

    // Build compact markdown
    const lines: string[] = [];
    const durationStr = durationSec >= 60
      ? `${Math.floor(durationSec / 60)}m`
      : `${durationSec}s`;
    lines.push(`## Session Snapshot (trace-mcp)`);
    lines.push(`**Duration:** ${durationStr} | **Files explored:** ${this.filesRead.size} | **Tool calls:** ${this.entries.length}`);

    if (focusFiles.length > 0) {
      lines.push('');
      lines.push('### Focus files (most accessed)');
      for (const f of focusFiles) {
        lines.push(`- ${f.path} (${f.reads} reads, last: ${f.last_tool})`);
      }
    }

    if (editedFiles.length > 0) {
      lines.push('');
      lines.push('### Edited files');
      for (const f of editedFiles) {
        lines.push(`- ${f}`);
      }
    }

    if (keySearches.length > 0) {
      lines.push('');
      lines.push('### Key searches');
      for (const s of keySearches) {
        lines.push(`- ${s.query} → ${s.results} results`);
      }
    }

    if (includeNegative && deadEnds.length > 0) {
      lines.push('');
      lines.push("### Dead ends (don't re-search)");
      for (const d of deadEnds) {
        lines.push(`- ${d.query} → ${d.reason}`);
      }
    }

    if (landmarks && landmarks.length > 0) {
      lines.push('');
      lines.push('### Structural landmarks (survive compaction)');
      const pagerankLandmarks = landmarks.filter((l) => l.reason === 'pagerank');
      const editedLandmarks = landmarks.filter((l) => l.reason === 'recently_edited');
      if (pagerankLandmarks.length > 0) {
        lines.push('**Central symbols (PageRank top-20):**');
        for (const l of pagerankLandmarks) {
          lines.push(`- \`${l.name}\` (${l.kind}) — ${l.file}:${l.line}`);
        }
      }
      if (editedLandmarks.length > 0) {
        lines.push('**Recently changed:**');
        for (const l of editedLandmarks) {
          lines.push(`- \`${l.name}\` (${l.kind}) — ${l.file}:${l.line}`);
        }
      }
    }

    const snapshot = lines.join('\n');

    // Rough token estimate: ~4 chars per token
    const estimatedTokens = Math.ceil(snapshot.length / 4);

    return { snapshot, structured, estimated_tokens: estimatedTokens };
  }

  /**
   * Write current snapshot to a file so the PreCompact hook can read it.
   * Called periodically by the server (e.g. every 5 tool calls).
   */
  flushSnapshotFile(snapshotPath: string): void {
    if (this.entries.length === 0) return;
    const snapshot = this.getSnapshot();
    const dir = path.dirname(snapshotPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify({
      timestamp: Date.now(),
      markdown: snapshot.snapshot,
      structured: snapshot.structured,
      estimated_tokens: snapshot.estimated_tokens,
    }));
  }

  private extractFile(params: Record<string, unknown>): string | null {
    // Extract file path from symbol_id like "src/server.ts::createServer#function"
    const sid = String(params.symbol_id ?? params.fqn ?? '');
    const match = sid.match(/^([^:]+)::/);
    if (match) return match[1];
    return (params.path ?? params.file_path ?? null) as string | null;
  }

  private isSearchTool(tool: string): boolean {
    return ['search', 'get_feature_context', 'query_by_intent', 'find_usages', 'search_text'].includes(tool);
  }

  private buildSummary(tool: string, params: Record<string, unknown>): string {
    const key = params.query ?? params.description ?? params.symbol_id ?? params.fqn ?? params.file_path ?? params.path ?? '';
    return `${tool}("${String(key).slice(0, 80)}")`;
  }

  private hash(tool: string, params: Record<string, unknown>): string {
    const normalized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params).sort()) {
      if (v !== undefined && v !== null) normalized[k] = v;
    }
    const input = `${tool}:${JSON.stringify(normalized)}`;
    return createHash('sha256').update(input).digest('hex').slice(0, 12);
  }
}
