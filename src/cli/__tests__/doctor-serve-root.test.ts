import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TRA-1087: a live opencode config runs `["trace-mcp", "serve"]` with no project
// root — the client picks the cwd and the user never learns which directory that
// was. `doctor` now answers that first.

describe('diagnoseServeRoot (TRA-1087)', () => {
  let tmpHome: string;
  let doctor: typeof import('../doctor.js');

  beforeEach(async () => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-serve-root-')));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.stubEnv('TRACE_MCP_REPO_ROOT', '');
    vi.resetModules();
    doctor = await import('../doctor.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('flags the filesystem root as dangerous', () => {
    const r = doctor.diagnoseServeRoot(path.parse(process.cwd()).root);
    expect(r.status).toBe('dangerous');
    expect(r.dangerReason).toBe('filesystem root');
  });

  it('reports an unregistered project dir as auto-registering', () => {
    const proj = path.join(tmpHome, 'proj');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'package.json'), '{}');
    const r = doctor.diagnoseServeRoot(proj);
    expect(r.status).toBe('will-register');
    expect(r.indexRoot).toBe(proj);
  });

  it('warns when the nearest project root sits above the cwd — serve indexes nothing', () => {
    const proj = path.join(tmpHome, 'proj2');
    const sub = path.join(proj, 'src');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(proj, 'package.json'), '{}');
    const r = doctor.diagnoseServeRoot(sub);
    expect(r.status).toBe('root-above-cwd');
    expect(r.detail).toContain('proj2');
  });

  // The override used to reach only serve's auto-register check, so serve kept
  // indexing the cwd while doctor reported the override. Both now go through
  // resolveServeRoots, so this pins the two together.
  it('reports the same root serve resolves when TRACE_MCP_REPO_ROOT is set', async () => {
    const proj = path.join(tmpHome, 'proj3');
    fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'package.json'), '{}');
    vi.stubEnv('TRACE_MCP_REPO_ROOT', proj);
    const { resolveServeRoots } = await import('../../project-root.js');

    const r = doctor.diagnoseServeRoot(path.join(proj, 'sub'));
    expect(r.indexRoot).toBe(proj);
    expect(r.envOverride).toBe(proj);
    expect(r.status).toBe('will-register');
    expect(r.indexRoot).toBe(resolveServeRoots(path.join(proj, 'sub')).indexRoot);
  });
});
