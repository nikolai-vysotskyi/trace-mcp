/**
 * A/B Benchmarking harness for SKILL.state (arXiv:2608.26263).
 *
 * Compares quadratic conversational accumulation (ReAct) against
 * linear structured state tracking (StateEngine).
 */

export interface BenchmarkStepMetrics {
  step: number;
  reactPromptTokens: number;
  stateEnginePromptTokens: number;
  reactCumulativeTokens: number;
  stateEngineCumulativeTokens: number;
  tokenSavingsPercent: number;
}

export interface TaskScenario {
  name: string;
  stepsCount: number;
  avgToolOutputTokens: number;
  avgToolCallTokens: number;
}

export const BENCHMARK_SCENARIOS: TaskScenario[] = [
  {
    name: 'Symbol refactoring & usages fix',
    stepsCount: 15,
    avgToolOutputTokens: 650,
    avgToolCallTokens: 80,
  },
  {
    name: 'New feature addition with tests',
    stepsCount: 25,
    avgToolOutputTokens: 800,
    avgToolCallTokens: 90,
  },
  {
    name: 'Architecture migration & edge resolvers',
    stepsCount: 50,
    avgToolOutputTokens: 950,
    avgToolCallTokens: 100,
  },
  {
    name: 'Multi-service dependency graph audit',
    stepsCount: 100,
    avgToolOutputTokens: 1100,
    avgToolCallTokens: 120,
  },
];

export interface BenchmarkResult {
  scenarioName: string;
  totalSteps: number;
  reactTotalTokens: number;
  stateEngineTotalTokens: number;
  tokensSaved: number;
  savingsPercentage: number;
  stepBreakdown: BenchmarkStepMetrics[];
}

/**
 * Simulates and calculates token metrics across execution steps.
 *
 * @param stepsCount Number of execution turns T
 * @param avgToolOutputTokens Average tokens returned by tools (e.g. outline, symbol, search)
 * @param avgToolCallTokens Average tokens in tool call params
 * @param baseSystemPromptTokens Base system prompt size (default: ~1,500 tokens)
 * @param stateMarkdownTokens Average size of compact state markdown (default: 350 —
 *   measured over 30 real sessions by `state-trace-replay.ts`)
 * @param slidingWindowCalls Number of recent calls retained in StateEngine window (default: 2)
 */
export function runSimulation(
  stepsCount: number,
  avgToolOutputTokens = 850,
  avgToolCallTokens = 100,
  baseSystemPromptTokens = 1500,
  stateMarkdownTokens = 350,
  slidingWindowCalls = 2,
): BenchmarkStepMetrics[] {
  const metrics: BenchmarkStepMetrics[] = [];

  let reactCum = 0;
  let stateCum = 0;

  const perStepToolTokens = avgToolCallTokens + avgToolOutputTokens;

  for (let t = 1; t <= stepsCount; t++) {
    // ReAct accumulates all previous steps:
    // Prompt at turn t = baseSystemPrompt + (t - 1) * perStepToolTokens
    const reactPrompt = baseSystemPromptTokens + (t - 1) * perStepToolTokens;
    reactCum += reactPrompt;

    // StateEngine:
    // Prompt at turn t = baseSystemPrompt + stateMarkdown + min(t - 1, slidingWindowCalls) * perStepToolTokens
    const recentCalls = Math.min(t - 1, slidingWindowCalls);
    const statePrompt =
      baseSystemPromptTokens + stateMarkdownTokens + recentCalls * perStepToolTokens;
    stateCum += statePrompt;

    const savings = ((reactCum - stateCum) / reactCum) * 100;

    metrics.push({
      step: t,
      reactPromptTokens: reactPrompt,
      stateEnginePromptTokens: statePrompt,
      reactCumulativeTokens: reactCum,
      stateEngineCumulativeTokens: stateCum,
      tokenSavingsPercent: Math.max(0, Number(savings.toFixed(1))),
    });
  }

  return metrics;
}

export function evaluateScenario(scenario: TaskScenario): BenchmarkResult {
  const breakdown = runSimulation(
    scenario.stepsCount,
    scenario.avgToolOutputTokens,
    scenario.avgToolCallTokens,
  );

  const last = breakdown[breakdown.length - 1]!;
  const reactTotal = last.reactCumulativeTokens;
  const stateTotal = last.stateEngineCumulativeTokens;
  const saved = reactTotal - stateTotal;
  const savingsPct = Number(((saved / reactTotal) * 100).toFixed(1));

  return {
    scenarioName: scenario.name,
    totalSteps: scenario.stepsCount,
    reactTotalTokens: reactTotal,
    stateEngineTotalTokens: stateTotal,
    tokensSaved: saved,
    savingsPercentage: savingsPct,
    stepBreakdown: breakdown,
  };
}
