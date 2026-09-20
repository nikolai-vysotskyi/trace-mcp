/**
 * Compaction economics for session memory (TRA-1703).
 *
 * MIT attribution: pure decision logic ported 1:1 from NVlabs/SoL-Pi
 * (https://github.com/NVlabs/SoL-Pi —
 * `src/sol-pi/extensions/online-context-compact/economics.ts`:
 * `estimateRemainingRequests`, `decideCompaction`, `DEFAULT_COMPACTION_ECONOMICS`).
 * `DEFAULT_CACHE_WRITE_READ_RATIO` is SoL-Pi's `src/sol-pi/config.ts`
 * `DEFAULT_CACHE_WRITE_READ_RATIO` (12.5). Only formatting was adapted to
 * repo style (2-space indent, single quotes); every branch, constant, and
 * formula matches upstream.
 *
 * What this is: an economic gate that decides WHEN to compact — breakeven
 * write cost vs per-request saving over the remaining request horizon —
 * instead of a global token cap.
 *
 * Integration scope for trace-mcp (no Pi mechanics ported):
 * - Callers: session memory (`search_sessions`, `get_wake_up`, `plan_turn`,
 *   decision memory). Feed `completedBoundaryRequestCounts` from completed
 *   sub-task boundaries (journal/plan transitions) and `remainingBoundaries`
 *   from the open plan; compact the history/plan summary when
 *   `decision.compact` is true.
 * - SoL-Pi's `plan.ts` ProgressSummary cards
 *   (filesChanged/verification/decisions/nextWork) are the ready-made shape
 *   for our progress summaries — cf. `SessionSnapshotStructured` in
 *   `./journal.js` — but `plan.ts` parsing/validation itself is NOT ported.
 * - Deliberately NOT ported (Pi runtime): `compact()`/`abort()` execution,
 *   `agent_settled` hooks, `update_plan` interception, session-entry state
 *   (`state.ts`: epoch/plan/pendingProgress/debt bookkeeping). trace-mcp
 *   owns its own runtime; this module only answers "compact now?".
 */

export interface CompactionEconomics {
  readonly remainingRequestScale: number;
  readonly remainingRequestStddevK: number;
  readonly windowReserveTokens: number;
  readonly firstCompactionRequestScale: number;
  readonly subsequentCompactionMargin: number;
}

export const DEFAULT_COMPACTION_ECONOMICS: CompactionEconomics = Object.freeze({
  remainingRequestScale: 1,
  remainingRequestStddevK: 0,
  windowReserveTokens: 16_384,
  firstCompactionRequestScale: 2,
  subsequentCompactionMargin: 1.5,
});

/**
 * Default prompt-cache write/read price ratio (SoL-Pi `config.ts`, MIT).
 * Passed as `cacheWriteReadRatio` when the caller has no measured ratio;
 * `null` means "ratio unknown" and defers economic compaction.
 */
export const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5;

export type CompactionReason =
  | 'economic'
  | 'window_protection'
  | 'deferred_economic'
  | 'deferred_subsequent_margin'
  | 'deferred_carried_debt'
  | 'horizon_unavailable'
  | 'cache_ratio_unavailable'
  | 'native_not_compactable'
  | 'non_positive_saving';

export interface RequestHorizonEstimate {
  readonly completedBoundaryRequestCounts: readonly number[];
  readonly requestsPerBoundaryMean: number;
  readonly requestsPerBoundaryLowerBound: number;
  readonly unboundedExpectedRemainingRequests: number;
  readonly averageContextTokenIncrement: number | null;
  readonly windowRequestUpperBound: number | null;
  readonly expectedRemainingRequests: number;
}

export interface CompactionDecision {
  readonly writeTokens: number;
  readonly archiveTokens: number;
  readonly memoTokens: number;
  readonly contextTokens: number;
  readonly completedBoundaryRequestCounts: readonly number[] | null;
  readonly requestsPerBoundaryMean: number | null;
  readonly requestsPerBoundaryLowerBound: number | null;
  readonly unboundedExpectedRemainingRequests: number | null;
  readonly averageContextTokenIncrement: number | null;
  readonly windowRequestUpperBound: number | null;
  readonly expectedRemainingRequests: number | null;
  readonly breakevenRequests: number | null;
  readonly combinedBreakevenRequests: number | null;
  readonly effectiveHorizonRequests: number | null;
  readonly cacheWriteReadRatio: number | null;
  readonly incrementalCacheCostRatio: number | null;
  readonly priorCompactionCount: number;
  readonly carriedDebtTokens: number;
  readonly cacheDebtRepaymentTokens: number;
  readonly compact: boolean;
  readonly reason: CompactionReason;
}

const MINIMUM_VARIANCE_SAMPLES = 3;
const SMALL_SAMPLE_SCALE = 0.5;

export function estimateRemainingRequests(input: {
  readonly completedBoundaryRequestCounts: readonly number[];
  readonly remainingBoundaries: number;
  readonly scale: number;
  readonly standardDeviationK: number;
  readonly contextTokens: number;
  readonly contextWindowTokens: number | null;
  readonly averageContextTokenIncrement: number | null;
}): RequestHorizonEstimate {
  const mean =
    input.completedBoundaryRequestCounts.reduce((total, count) => total + count, 0) /
    Math.max(1, input.completedBoundaryRequestCounts.length);
  let lowerBound = mean;
  if (input.standardDeviationK !== 0) {
    if (input.completedBoundaryRequestCounts.length < MINIMUM_VARIANCE_SAMPLES) {
      lowerBound *= SMALL_SAMPLE_SCALE;
    } else {
      const variance = input.completedBoundaryRequestCounts.reduce(
        (total, count) => total + (count - mean) ** 2,
        0,
      );
      const deviation = Math.sqrt(variance / (input.completedBoundaryRequestCounts.length - 1));
      lowerBound = Math.max(0, mean - input.standardDeviationK * deviation);
    }
  }

  const unboundedExpectedRemainingRequests =
    1 + Math.floor(lowerBound * Math.max(0, input.remainingBoundaries) * input.scale);
  const windowRequestUpperBound =
    input.contextWindowTokens === null ||
    input.averageContextTokenIncrement === null ||
    input.averageContextTokenIncrement <= 0
      ? null
      : Math.max(
          0,
          Math.floor(
            (input.contextWindowTokens - input.contextTokens) / input.averageContextTokenIncrement,
          ),
        );

  return {
    completedBoundaryRequestCounts: [...input.completedBoundaryRequestCounts],
    requestsPerBoundaryMean: mean,
    requestsPerBoundaryLowerBound: lowerBound,
    unboundedExpectedRemainingRequests,
    averageContextTokenIncrement: input.averageContextTokenIncrement,
    windowRequestUpperBound,
    expectedRemainingRequests:
      windowRequestUpperBound === null
        ? unboundedExpectedRemainingRequests
        : Math.min(unboundedExpectedRemainingRequests, windowRequestUpperBound),
  };
}

export function decideCompaction(input: {
  readonly writeTokens: number;
  readonly archiveTokens: number;
  readonly memoTokens: number;
  readonly contextTokens: number;
  readonly completedBoundaryRequestCounts: readonly number[] | null;
  readonly remainingBoundaries: number;
  readonly averageContextTokenIncrement: number | null;
  readonly contextWindowTokens: number | null;
  readonly priorCompactionCount: number;
  readonly carriedDebtTokens: number;
  readonly cacheDebtRepaymentTokens: number;
  readonly cacheWriteReadRatio: number | null;
  readonly economics: CompactionEconomics;
}): CompactionDecision {
  const horizon =
    input.completedBoundaryRequestCounts === null
      ? null
      : estimateRemainingRequests({
          completedBoundaryRequestCounts: input.completedBoundaryRequestCounts,
          remainingBoundaries: input.remainingBoundaries,
          scale: input.economics.remainingRequestScale,
          standardDeviationK: input.economics.remainingRequestStddevK,
          contextTokens: input.contextTokens,
          contextWindowTokens: input.contextWindowTokens,
          averageContextTokenIncrement: input.averageContextTokenIncrement,
        });
  const savingTokens = input.archiveTokens - input.memoTokens;
  const incrementalCacheCostRatio =
    input.cacheWriteReadRatio === null ? null : Math.max(0, input.cacheWriteReadRatio - 1);
  const breakevenRequests =
    savingTokens > 0 && incrementalCacheCostRatio !== null
      ? (input.writeTokens * incrementalCacheCostRatio) / savingTokens
      : null;
  const combinedBreakevenRequests =
    savingTokens > 0 && incrementalCacheCostRatio !== null
      ? (input.carriedDebtTokens + input.writeTokens * incrementalCacheCostRatio) / savingTokens
      : null;
  const firstCompaction = input.priorCompactionCount === 0;
  const effectiveHorizonRequests =
    horizon === null
      ? null
      : firstCompaction
        ? Math.min(
            horizon.expectedRemainingRequests * input.economics.firstCompactionRequestScale,
            horizon.windowRequestUpperBound ?? Number.POSITIVE_INFINITY,
          )
        : horizon.expectedRemainingRequests;
  const windowProtection =
    input.contextWindowTokens !== null &&
    input.contextTokens >= input.contextWindowTokens - input.economics.windowReserveTokens;
  const baseEconomic =
    horizon !== null &&
    horizon.expectedRemainingRequests > 0 &&
    breakevenRequests !== null &&
    breakevenRequests <= horizon.expectedRemainingRequests;
  const firstEconomic =
    firstCompaction &&
    effectiveHorizonRequests !== null &&
    effectiveHorizonRequests > 0 &&
    breakevenRequests !== null &&
    breakevenRequests <= effectiveHorizonRequests;
  const subsequentMarginOpen =
    !firstCompaction &&
    horizon !== null &&
    breakevenRequests !== null &&
    breakevenRequests * input.economics.subsequentCompactionMargin <=
      horizon.expectedRemainingRequests;
  const carriedDebtGateOpen =
    !firstCompaction &&
    horizon !== null &&
    combinedBreakevenRequests !== null &&
    combinedBreakevenRequests <= horizon.expectedRemainingRequests;
  const economic = firstCompaction
    ? firstEconomic
    : baseEconomic && subsequentMarginOpen && carriedDebtGateOpen;
  const compressible = savingTokens > 0;
  const compact = compressible && (windowProtection || economic);

  return {
    writeTokens: input.writeTokens,
    archiveTokens: input.archiveTokens,
    memoTokens: input.memoTokens,
    contextTokens: input.contextTokens,
    ...(horizon ?? {
      completedBoundaryRequestCounts: null,
      requestsPerBoundaryMean: null,
      requestsPerBoundaryLowerBound: null,
      unboundedExpectedRemainingRequests: null,
      averageContextTokenIncrement: input.averageContextTokenIncrement,
      windowRequestUpperBound: null,
      expectedRemainingRequests: null,
    }),
    breakevenRequests,
    combinedBreakevenRequests,
    effectiveHorizonRequests,
    cacheWriteReadRatio: input.cacheWriteReadRatio,
    incrementalCacheCostRatio,
    priorCompactionCount: input.priorCompactionCount,
    carriedDebtTokens: input.carriedDebtTokens,
    cacheDebtRepaymentTokens: input.cacheDebtRepaymentTokens,
    compact,
    reason: !compressible
      ? 'non_positive_saving'
      : windowProtection
        ? 'window_protection'
        : economic
          ? 'economic'
          : horizon === null
            ? 'horizon_unavailable'
            : breakevenRequests === null
              ? 'cache_ratio_unavailable'
              : !firstCompaction && baseEconomic && !subsequentMarginOpen
                ? 'deferred_subsequent_margin'
                : !firstCompaction && baseEconomic && !carriedDebtGateOpen
                  ? 'deferred_carried_debt'
                  : 'deferred_economic',
  };
}
