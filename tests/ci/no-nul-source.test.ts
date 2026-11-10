import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');

describe('tracked source files contain no raw NUL bytes', () => {
  it('keeps Git diffs and code review readable', () => {
    const files = execFileSync('git', ['ls-files', '-z', '--', 'src'], { cwd: REPO })
      .toString('utf8')
      .split('\0')
      .filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file));
    expect(files.length).toBeGreaterThan(100);

    const offenders = files.filter((file) => readFileSync(path.join(REPO, file)).includes(0));
    expect(
      offenders,
      'Raw NUL bytes make Git treat source files as binary; use \\0 in literals.',
    ).toEqual([]);
  });
});
