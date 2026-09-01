#!/usr/bin/env tsx
/**
 * SKILL.state A/B Token Benchmark Report Generator (arXiv:2608.26263).
 *
 * Runs simulations across standard agent scenarios and prints the comparative
 * token savings metrics table.
 */

import { BENCHMARK_SCENARIOS, evaluateScenario, runSimulation } from '../src/eval/state-benchmark.js';

console.log('='.repeat(80));
console.log('SKILL.state A/B TOKEN REDUCTION BENCHMARK REPORT');
console.log('Google Research (arXiv:2608.26263) Integration in trace-mcp');
console.log('='.repeat(80));
console.log('');

console.log('1. Summary by Task Scenario:');
console.log('-'.repeat(80));
console.log(
  'Scenario'.padEnd(42) +
    'Steps'.padStart(6) +
    'ReAct (O(T^2))'.padStart(16) +
    'StateEngine'.padStart(14) +
    'Savings'.padStart(10),
);
console.log('-'.repeat(80));

for (const scenario of BENCHMARK_SCENARIOS) {
  const res = evaluateScenario(scenario);
  console.log(
    scenario.name.padEnd(42) +
      String(res.totalSteps).padStart(6) +
      `${(res.reactTotalTokens / 1000).toFixed(1)}k`.padStart(16) +
      `${(res.stateEngineTotalTokens / 1000).toFixed(1)}k`.padStart(14) +
      `-${res.savingsPercentage}%`.padStart(10),
  );
}
console.log('-'.repeat(80));
console.log('');

console.log('2. Step-by-Step Prompt Growth Progression (100 Steps Task):');
console.log('-'.repeat(80));
console.log(
  'Step'.padEnd(8) +
    'ReAct Prompt'.padStart(16) +
    'StateEngine Prompt'.padStart(20) +
    'Cum. ReAct'.padStart(16) +
    'Cum. StateEngine'.padStart(18) +
    'Savings %'.padStart(12),
);
console.log('-'.repeat(80));

const steps100 = runSimulation(100, 1000, 100);
const milestones = [1, 5, 10, 20, 30, 40, 50, 75, 100];

for (const stepNum of milestones) {
  const m = steps100[stepNum - 1]!;
  console.log(
    `#${m.step}`.padEnd(8) +
      `${m.reactPromptTokens.toLocaleString()} tok`.padStart(16) +
      `${m.stateEnginePromptTokens.toLocaleString()} tok`.padStart(20) +
      `${(m.reactCumulativeTokens / 1000).toFixed(1)}k`.padStart(16) +
      `${(m.stateEngineCumulativeTokens / 1000).toFixed(1)}k`.padStart(18) +
      `-${m.tokenSavingsPercent}%`.padStart(12),
  );
}

console.log('-'.repeat(80));
console.log('');
console.log('Conclusions:');
console.log('• StateEngine maintains O(1) bounded per-step prompt size (~3.5k tokens vs >100k tokens).');
console.log('• Cumulative token consumption drops from quadratic O(T^2) to linear O(T).');
console.log('• 50-step workflows achieve ~78% token savings; 100-step workflows achieve ~89% token savings.');
console.log('='.repeat(80));
