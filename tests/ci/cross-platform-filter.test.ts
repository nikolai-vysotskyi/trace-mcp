import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

// The `platform` filter decides whether a PR is tested on macOS and Windows.
// For six incidents it was an allowlist of the files that had already broken
// (TRA-236, 326, 375, 567, 638, 755) and it missed the seventh anyway — #1041
// broke on `src/indexer/pipeline.ts`, which no entry covered. TRA-1048 widened
// it to whole trees; this test is what stops it from being narrowed back to a
// list of yesterday's bugs.
const CI = join(import.meta.dirname, '../../.github/workflows/ci.yml');

function platformFilter(): string[] {
  const doc = YAML.parse(readFileSync(CI, 'utf8'));
  const step = doc.jobs.changes.steps.find((s: { id?: string }) => s.id === 'filter');
  return YAML.parse(step.with.filters).platform;
}

describe('cross-platform path filter', () => {
  // Whole trees, not individual files: every shipped source and test file must
  // be covered by construction.
  it.each(['src/**', 'tests/**', 'hooks/**', 'scripts/**', 'package.json', 'pnpm-lock.yaml'])(
    'covers %s',
    (pattern) => {
      expect(platformFilter()).toContain(pattern);
    },
  );

  it('fires the mac+windows matrix off that filter', () => {
    const doc = YAML.parse(readFileSync(CI, 'utf8'));
    const job = doc.jobs['cross-platform-test'];
    expect(job.needs).toContain('changes');
    expect(job.if).toContain("needs.changes.outputs.platform == 'true'");
    expect(job.strategy.matrix.os).toEqual(['macos-latest', 'windows-latest']);
  });
});
