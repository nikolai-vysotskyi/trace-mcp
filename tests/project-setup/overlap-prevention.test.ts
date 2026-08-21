import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * TRA-95: findOverlapForNewRoot() existed (with full test coverage) but was
 * never wired into setupProject — the single choke point every registration
 * path (CLI add, CLI init, daemon addProject, MCP auto-register) goes
 * through. Overlapping registrations kept silently forming because nothing
 * checked the registry before writing a new entry, and were only ever
 * noticed later via `doctor`.
 *
 * Registering a nested repo on its own is a *supported* pattern (the
 * ancestor's watcher/index excludes it — see #209 /
 * project-manager-ancestor-watcher.test.ts), so setupProject surfaces the
 * overlap (log warning + `overlapWarning` on the result) instead of
 * refusing to register.
 */
describe('project-setup — overlap detection at registration time', () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-setup-overlap-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  function makeRepo(root: string, name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
    return dir;
  }

  test('registers a nested root but flags the overlap with the already-registered ancestor', async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-setup-overlap-'));
    fs.writeFileSync(
      path.join(container, 'package.json'),
      JSON.stringify({ name: 'container', version: '0.0.0' }),
    );
    const nested = makeRepo(container, 'nested-app');

    const { setupProject } = await import('../../src/project-setup.js');
    setupProject(container);

    const result = setupProject(nested);
    expect(result.entry.root).toBe(nested);
    expect(result.overlapWarning?.relation).toBe('existing_contains_candidate');
    expect(result.overlapWarning?.existing.root).toBe(container);

    fs.rmSync(container, { recursive: true, force: true });
  });

  test('registers a container but flags the overlap with an already-registered descendant', async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-setup-overlap-'));
    fs.writeFileSync(
      path.join(container, 'package.json'),
      JSON.stringify({ name: 'container', version: '0.0.0' }),
    );
    const nested = makeRepo(container, 'nested-app');

    const { setupProject } = await import('../../src/project-setup.js');
    setupProject(nested);

    const result = setupProject(container);
    expect(result.overlapWarning?.relation).toBe('candidate_contains_existing');
    expect(result.overlapWarning?.existing.root).toBe(nested);

    fs.rmSync(container, { recursive: true, force: true });
  });

  test('does not flag a declared multi-root child', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-setup-overlap-'));
    fs.writeFileSync(
      path.join(parent, 'package.json'),
      JSON.stringify({ name: 'parent', version: '0.0.0' }),
    );
    const child = makeRepo(parent, 'svc-a');

    const { registerProject } = await import('../../src/registry.js');
    const { setupProject } = await import('../../src/project-setup.js');
    registerProject(parent, { type: 'multi-root', children: [child] });

    const result = setupProject(child);
    expect(result.overlapWarning).toBeUndefined();

    fs.rmSync(parent, { recursive: true, force: true });
  });

  test('does not flag disjoint roots', async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-setup-overlap-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-setup-overlap-b-'));
    fs.writeFileSync(path.join(a, 'package.json'), JSON.stringify({ name: 'a', version: '0.0.0' }));
    fs.writeFileSync(path.join(b, 'package.json'), JSON.stringify({ name: 'b', version: '0.0.0' }));

    const { setupProject } = await import('../../src/project-setup.js');
    setupProject(a);
    const result = setupProject(b);
    expect(result.overlapWarning).toBeUndefined();

    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });
});
