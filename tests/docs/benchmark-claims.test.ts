import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `benchmark_project` never invokes a trace-mcp tool (TRA-762).
 *
 * Every figure it prints is a scenario-specific synthetic heuristic over the
 * index — real byte/source/signature sizes for some scenarios, assumed grep
 * yields and reply sizes for others, a fixed 0.05–0.45 fraction of the baseline
 * for the rest. `src/analytics/benchmark.ts` says so in its header and repeats
 * it in the tool's `caveats` output. README.md had drifted to claiming the
 * trace-mcp side was "actual tokens returned by trace-mcp tools", which an
 * outside reviewer caught by reading the source.
 *
 * The guard is positive on purpose: it pins the disclaimers that must be
 * present, because a blacklist of phrasings is trivially paraphrased around.
 * The blacklist below is only a backstop for the exact wording that shipped.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** Every place the benchmark is presented must carry one of these. */
const REQUIRED_DISCLAIMERS = [
  'No trace-mcp tool is invoked.',
  '**This is a synthetic estimate**',
  'synthetic estimate computed from your index, not a record of real tool calls',
];

/**
 * Backstop: "actual/measured/observed/real ... token(s) ... tool/call/response"
 * within one sentence. Catches the paraphrases a substring blacklist misses.
 */
const MEASURED_CLAIM =
  /\b(actual|measured|observed|real|live)\b[^.\n]{0,80}\btokens?\b[^.\n]{0,80}\b(tool|tools|call|calls|response|responses)\b/i;

describe('benchmark_project is described as an estimate', () => {
  const readme = () => readFileSync(join(ROOT, 'README.md'), 'utf-8');

  it.each(REQUIRED_DISCLAIMERS)('README.md still says: %s', (phrase) => {
    expect(
      readme(),
      `README.md lost a benchmark disclaimer — benchmark_project invokes no tool (TRA-762)`,
    ).toContain(phrase);
  });

  it('README.md claims no measured tool output for the benchmark', () => {
    // Scoped to benchmark prose: other features (TOON output, analytics savings)
    // legitimately do report measurements taken on real tool calls.
    const hits = readme()
      .split('\n')
      .filter((line) => /benchmark|with(out)? trace-mcp/i.test(line))
      .filter((line) => MEASURED_CLAIM.test(line));
    expect(
      hits,
      'README.md reads as if benchmark_project reports real tool output — it does not (TRA-762)',
    ).toEqual([]);
  });

  it('benchmark.ts still carries its synthetic-estimator caveat', () => {
    const source = readFileSync(join(ROOT, 'src', 'analytics', 'benchmark.ts'), 'utf-8');
    expect(source).toContain('not real tool invocations');
  });
});
