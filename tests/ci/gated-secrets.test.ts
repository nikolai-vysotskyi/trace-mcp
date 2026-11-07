import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import { auditProbes, gatedSecretsOf, PROBE_PREFIX } from '../../scripts/check-gated-secrets.mjs';

const WORKFLOW = `
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.NOT_GATED }}

  sign:
    runs-on: macos-latest
    environment: apple-signing
    steps:
      - name: sign
        env:
          CSC_LINK: \${{ secrets.CSC_LINK }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

describe('gatedSecretsOf', () => {
  it('binds a secret to the environment of the job that reads it', () => {
    expect(gatedSecretsOf(WORKFLOW)).toEqual(new Map([['CSC_LINK', 'apple-signing']]));
  });

  it('ignores secrets read by a job with no environment', () => {
    expect(gatedSecretsOf(WORKFLOW).has('NOT_GATED')).toBe(false);
  });

  it('ignores GITHUB_TOKEN, which is per-run and never environment-scoped', () => {
    expect(gatedSecretsOf(WORKFLOW).has('GITHUB_TOKEN')).toBe(false);
  });

  it('reads the `environment: { name: ... }` form', () => {
    const nested = `
jobs:
  sign:
    environment:
      name: apple-signing
      url: https://example.com
    steps:
      - run: echo \${{ secrets.CSC_LINK }}
`;
    expect(gatedSecretsOf(nested)).toEqual(new Map([['CSC_LINK', 'apple-signing']]));
  });

  // Reviewer B on PR #930: all three are ways the scanner could have missed or
  // invented a gate. GitHub matches secret names case-insensitively and accepts
  // bracket notation, so both forms name the same secret as `APPLE_ID`.
  it('catches lowercase and bracket-notation references', () => {
    const odd = `
jobs:
  sign:
    environment: apple-signing
    steps:
      - run: echo \${{ secrets.apple_id }} \${{ secrets['CSC_LINK'] }}
`;
    expect([...gatedSecretsOf(odd).keys()].sort()).toEqual(['APPLE_ID', 'CSC_LINK']);
  });

  it('does not gate a secret that only appears in a comment', () => {
    const commented = `
jobs:
  sign:
    environment: apple-signing
    steps:
      # We removed \${{ secrets.OLD_UNUSED_KEY }}
      - run: echo \${{ secrets.CSC_LINK }}
`;
    expect([...gatedSecretsOf(commented).keys()]).toEqual(['CSC_LINK']);
  });

  it('does not read a `name:` outside the environment block as an environment', () => {
    const outputs = `
jobs:
  build:
    outputs:
      name: artifact-name
    steps:
      - run: echo \${{ secrets.REPO_SECRET }}
`;
    expect(gatedSecretsOf(outputs).size).toBe(0);
  });

  it('finds the real apple-signing secrets in release.yml', () => {
    const gated = gatedSecretsOf(readFileSync('.github/workflows/release.yml', 'utf8'));
    expect(
      [...gated]
        .filter(([, env]) => env === 'apple-signing')
        .map(([n]) => n)
        .sort(),
    ).toEqual([
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_ID',
      'APPLE_TEAM_ID',
      'CSC_KEY_PASSWORD',
      'CSC_LINK',
    ]);
  });
});

describe('auditProbes', () => {
  const gated = new Map([['CSC_LINK', 'apple-signing']]);

  it('passes when the environment-less job cannot see the secret', () => {
    expect(auditProbes(gated, { [`${PROBE_PREFIX}CSC_LINK`]: 'false' })).toEqual([]);
  });

  // TRA-901: this is the state the repo was actually in for four days while
  // release.yml said the certificate had been moved.
  it('fails when the secret is still readable without the environment', () => {
    const [problem] = auditProbes(gated, { [`${PROBE_PREFIX}CSC_LINK`]: 'true' });
    expect(problem).toMatch(/still a repository-level secret/);
  });

  it('fails when ci.yml stopped probing a gated secret', () => {
    const [problem] = auditProbes(gated, {});
    expect(problem).toMatch(/does not probe it/);
  });
});
