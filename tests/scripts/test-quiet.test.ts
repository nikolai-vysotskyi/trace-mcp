import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const scriptPath = join(__dirname, '../../scripts/test-quiet.mjs');

describe('test-quiet script', () => {
  it('outputs a single line summary on passing test run', async () => {
    const { stdout, stderr } = await execFileAsync('node', [
      scriptPath,
      'tests/tools/behavioural/get-artifacts.behavioural.test.ts',
    ]);
    expect(stdout).toMatch(/✓ Test Files.*passed.*Tests.*passed.*Duration/);
    expect(stdout.trim().split('\n').length).toBe(1);
    expect(stderr).toBe('');
  });
});
