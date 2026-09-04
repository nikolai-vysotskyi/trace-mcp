/**
 * Per-call compute ceiling for heavy graph tools (TRA-841).
 *
 * Why this exists: `src/server/budget-defaults.ts` caps *expansive parameters*
 * so the answer stays small, and `computeAdaptiveBudget` sizes context
 * payloads. Both shape the answer. Neither bounds the work done to produce it.
 * A traversal that materializes a tree out of a dense graph runs to completion
 * or to the OS limit, whichever comes first — and an OS-level kill (macOS
 * Jetsam / OOM killer) runs no JS, so `src/daemon/vitals-log.ts` can only
 * record that the daemon died, never which call killed it (TRA-809, TRA-811).
 *
 * The guard is ticked inside the hot loop. It holds three ceilings — wall
 * clock, resident memory, iteration count — and once any is hit, `tick()`
 * returns false forever. Callers stop and return the *partial* result plus
 * `_budget_exceeded`; an abort is never a tool-call error, because a truncated
 * call graph with an explicit reason is a usable answer and a thrown error
 * costs the agent the whole turn.
 *
 * Cost discipline: the iteration ceiling is an integer compare on every tick.
 * The clock and RSS ceilings are only sampled every `SAMPLE_INTERVAL` ticks —
 * `Date.now()` and `process.memoryUsage.rss()` are syscalls and calling them
 * per node would be the slowest thing in the traversal.
 */
import { logger } from './logger.js';
import { readRssMb } from './daemon/vitals-log.js';

export type BudgetExceededReason = 'timeout' | 'rss' | 'iterations';

export interface BudgetExceeded {
  /** Which ceiling was hit */
  reason: BudgetExceededReason;
  /** The ceiling's value: ms for timeout, MB for rss, count for iterations */
  limit: number;
  /** Wall clock consumed when the guard tripped */
  elapsed_ms: number;
  /** Ticks consumed when the guard tripped */
  iterations: number;
  /** Resident memory at the trip, when RSS was the reason */
  rss_mb?: number;
  /** Tool that owns the guard */
  tool: string;
  /** Fixed hint so the agent knows the payload is partial, not empty */
  note: string;
}

export interface ComputeCeilings {
  timeout_ms: number;
  rss_mb: number;
  iterations: number;
}

/**
 * Defaults, chosen from measurement, not taste. `scripts/bench-compute-guard.ts`
 * runs a deliberately heavy `get_call_graph` — a 37,449-symbol graph walked to
 * depth 5 — and it consumes 79,577 ticks in ~85 ms. The iteration ceiling sits
 * ~25x above that and the timeout ~175x, so nothing anyone runs today comes
 * close. The RSS ceiling sits above the ~950 MB idle resident figure reported
 * in TRA-811, so it fires on a runaway call rather than on a normal one.
 */
export const DEFAULT_CEILINGS: ComputeCeilings = {
  timeout_ms: 15_000,
  rss_mb: 3_000,
  iterations: 2_000_000,
};

/** How often the clock and RSS ceilings are actually sampled. */
const SAMPLE_INTERVAL = 4096;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read the ceilings from env on every call — cheap, and keeps tests hermetic. */
export function resolveCeilings(): ComputeCeilings {
  return {
    timeout_ms: envNumber('TRACE_MCP_COMPUTE_TIMEOUT_MS', DEFAULT_CEILINGS.timeout_ms),
    rss_mb: envNumber('TRACE_MCP_COMPUTE_RSS_MB', DEFAULT_CEILINGS.rss_mb),
    iterations: envNumber('TRACE_MCP_COMPUTE_MAX_ITERATIONS', DEFAULT_CEILINGS.iterations),
  };
}

/** `TRACE_MCP_NO_COMPUTE_GUARD=1` disables every guard (debugging escape hatch). */
export function guardsDisabled(): boolean {
  const raw = process.env.TRACE_MCP_NO_COMPUTE_GUARD;
  return raw === '1' || raw === 'true';
}

export class BudgetGuard {
  private readonly startedAt: number;
  private ticks = 0;
  private nextSample = SAMPLE_INTERVAL;
  private tripped: BudgetExceeded | undefined;

  constructor(
    readonly tool: string,
    private readonly ceilings: ComputeCeilings,
    private readonly deps: { now: () => number; rssMb: () => number } = {
      now: Date.now,
      rssMb: readRssMb,
    },
  ) {
    this.startedAt = deps.now();
  }

  /** Consume one unit of work. Returns false once any ceiling has been hit. */
  tick(): boolean {
    if (this.tripped) return false;
    this.ticks++;

    if (this.ticks > this.ceilings.iterations) {
      return this.trip('iterations', this.ceilings.iterations);
    }
    if (this.ticks < this.nextSample) return true;
    this.nextSample = this.ticks + SAMPLE_INTERVAL;
    return this.check();
  }

  /**
   * Force the sampled ceilings to be evaluated now, ignoring the sample
   * interval. Use at coarse boundaries (one depth level, one batch fetch)
   * where a single step is expensive enough to deserve its own check.
   */
  check(): boolean {
    if (this.tripped) return false;

    const elapsed = this.deps.now() - this.startedAt;
    if (elapsed > this.ceilings.timeout_ms) {
      return this.trip('timeout', this.ceilings.timeout_ms);
    }

    const rss = this.deps.rssMb();
    if (rss > this.ceilings.rss_mb) {
      return this.trip('rss', this.ceilings.rss_mb, rss);
    }
    return true;
  }

  /** True once a ceiling has been hit. */
  get aborted(): boolean {
    return this.tripped !== undefined;
  }

  /** Ticks consumed so far — used by the overhead benchmark and by tests. */
  get consumed(): number {
    return this.ticks;
  }

  /**
   * Spread into a tool's result: `{ ...payload, ...guard.marker() }`. Empty
   * object when nothing tripped, so the field never appears on normal calls.
   */
  marker(): { _budget_exceeded?: BudgetExceeded } {
    return this.tripped ? { _budget_exceeded: this.tripped } : {};
  }

  private trip(reason: BudgetExceededReason, limit: number, rssMb?: number): false {
    this.tripped = {
      reason,
      limit,
      elapsed_ms: this.deps.now() - this.startedAt,
      iterations: this.ticks,
      ...(rssMb === undefined ? {} : { rss_mb: rssMb }),
      tool: this.tool,
      note: 'Result is partial: the traversal was stopped at a compute ceiling. Narrow the query (lower depth / tighter scope) or raise the ceiling via the TRACE_MCP_COMPUTE_* env vars.',
    };
    // This is the line that pays back TRA-809: when a heavy tool is the thing
    // driving the daemon toward the OOM killer, the log now says so *before*
    // the process disappears rather than after it is gone.
    logger.warn(this.tripped, 'Compute budget exceeded');
    return false;
  }
}

/** A guard that never trips — used when guards are disabled. */
class NullGuard extends BudgetGuard {
  constructor(tool: string) {
    super(tool, {
      timeout_ms: Number.MAX_SAFE_INTEGER,
      rss_mb: Number.MAX_SAFE_INTEGER,
      iterations: Number.MAX_SAFE_INTEGER,
    });
  }
  override tick(): boolean {
    return true;
  }
  override check(): boolean {
    return true;
  }
}

/** Build a guard for one tool call. */
export function forTool(tool: string): BudgetGuard {
  if (guardsDisabled()) return new NullGuard(tool);
  return new BudgetGuard(tool, resolveCeilings());
}
