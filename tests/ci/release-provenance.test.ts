import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

// TRA-902. The desktop artifacts have carried `actions/attest-build-provenance`
// since #108, but the sigstore bundle stayed inside GitHub's attestation API:
// verification needed that service to be reachable, OpenSSF Scorecard's
// Signed-Releases check (which reads release assets and nothing else) scored 0,
// and a mirror had no way to check anything at all.
//
// Uploading the bundle fixes all three, and it fails silently if it regresses —
// the release still builds and ships, only unverifiable. So assert the shape:
// a job that attests must also put its bundle on the release.
const jobs: Record<string, any> = YAML.parse(
  readFileSync(join(import.meta.dirname, '../../.github/workflows/release.yml'), 'utf8'),
).jobs;

const attestingJobs = Object.entries(jobs).filter(([, job]) =>
  (job.steps ?? []).some((s: any) => String(s.uses ?? '').includes('attest-build-provenance')),
);

describe('release provenance', () => {
  it('attests the desktop artifacts on both platforms', () => {
    expect(attestingJobs.map(([name]) => name).sort()).toEqual(['build-app-mac', 'build-app-win']);
  });

  it.each(attestingJobs)('%s uploads its provenance bundle as a release asset', (_name, job) => {
    const steps = JSON.stringify(job.steps);
    expect(steps).toContain('outputs.bundle-path');
    // Scorecard only counts an asset whose name ends in `.intoto.jsonl`.
    expect(steps.match(/[\w.-]+\.intoto\.jsonl/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('attaches an SPDX SBOM to the release', () => {
    const steps = JSON.stringify(jobs.sbom?.steps ?? []);
    expect(steps).toContain('dependency-graph/sbom');
    expect(steps).toContain('.spdx.json');
  });
});
