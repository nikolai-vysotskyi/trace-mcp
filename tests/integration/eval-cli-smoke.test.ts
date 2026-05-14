/**
 * Smoke test for `trace-mcp eval` CLI subcommand (P04).
 *
 * Drives the *built* CLI binary at dist/cli.js via spawnSync so we
 * catch regressions in:
 *   - command wiring (program.addCommand(evalCommand) in src/cli.ts)
 *   - `eval list` printing dataset slugs
 *   - `eval run --check-baseline` returning exit 0 on PASS, exit 1 on FAIL
 *
 * Auto-skip conditions:
 *   1. `dist/cli.js` does not exist — typical for pre-build CI steps.
 *   2. The repo is not registered in the trace-mcp project registry —
 *      `eval run` requires an indexed DB, and CI runners start fresh.
 *      `eval list` is still asserted because it does not need an index.
 *
 * Why not unit-test evalCommand directly: the regression we are guarding
 * against is precisely the wiring into the top-level Commander program.
 * Spawning the built binary is the only way to catch a forgotten
 * `program.addCommand` line.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CLI = join(REPO_ROOT, 'dist', 'cli.js');

const haveBuiltCli = existsSync(CLI);
const describeIfBuilt = haveBuiltCli ? describe : describe.skip;

/**
 * Probe whether the repo is registered + indexed by attempting a no-op
 * `eval run`. If the CLI prints "Project not indexed" or "No project
 * found" we skip the run-flavoured tests — they cannot pass in a CI
 * runner that has not been through `trace-mcp add`. The `list`
 * subcommand does not need the registry and is always asserted.
 */
function isProjectIndexed(): boolean {
  if (!haveBuiltCli) return false;
  const probe = spawnSync('node', [CLI, 'eval', 'run', '--dataset', 'default', '--output', 'md'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: process.env,
    timeout: 60_000,
  });
  const combined = (probe.stderr ?? '') + (probe.stdout ?? '');
  return !/Project not indexed|No project found/i.test(combined);
}

const projectIndexed = isProjectIndexed();
const itIfIndexed = projectIndexed ? it : it.skip;

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('node', [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ...extraEnv },
    timeout: 60_000,
  });
}

describeIfBuilt('eval CLI smoke (P04)', () => {
  it('`eval list` exits 0 and prints the bundled "default" dataset', () => {
    const r = runCli(['eval', 'list']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/^default/m);
  });

  itIfIndexed('`eval run --dataset default --output md` produces a Markdown rollup', () => {
    const r = runCli(['eval', 'run', '--dataset', 'default', '--output', 'md']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('## Rollup');
    expect(r.stdout).toContain('mrr');
  });

  itIfIndexed('`eval run --check-baseline` against the shipped baseline exits 0', () => {
    const r = runCli(['eval', 'run', '--dataset', 'default', '--check-baseline']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout + r.stderr).toContain('PASS');
  });

  itIfIndexed('`eval run --check-baseline` against a synthetic stricter baseline exits 1', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eval-cli-smoke-'));
    const badPath = join(tmp, 'bad-baseline.json');
    writeFileSync(
      badPath,
      JSON.stringify(
        {
          // Strict-but-impossible baseline: pre-recorded metrics that the
          // current runner cannot beat. Tolerance is intentionally tight.
          metrics: {
            precision_at_5_mean: 0.9,
            mrr: 0.99,
            first_hit_rank_mean: 0.5,
          },
          tolerance: {
            precision_at_5_mean: 0.02,
            mrr: 0.05,
            first_hit_rank_mean: 0.2,
          },
        },
        null,
        2,
      ),
    );

    const r = runCli([
      'eval',
      'run',
      '--dataset',
      'default',
      '--check-baseline',
      '--baseline-file',
      badPath,
    ]);
    expect(r.status, `expected non-zero exit on baseline regression; stdout: ${r.stdout}`).toBe(1);
    expect(r.stderr).toContain('FAIL');
  });
});
