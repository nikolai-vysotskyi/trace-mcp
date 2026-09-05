#!/usr/bin/env node
// Fails when a secret a workflow job gates behind `environment: X` is also
// readable without that environment.
//
// TRA-628 created the `apple-signing` environment, pointed the signing job at
// it, and left a comment in release.yml saying the Developer ID certificate now
// lives there. The secrets were never moved: the environment held zero of them
// and all five stayed repository-level, readable by any workflow on any branch
// that names them. That comment is what stopped the next reviewer from looking
// for four days (TRA-901) — so the claim gets a check instead of a comment.
//
// The check needs no token and reads no secret value. GitHub only exposes an
// environment secret to a job that declares that environment, so a job that
// declares none must see an empty string for every gated name. ci.yml probes
// each name with `${{ secrets.NAME != '' }}` from an environment-less job and
// passes the booleans in; this script derives the gated set from the workflow
// files and asserts the probe covers it and comes back false.
//
// Fork PRs get no secrets at all, so every probe reads false there — the check
// can only pass spuriously on a fork, never fail spuriously. Master pushes and
// in-repo PRs are where it has teeth, which is where the exposure is.
//
// The workflow scan is a line scanner rather than a YAML parse so the CI job
// can run on a bare runner with no install: pulling in `yaml` would cost a
// ~90s pnpm install to read five lines. ponytail: our own workflow files, our
// own 2-space indentation; if that ever stops holding, the scan finds no gated
// job and fails loudly rather than passing empty.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const PROBE_PREFIX = 'VISIBLE_';

// Always non-empty and scoped to the run, not to an environment.
const NOT_A_GATED_SECRET = new Set(['GITHUB_TOKEN']);

/**
 * Secrets referenced from jobs that declare an `environment:`.
 *
 * @param {string} yamlSource one workflow file
 * @returns {Map<string, string>} secret name → environment claiming it
 */
export function gatedSecretsOf(yamlSource) {
  const found = new Map();
  /** @type {{env: string | null, names: Set<string>} | null} */
  let job = null;
  const flush = () => {
    if (job?.env) for (const n of job.names) found.set(n, job.env);
    job = null;
  };
  for (const line of yamlSource.split('\n')) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*(#.*)?$/.test(line)) {
      flush();
      job = { env: null, names: new Set() };
      continue;
    }
    if (!/^ {2,}\S/.test(line)) {
      // Back at column 0 — out of `jobs:` entirely.
      if (line.trim() !== '' && !line.startsWith('#')) flush();
      continue;
    }
    if (!job) continue;
    // `environment: name`, or `environment:` followed by an indented `name:`.
    const inline = line.match(/^ {4}environment:\s*(?!$)['"]?([A-Za-z0-9_.-]+)/);
    const nested = line.match(/^ {6}name:\s*['"]?([A-Za-z0-9_.-]+)/);
    if (inline) job.env = inline[1];
    else if (nested) job.env ??= nested[1];
    for (const [, name] of line.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      if (!NOT_A_GATED_SECRET.has(name)) job.names.add(name);
    }
  }
  flush();
  return found;
}

/**
 * @param {Map<string, string>} gated secret name → environment
 * @param {Record<string, string | undefined>} probes ci.yml's `VISIBLE_*` booleans
 * @returns {string[]} one line per problem, empty when the gate holds
 */
export function auditProbes(gated, probes) {
  const problems = [];
  for (const [name, env] of gated) {
    const probe = probes[PROBE_PREFIX + name];
    if (probe === undefined) {
      problems.push(
        `${name}: gated behind \`environment: ${env}\` but ci.yml does not probe it — add "${PROBE_PREFIX}${name}: \${{ secrets.${name} != '' }}" to the gated-secrets job`,
      );
    } else if (probe !== 'false') {
      problems.push(
        `${name}: release.yml claims this lives in environment \`${env}\`, but a job with no environment can read it — it is still a repository-level secret, readable by any workflow on any branch. Add it to the environment and delete the repository-level copy.`,
      );
    }
  }
  return problems;
}

function main() {
  const dir = '.github/workflows';
  const gated = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    for (const [name, env] of gatedSecretsOf(readFileSync(join(dir, file), 'utf8')))
      gated.set(name, env);
  }
  if (gated.size === 0) {
    console.error(
      '::error::no job declares `environment:` with a secret — either the gate was removed or this scan stopped matching the workflow files',
    );
    process.exit(1);
  }
  const probes = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith(PROBE_PREFIX)),
  );
  const problems = auditProbes(gated, probes);
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log(
    `gated secrets unreadable without their environment: ${[...gated.keys()].sort().join(', ')}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
