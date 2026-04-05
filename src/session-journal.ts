/**
 * Session journal — tracks tool calls, deduplicates queries, and flags zero-result repeats.
 *
 * Two-phase API:
 *  1. checkDuplicate(tool, params) — before executing, returns warning if duplicate
 *  2. record(tool, params, resultCount) — after executing, logs the result
 */

import { createHash } from 'node:crypto';

export interface JournalEntry {
  tool: string;
  params_hash: string;
  params_summary: string;
  result_count: number;
  timestamp: number;
}

export interface JournalSummary {
  total_entries: number;
  files_read: string[];
  searches_with_zero_results: string[];
  duplicate_queries: string[];
}

export class SessionJournal {
  private entries: JournalEntry[] = [];
  private filesRead = new Set<string>();
  private zeroResultQueries = new Map<string, string>(); // hash → summary
  private allHashes = new Map<string, JournalEntry>(); // hash → first entry

  /**
   * Check if this exact call was made before. Call BEFORE executing the tool.
   * Returns a warning string if duplicate, null otherwise.
   */
  checkDuplicate(tool: string, params: Record<string, unknown>): string | null {
    const hash = this.hash(tool, params);
    const prev = this.allHashes.get(hash);
    if (!prev) return null;

    const summary = this.buildSummary(tool, params);
    if (prev.result_count === 0) {
      return `Duplicate query: "${summary}" was already executed with 0 results. This pattern does not exist in the codebase.`;
    }
    return `Duplicate query: "${summary}" was already executed (returned ${prev.result_count} results).`;
  }

  /**
   * Record a tool call AFTER execution with the result count.
   */
  record(tool: string, params: Record<string, unknown>, resultCount: number): void {
    const summary = this.buildSummary(tool, params);
    const hash = this.hash(tool, params);

    const entry: JournalEntry = {
      tool,
      params_hash: hash,
      params_summary: summary,
      result_count: resultCount,
      timestamp: Date.now(),
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
    return createHash('md5').update(input).digest('hex').slice(0, 12);
  }
}
