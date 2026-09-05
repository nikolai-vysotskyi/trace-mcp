/**
 * The build a measurement ran at — TRA-920.
 *
 * A benchmark number without a build is a number that cannot go stale in
 * public: six releases later a reader has no way to tell whether it still
 * describes the code they just installed. Every benchmark script that writes a
 * data file the site or the README quotes stamps its output with this, and
 * `tests/docs/savings-claims.test.ts` fails when a published figure lacks one.
 *
 * ponytail: package.json + `git rev-parse`, no build-info plumbing. `dirty` is
 * the honest caveat when the tree the measurement ran on was not a commit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type MeasuredBuild = {
  version: string;
  commit: string;
  dirty?: boolean;
  /** True when the build was reconstructed after the fact, not recorded by the run. */
  reconstructed?: boolean;
};

const REPO = fileURLToPath(new URL('..', import.meta.url));

const git = (args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf-8' }).trim();

export function measuredBuild(): MeasuredBuild {
  const version = (
    JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as {
      version: string;
    }
  ).version;
  const commit = git(['rev-parse', '--short=8', 'HEAD']);
  const dirty = git(['status', '--porcelain']).length > 0;
  return dirty ? { version, commit, dirty } : { version, commit };
}
