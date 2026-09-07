import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #936 / TRA-1101: the notice that tells a user the daemon registered a root
// on its own rests entirely on `explicit` separating the two registration
// classes. `ProjectManager.addProject` calls `setupProject(root)` with no
// opts — that is the auto-registration path; `add`/`init` pass explicit.

describe('registration class: auto vs deliberate (#936)', () => {
  let tmpHome: string;
  let projectDir: string;
  let registry: typeof import('../registry.js');
  let projectSetup: typeof import('../project-setup.js');

  beforeEach(async () => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-regclass-')));
    projectDir = path.join(tmpHome, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"proj"}');
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    registry = await import('../registry.js');
    projectSetup = await import('../project-setup.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('the addProject path leaves the entry unclaimed', () => {
    projectSetup.setupProject(projectDir);
    expect(registry.getProject(projectDir)?.explicit).toBeFalsy();
  });

  it('`add`/`init` claim the entry', () => {
    projectSetup.setupProject(projectDir, { explicit: true });
    expect(registry.getProject(projectDir)?.explicit).toBe(true);
  });

  it('a later `add` promotes a root the daemon had auto-registered', () => {
    projectSetup.setupProject(projectDir);
    expect(registry.getProject(projectDir)?.explicit).toBeFalsy();

    projectSetup.setupProject(projectDir, { explicit: true });
    expect(registry.getProject(projectDir)?.explicit).toBe(true);
  });
});
