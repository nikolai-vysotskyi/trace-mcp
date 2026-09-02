import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

// The Apple Developer ID certificate is an environment secret, not a
// repository-level one, so it is only injected into a job that declares
// `environment: apple-signing` — and that environment only deploys from
// protected branches (TRA-628, SECURITY.md "CI Secret Scoping").
//
// The failure mode this guards is silent: drop the `environment:` line and the
// release still builds, signs and ships exactly as before, right up until the
// secrets are re-scoped or someone reads the workflow and concludes the
// certificate is repo-wide again. Nothing else in the suite notices.
const APPLE_SECRETS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];

const WORKFLOWS = join(import.meta.dirname, '../../.github/workflows');

function jobsOf(file: string): Record<string, any> {
  return YAML.parse(readFileSync(join(WORKFLOWS, file), 'utf8')).jobs ?? {};
}

/** Every `${{ secrets.NAME }}` reference anywhere inside a job definition. */
function secretsReferencedBy(job: unknown): Set<string> {
  const found = new Set<string>();
  for (const m of JSON.stringify(job).matchAll(/secrets\.([A-Z0-9_]+)/g)) found.add(m[1]);
  return found;
}

describe('release workflow secret scoping', () => {
  it('gates every job that touches an Apple signing secret behind the apple-signing environment', () => {
    const consumers = Object.entries(jobsOf('release.yml')).filter(([, job]) => {
      const used = secretsReferencedBy(job);
      return APPLE_SECRETS.some((s) => used.has(s));
    });

    // If nobody signs any more, this test is guarding nothing — say so loudly
    // rather than passing vacuously.
    expect(consumers.map(([name]) => name)).toEqual(['build-app-mac']);

    for (const [name, job] of consumers) {
      expect(job.environment, `job "${name}" consumes Apple signing secrets`).toBe('apple-signing');
    }
  });
});
