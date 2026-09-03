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
 * The guard is deliberately positive: it pins the disclaimer that must sit at
 * each of the three places the benchmark is presented. Two review passes tried
 * a phrase blacklist and then a proximity regex instead; both were paraphrased
 * around within minutes, and the regex also flagged the TOON and analytics
 * docs, which legitimately do report real tool calls.
 *
 * ponytail: pins wording, not meaning — an editor who rewrites a pinned
 * sentence gets a failure and has to re-read this file, which is the point. If
 * these strings start churning for innocent reasons, pin section anchors
 * instead of sentences.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** Disclaimer required at each place README.md presents the benchmark. */
const REQUIRED_DISCLAIMERS = [
  // Methodology block
  'No trace-mcp tool is invoked.',
  // The standalone caveat paragraph above "Run it yourself"
  '**This is a synthetic estimate**',
  // Quick start, where `npx trace-mcp benchmark .` is first mentioned
  'synthetic estimate computed from your index, not a record of real tool calls',
];

describe('benchmark_project is described as an estimate', () => {
  it.each(REQUIRED_DISCLAIMERS)('README.md still says: %s', (phrase) => {
    expect(
      readFileSync(join(ROOT, 'README.md'), 'utf-8'),
      'README.md lost a benchmark disclaimer — benchmark_project invokes no tool (TRA-762)',
    ).toContain(phrase);
  });

  it('benchmark.ts still carries its synthetic-estimator caveat', () => {
    const source = readFileSync(join(ROOT, 'src', 'analytics', 'benchmark.ts'), 'utf-8');
    expect(source).toContain('not real tool invocations');
  });

  it('the documented fallback chars-per-token ratio matches the code', () => {
    const source = readFileSync(join(ROOT, 'src', 'analytics', 'benchmark.ts'), 'utf-8');
    const ratio = source.match(/const DEFAULT_CHARS_PER_TOKEN = ([\d.]+);/)?.[1];
    expect(ratio, 'DEFAULT_CHARS_PER_TOKEN not found in benchmark.ts').toBeDefined();
    expect(
      readFileSync(join(ROOT, 'README.md'), 'utf-8'),
      `README.md quotes a fallback chars-per-token ratio other than ${ratio}`,
    ).toContain(`fixed chars-per-token ratio of ${ratio}`);
  });
});
