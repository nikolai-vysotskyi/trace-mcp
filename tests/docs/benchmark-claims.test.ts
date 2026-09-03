import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `benchmark_project` never invokes a trace-mcp tool (TRA-762).
 *
 * Both sides of the comparison are character-count estimates: the baseline from
 * `byte_length` in the index, the trace-mcp side from indexed symbol/signature
 * sizes or a fixed per-scenario multiplier. `src/analytics/benchmark.ts` says so
 * in its header and repeats it in the tool's `caveats` output. README.md had
 * drifted to claiming the trace-mcp side was "actual tokens returned by
 * trace-mcp tools", which an outside reviewer caught by reading the source.
 *
 * This guards the two directions that drift: the docs re-acquiring a
 * measured-savings claim, and the code silently losing its own disclaimer.
 */

const ROOT = join(import.meta.dirname, '..', '..');

const FORBIDDEN = [
  'actual tokens returned by trace-mcp',
  'actual tokens returned by trace',
  'measured tokens returned',
];

describe('benchmark_project is described as an estimate', () => {
  it.each(['README.md', 'docs/index.html'])('%s claims no measured tool output', (page) => {
    const source = readFileSync(join(ROOT, page), 'utf-8');
    const found = FORBIDDEN.filter((claim) => source.includes(claim));
    expect(
      found,
      `${page} claims benchmark_project returns real tool output — it does not (TRA-762)`,
    ).toEqual([]);
  });

  it('benchmark.ts still carries its synthetic-estimator caveat', () => {
    const source = readFileSync(join(ROOT, 'src', 'analytics', 'benchmark.ts'), 'utf-8');
    expect(source).toContain('not real tool invocations');
  });
});
