/**
 * Regression coverage for #218 on the zero-index fallback walker
 * (`fallbackSearch` -> `manualSearch` -> `walk`, used when ripgrep is
 * unavailable). The old implementation used `readdirSync` + `statSync`
 * (follows symlinks) with no symlink gate, no visited set, and no depth cap,
 * so a directory symlink cycling back to an ancestor (Ansible Molecule's
 * `roles/<role> -> ../../../` layout) would spin unboundedly. Each call is
 * wrapped in try/catch so it never crashed, but it never terminated either.
 *
 * The fix switches to `readdirSync(dir, { withFileTypes: true })` with an
 * `entry.isDirectory()` gate (lstat semantics — does not follow directory
 * symlinks) plus a depth cap as a second layer of defense.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fallbackSearch } from '../zero-index.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const mockedExecFileSync = vi.mocked(execFileSync);

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zero-index-symlinks-'));
  // Force the ripgrep path to fail with ENOENT so fallbackSearch falls
  // through to the manual walk-based search (the code path under test).
  mockedExecFileSync.mockImplementation(() => {
    const err = new Error('rg not found') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
});

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  rmSync(workDir, { recursive: true, force: true });
});

describe('fallbackSearch manual walker — symlink containment (#218)', () => {
  it('terminates on a molecule-style symlink cycle and still finds real matches', () => {
    const roleDir = join(workDir, 'roles', 'docker');
    const scenarioRolesDir = join(roleDir, 'molecule', 'default', 'roles');
    mkdirSync(scenarioRolesDir, { recursive: true });
    writeFileSync(join(roleDir, 'task.ts'), 'const NEEDLE = 1;\n');

    let symlinkOk = true;
    try {
      symlinkSync('../../../', join(scenarioRolesDir, 'docker'), 'dir');
    } catch {
      symlinkOk = false;
    }
    if (!symlinkOk) {
      return;
    }

    const result = fallbackSearch(workDir, 'NEEDLE', {});

    expect(result.fallback).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.file).toBe(join('roles', 'docker', 'task.ts'));
  });
});
