/**
 * AI Request Tracker — ring buffer that records recent AI calls
 * (embed, generate, rerank) with timing, status, and model info.
 * Exposed via /api/ai/activity so the UI can show live diagnostics.
 */

export type AIRequestType = 'embed' | 'embed_batch' | 'generate' | 'generate_stream' | 'rerank';
export type AIRequestStatus = 'ok' | 'error' | 'pending';

export interface AIRequestEntry {
  id: number;
  type: AIRequestType;
  provider: string;
  model: string;
  url: string;
  status: AIRequestStatus;
  /** Duration in ms (0 while pending) */
  duration_ms: number;
  /** Input size: char count for generate, item count for embed_batch */
  input_size: number;
  /** Output size: char count for generate, vector count for embed_batch */
  output_size: number;
  error?: string;
  timestamp: string; // ISO
}

export interface AIActivityStats {
  total_requests: number;
  total_errors: number;
  total_duration_ms: number;
  by_type: Record<string, { count: number; errors: number; total_ms: number }>;
}

const MAX_ENTRIES = 200;

class AIRequestTracker {
  private entries: AIRequestEntry[] = [];
  private nextId = 1;
  private totalRequests = 0;
  private totalErrors = 0;
  private totalDurationMs = 0;
  private byType: Record<string, { count: number; errors: number; total_ms: number }> = {};

  /** Start tracking a request. Returns the entry (mutated in-place on finish). */
  start(
    type: AIRequestType,
    provider: string,
    model: string,
    url: string,
    inputSize: number,
  ): AIRequestEntry {
    const entry: AIRequestEntry = {
      id: this.nextId++,
      type,
      provider,
      model,
      url,
      status: 'pending',
      duration_ms: 0,
      input_size: inputSize,
      output_size: 0,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }

    return entry;
  }

  /** Mark a tracked request as finished. */
  finish(
    entry: AIRequestEntry,
    status: 'ok' | 'error',
    durationMs: number,
    outputSize: number,
    error?: string,
  ): void {
    entry.status = status;
    entry.duration_ms = durationMs;
    entry.output_size = outputSize;
    if (error) entry.error = error;

    this.totalRequests++;
    this.totalDurationMs += durationMs;
    if (status === 'error') this.totalErrors++;

    const key = entry.type;
    if (!this.byType[key]) this.byType[key] = { count: 0, errors: 0, total_ms: 0 };
    this.byType[key].count++;
    if (status === 'error') this.byType[key].errors++;
    this.byType[key].total_ms += durationMs;
  }

  /** Get recent entries (newest first). */
  getRecent(limit = 50): AIRequestEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  /** Get aggregate stats. */
  getStats(): AIActivityStats {
    return {
      total_requests: this.totalRequests,
      total_errors: this.totalErrors,
      total_duration_ms: this.totalDurationMs,
      by_type: { ...this.byType },
    };
  }

  /** Clear all entries and stats. */
  clear(): void {
    this.entries = [];
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.totalDurationMs = 0;
    this.byType = {};
  }
}

/** Global singleton — shared across all providers in the process. */
export const aiTracker = new AIRequestTracker();
