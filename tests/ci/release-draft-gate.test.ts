import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = join(import.meta.dirname, '../..');
const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'));
const workflow = YAML.parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'));

describe('release visibility gate', () => {
  it('creates a draft and a real tag before starting artifact builds', () => {
    expect(config.draft).toBe(true);
    expect(config['force-tag-creation']).toBe(true);
    expect(workflow.jobs['build-app-mac'].needs).toBe('release-please');
    expect(workflow.jobs['build-app-win'].needs).toBe('release-please');
  });

  it('publishes only after both app builds and asset verification', () => {
    const gate = workflow.jobs['verify-release-assets'];
    expect(gate.needs).toEqual(['release-please', 'build-app-mac', 'build-app-win']);
    const steps = gate.steps as Array<{ name?: string; run?: string }>;
    const verify = steps.findIndex(
      (step) => step.name === 'Assert every updater artifact is on the release',
    );
    const publish = steps.findIndex(
      (step) => step.name === 'Publish the verified release as stable',
    );
    expect(verify).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(verify);
    expect(steps[publish].run).toContain('draft=false');
    expect(steps[publish].run).toContain('prerelease=false');
    expect(workflow.jobs.publish.needs).toContain('verify-release-assets');
  });
});
