/**
 * Regression coverage for #218 — an Ansible Molecule-style directory symlink
 * cycling back to an ancestor (`roles/<role>/molecule/<scenario>/roles/<role> ->
 * ../../../`) made fast-glob's default `followSymbolicLinks: true` recurse
 * until the OS raised ENAMETOOLONG. `collectFiles` uses `suppressErrors: true`
 * so it never crashed, but it DID follow the cycle first, collecting the same
 * real files under ever-longer duplicated paths before the error was swallowed
 * — a silent data-quality bug, not just a crash risk.
 *
 * These tests pin:
 *   - default (`follow_symlinks: false`): the cycle is not descended into, and
 *     no duplicated/cyclic path is returned.
 *   - opt-in (`follow_symlinks: true`) on a NON-cyclic symlinked directory:
 *     the escape hatch actually includes files behind the symlink.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { collectFiles } from '../file-collector.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'file-collector-symlinks-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('collectFiles — symlink containment (#218)', () => {
  it('resolves on a molecule-style symlink cycle and returns only the real files', async () => {
    // Ansible Molecule layout: roles/<role>/molecule/<scenario>/roles/<role> -> ../../../
    const roleDir = join(workDir, 'roles', 'docker');
    const scenarioRolesDir = join(roleDir, 'molecule', 'default', 'roles');
    mkdirSync(scenarioRolesDir, { recursive: true });
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'src', 'real.ts'), 'export const real = 1;\n');
    writeFileSync(join(roleDir, 'task.ts'), 'export const task = 1;\n');

    let symlinkOk = true;
    try {
      symlinkSync('../../../', join(scenarioRolesDir, 'docker'), 'dir');
    } catch {
      symlinkOk = false;
    }
    if (!symlinkOk) {
      // Windows CI without symlink privilege — skip rather than fail.
      return;
    }

    const config = TraceMcpConfigSchema.parse({ include: ['**/*.ts'], exclude: [] });

    const entries = await collectFiles({
      config,
      rootPath: workDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 10_000,
    });

    expect(entries).toEqual(expect.arrayContaining(['src/real.ts', 'roles/docker/task.ts']));
    // No path may traverse into (or through) the symlinked directory — that
    // would mean the cycle was followed, duplicating `roles/docker` under itself.
    for (const entry of entries) {
      expect(entry).not.toContain('molecule/default/roles/docker');
    }
    expect(entries.length).toBe(2);
  });

  it('opt-in follow_symlinks:true includes files behind a non-cyclic symlinked dir', async () => {
    const outsideDir = join(workDir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'shared.ts'), 'export const shared = 1;\n');

    const projectDir = join(workDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'real.ts'), 'export const real = 1;\n');

    let symlinkOk = true;
    try {
      symlinkSync(outsideDir, join(projectDir, 'linked'), 'dir');
    } catch {
      symlinkOk = false;
    }
    if (!symlinkOk) {
      return;
    }

    const defaultConfig = TraceMcpConfigSchema.parse({ include: ['**/*.ts'], exclude: [] });
    const defaultEntries = await collectFiles({
      config: defaultConfig,
      rootPath: projectDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 10_000,
    });
    expect(defaultEntries).toEqual(['real.ts']);

    const followConfig = TraceMcpConfigSchema.parse({
      include: ['**/*.ts'],
      exclude: [],
      follow_symlinks: true,
    });
    const followEntries = await collectFiles({
      config: followConfig,
      rootPath: projectDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 10_000,
    });
    expect(followEntries).toEqual(expect.arrayContaining(['real.ts', 'linked/shared.ts']));
  });
});
