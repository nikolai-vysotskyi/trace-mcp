import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * TRA-706: the ceiling under `.config.json` / `registry.json`, exercised through
 * the real registration path rather than a hand-written registry.
 *
 * The first draft capped only the *unregistered* config sections, which cannot
 * bound the scenario it was written for: `serve` auto-registers whatever
 * directory it was started in, and `registerProject` persists every root that
 * does not match the known one-shot workdir layout. So 101 live scratch
 * checkouts under an unrecognised layout are all claimed by `registry.json`,
 * and a cap that exempts claimed roots evicts none of them.
 *
 * The class that has to be capped is therefore "registered, but nobody asked
 * for it": auto-registration by `serve`, as opposed to a named `trace add` /
 * `trace init`. This pins that distinction end to end — it is what stops the
 * fallback ceiling from resting on the same path heuristic it backstops.
 */
describe('implicit project cap (TRA-706)', () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let container: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-implicit-cap-home-'));
    container = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-implicit-cap-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    // HOME alone does not redirect the state dir (os.homedir() ignores it on
    // macOS), and a leaked write would land in the developer's real registry.
    vi.stubEnv('TRACE_MCP_DATA_DIR', fakeHome);
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(container, { recursive: true, force: true });
  });

  /** A plain source directory — live on disk, and nothing about its path says "scratch". */
  function makeRepo(name: string): string {
    const dir = path.join(container, name);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'module.exports = 1;\n');
    return dir;
  }

  test('evicts the least recently used auto-registered project, never a named one', async () => {
    const { setupProject } = await import('../../src/project-setup.js');
    const { listProjects, sweepImplicitProjects } = await import('../../src/registry.js');
    const { pruneProjectConfigSections } = await import('../../src/config-jsonc.js');

    // What `trace add` does. This one must survive the cap however old it is.
    const named = makeRepo('named-by-the-user');
    setupProject(named, { explicit: true });

    // What `serve` does on its own for every directory it is started in. None
    // of these is workdir-shaped and all of them still exist on disk, so the
    // TRA-702 rules cannot see them.
    const scratch = ['scratch-a', 'scratch-b', 'scratch-c', 'scratch-d'].map((n) =>
      setupProject(makeRepo(n)),
    );
    const roots = scratch.map((s) => s.entry.root);

    expect(
      listProjects()
        .map((p) => p.root)
        .sort(),
    ).toEqual([named, ...roots].sort());

    // `scratch-a` is the least recently used: nothing has indexed any of them,
    // so the tiebreak is registration order.
    expect(sweepImplicitProjects(3)).toEqual([roots[0]]);
    const left = listProjects().map((p) => p.root);
    expect(left).toContain(named);
    expect(left).not.toContain(roots[0]);
    expect(left).toHaveLength(4);

    // Deregistering is what makes the section collectable: the root is live and
    // not workdir-shaped, so only the section cap reaches it.
    expect(pruneProjectConfigSections(0)).toEqual([roots[0]]);
    // jsonc, not JSON — the file is documented as comment-bearing.
    const { parse } = await import('jsonc-parser');
    const sections = Object.keys(
      (
        parse(fs.readFileSync(path.join(fakeHome, '.config.json'), 'utf-8')) as {
          projects: Record<string, unknown>;
        }
      ).projects,
    );
    expect(sections).toContain(named);
    expect(sections).not.toContain(roots[0]);
  });

  test('a later `trace add` promotes an already auto-registered project out of the cap', async () => {
    const { setupProject } = await import('../../src/project-setup.js');
    const { getProject, sweepImplicitProjects } = await import('../../src/registry.js');

    const root = makeRepo('opened-first-added-later');
    setupProject(root); // serve saw it first
    expect(getProject(root)?.explicit).toBeUndefined();

    setupProject(root, { explicit: true }); // then the user ran `trace add`
    expect(getProject(root)?.explicit).toBe(true);
    expect(sweepImplicitProjects(0)).toEqual([]);
    expect(getProject(root)).not.toBeNull();
  });
});
