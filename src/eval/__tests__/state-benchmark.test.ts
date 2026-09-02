import { describe, expect, it } from 'vitest';
import { BENCHMARK_SCENARIOS, evaluateScenario, runSimulation } from '../state-benchmark.js';

describe('SKILL.state A/B Token Benchmark (TRA-600)', () => {
  it('demonstrates O(T) vs O(T^2) token growth scaling', () => {
    const steps10 = runSimulation(10);
    const steps25 = runSimulation(25);
    const steps50 = runSimulation(50);
    const steps100 = runSimulation(100);

    const s10 = steps10[steps10.length - 1]!;
    const s25 = steps25[steps25.length - 1]!;
    const s50 = steps50[steps50.length - 1]!;
    const s100 = steps100[steps100.length - 1]!;

    // Verify token savings increase with task length
    expect(s10.tokenSavingsPercent).toBeGreaterThanOrEqual(35);
    expect(s25.tokenSavingsPercent).toBeGreaterThanOrEqual(60);
    expect(s50.tokenSavingsPercent).toBeGreaterThanOrEqual(75);
    expect(s100.tokenSavingsPercent).toBeGreaterThanOrEqual(85);

    // Prompt at step 100 in ReAct should exceed 90,000 tokens
    expect(s100.reactPromptTokens).toBeGreaterThan(90_000);

    // Prompt at step 100 in StateEngine stays bounded. The bound moved from 4,000
    // to 4,500 when the state block's default size was corrected from a guessed
    // 180 tokens to the 600 measured by state-trace-replay.ts.
    expect(s100.stateEnginePromptTokens).toBeLessThan(4_500);
  });

  it('evaluates all standard benchmark scenarios', () => {
    for (const scenario of BENCHMARK_SCENARIOS) {
      const result = evaluateScenario(scenario);
      expect(result.tokensSaved).toBeGreaterThan(0);
      expect(result.savingsPercentage).toBeGreaterThanOrEqual(40);
    }
  });
});
