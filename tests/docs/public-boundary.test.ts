import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('keeps internal project records out of the public repository', () => {
  const root = join(import.meta.dirname, '..', '..');
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString()
    .split('\0')
    .filter(Boolean);

  const internal = tracked.filter(
    (path) =>
      (path.startsWith('ops/') && !path.startsWith('ops/telemetry/')) ||
      path.startsWith('plans/') ||
      [
        'docs/ROADMAP.md',
        'docs/DESIGN-WEB.md',
        'scripts/mention-sweep.sh',
        'scripts/geo-battery.mjs',
        '.github/workflows/geo-battery.yml',
      ].includes(path),
  );

  expect(internal).toEqual([]);
});
