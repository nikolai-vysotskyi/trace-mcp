import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * TRA-702 regression guard.
 *
 * `.config.json` grew to 593 project sections because `setupProject` writes one
 * per root and nothing collected them. The tempting fix — skip the write for
 * one-shot agent workdirs, mirroring what `registerProject` does — is wrong:
 * both stdio startup and the daemon's project loader call `setupProject()` and
 * then immediately `loadConfig(root)`, reading back exactly that section. Skip
 * it and the run silently falls back to schema defaults, losing the detected
 * framework include/exclude set. For a preset like n8n's `**\/*.json` that
 * means not indexing the files the integration exists for.
 *
 * So the section is written for every root, and `pruneProjectConfigSections`
 * (on softGcSweep's hourly timer) collects the ephemeral ones afterwards. This
 * pins the half that is easy to "optimise" back into a bug.
 */
describe('project-setup — config fidelity for ephemeral roots (TRA-702)', () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-setup-ephemeral-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    // HOME alone does not redirect the state dir (os.homedir() ignores it on
    // macOS), and a leaked write would land in the developer's real config.
    vi.stubEnv('TRACE_MCP_DATA_DIR', fakeHome);
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  function makeExpressRepo(dir: string): string {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'proj', version: '0.0.0', dependencies: { express: '^4.18.0' } }),
    );
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'require("express")();\n');
    return dir;
  }

  test('an ephemeral workdir still loads the config its detection generated', async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-eph-'));
    const workdir = makeExpressRepo(
      path.join(container, 'multica_workspaces_acme', 'proj-1', 'tra-9-abc', 'workdir', 'repo'),
    );

    const { setupProject } = await import('../../src/project-setup.js');
    const { loadConfig } = await import('../../src/config.js');
    const { generateConfig } = await import('../../src/init/config-generator.js');

    const setup = setupProject(workdir);
    const generated = generateConfig(setup.detection);
    const loaded = await loadConfig(workdir);

    // The effective config the run indexes with must be the detected one, not
    // the broad schema defaults. This is the assertion that fails if the
    // per-project write is ever skipped for ephemeral roots again.
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      // `include` is the framework-specific half and is loaded verbatim; it is
      // what silently narrows to the schema default if the write is skipped.
      // `exclude` is deliberately not compared — the loader normalises it by
      // prefixing `**/`, so it is never equal to the generated form.
      expect(loaded.value.include).toEqual(generated.include);

      // Guard against the assertion above passing vacuously: the detected set
      // must actually differ from what a root with no section falls back to,
      // otherwise "loaded == generated" would hold even with the write skipped.
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bare-'));
      const fallback = await loadConfig(bare);
      expect(fallback.isOk()).toBe(true);
      if (fallback.isOk()) expect(loaded.value.include).not.toEqual(fallback.value.include);
      fs.rmSync(bare, { recursive: true, force: true });
    }

    fs.rmSync(container, { recursive: true, force: true });
  });
});
