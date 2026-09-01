import { describe, expect, it } from 'vitest';
import {
  buildSyntheticBenchmarkDataset,
  computeMilestoneProfiles,
  mean,
  median,
  percentile,
  runBenchmarkOnTask,
  stddev,
  summarizeBenchmark,
} from '../../scripts/bench-state-context.js';

describe('SKILL.state Context Benchmark & Statistics', () => {
  it('computes basic statistical moments accurately', () => {
    const data = [10, 20, 30, 40, 50];
    expect(mean(data)).toBe(30);
    expect(median(data)).toBe(30);
    expect(percentile(data, 50)).toBe(30);
    expect(percentile(data, 90)).toBe(50);
    expect(stddev(data)).toBeCloseTo(15.811, 2);
  });

  it('builds a valid 18-task benchmark dataset covering all 4 categories', () => {
    const dataset = buildSyntheticBenchmarkDataset();
    expect(dataset).toHaveLength(18);

    const categories = dataset.map((d) => d.category);
    expect(categories.filter((c) => c === 'bugfix')).toHaveLength(5);
    expect(categories.filter((c) => c === 'refactoring')).toHaveLength(4);
    expect(categories.filter((c) => c === 'feature')).toHaveLength(5);
    expect(categories.filter((c) => c === 'test')).toHaveLength(4);

    for (const task of dataset) {
      expect(task.steps.length).toBe(task.total_steps);
      expect(task.target_files.length).toBeGreaterThan(0);
      expect(task.steps[0].action_tool).toBeDefined();
    }
  });

  it('executes A/B arms on a task and demonstrates O(T^2) vs O(T) prompt token scaling', () => {
    const dataset = buildSyntheticBenchmarkDataset();
    const task = dataset.find((t) => t.id === 'fix-daemon-flapping')!;
    const result = runBenchmarkOnTask(task);

    expect(result.task_id).toBe('fix-daemon-flapping');
    expect(result.group_a.total_prompt_tokens).toBeGreaterThan(result.group_b.total_prompt_tokens);
    expect(result.prompt_savings_pct).toBeGreaterThan(40);
    expect(result.token_savings_pct).toBeGreaterThan(30);
    expect(result.group_b.pass_at_1).toBe(true);
    expect(result.group_b.loops_detected).toBe(0);

    // Group A prompt grows monotonically with step count
    const telemetry = result.step_telemetry;
    const step1 = telemetry[0];
    const stepLast = telemetry[telemetry.length - 1];

    expect(stepLast.prompt_tokens_a).toBeGreaterThan(step1.prompt_tokens_a * 5);
    // Group B prompt remains bounded O(1)
    expect(stepLast.prompt_tokens_b).toBeLessThan(step1.prompt_tokens_b * 1.5);
  });

  it('computes milestone profiles across tasks', () => {
    const dataset = buildSyntheticBenchmarkDataset().slice(0, 3);
    const results = dataset.map((t) => runBenchmarkOnTask(t));
    const profiles = computeMilestoneProfiles(results);

    expect(profiles.length).toBeGreaterThan(0);
    for (const p of profiles) {
      expect(p.group_a_prompt_mean).toBeGreaterThan(p.group_b_prompt_mean);
      expect(p.savings_pct).toBeGreaterThan(0);
    }
  });

  it('summarizes benchmark runs with aggregate metrics', () => {
    const dataset = buildSyntheticBenchmarkDataset().slice(0, 2);
    const results = dataset.map((t) => runBenchmarkOnTask(t));
    const summary = summarizeBenchmark(results);

    expect(summary.task_count).toBe(2);
    expect(summary.overall_token_savings_pct).toBeGreaterThan(0);
    expect(summary.group_a_total_tokens).toBeGreaterThan(summary.group_b_total_tokens);
    expect(summary.group_b_pass_at_1_pct).toBe(100);
  });
});
