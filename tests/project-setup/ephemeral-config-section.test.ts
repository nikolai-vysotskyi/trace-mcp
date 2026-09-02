import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * TRA-702: TRA-396 kept one-shot agent-run checkouts out of registry.json, but
 * `setupProject` writes the per-project section into `.config.json` *before*
 * `registerProject` ever applies that check — a different file, on a path no
 * sweep reached. So every agent run still left a permanent section behind, and
 * `.config.json` reached 593 sections / 785 KB, reparsed on every server start.
 *
 * These pin the write-side half of the fix. The sweep that drains the existing
 * backlog is covered in src/__tests__/config-project-sweep.test.ts.
 */
describe('project-setup — per-project config section for ephemeral roots', () => {
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

  function makeRepo(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'proj', version: '0.0.0' }),
    );
    return dir;
  }

  // Resolved through global.js rather than hardcoded: the state dir is
  // ~/.trace or ~/.trace-mcp depending on TRA-611 rename state, and a wrong
  // guess here reads as an empty config, which would make these vacuous.
  async function configProjects(): Promise<Record<string, unknown>> {
    const { GLOBAL_CONFIG_PATH } = await import('../../src/global.js');
    expect(GLOBAL_CONFIG_PATH.startsWith(fakeHome)).toBe(true);
    if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return {};
    const { parse } = await import('jsonc-parser');
    return (
      (
        parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')) as {
          projects?: Record<string, unknown>;
        }
      )?.projects ?? {}
    );
  }

  test('writes no config section for a one-shot agent workdir', async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-eph-'));
    const workdir = makeRepo(
      path.join(container, 'multica_workspaces_acme', 'proj-1', 'tra-9-abc', 'workdir', 'repo'),
    );

    const { setupProject } = await import('../../src/project-setup.js');
    setupProject(workdir);

    expect(Object.keys(await configProjects())).not.toContain(workdir);
    fs.rmSync(container, { recursive: true, force: true });
  });

  test('still writes a config section for an ordinary project root', async () => {
    const repo = makeRepo(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-real-')), 'app'));

    const { setupProject } = await import('../../src/project-setup.js');
    setupProject(repo);

    expect(Object.keys(await configProjects())).toContain(repo);
  });
});
