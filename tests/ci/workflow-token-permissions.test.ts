import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

// A workflow with no top-level `permissions:` runs on GitHub's default token,
// which is broader than anything here asks for (Scorecard TokenPermissions).
// `ga4-snapshot.yml` was the last one missing it (TRA-903) — and it was missing
// it for a *good* reason that turned out to be a false choice: its
// `contents: write` is scoped to the job on purpose, and a top-level `{}` keeps
// that scoping while still denying the default. Both goals hold at once, so
// there is no legitimate reason for a workflow here to omit the block.
const WORKFLOWS = join(import.meta.dirname, '../../.github/workflows');

describe('workflow token permissions', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  it('finds workflows to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s declares top-level permissions', (file) => {
    const doc = YAML.parse(readFileSync(join(WORKFLOWS, file), 'utf8'));
    expect(doc.permissions, `${file} has no top-level \`permissions:\``).toBeDefined();
  });
});
