import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TRA-341: the guard's coach grace period used to be armed only by the desktop
 * app, so a project you never opened there landed straight in strict. It is now
 * armed at registration.
 */
describe('guard initialization at registration (TRA-341)', () => {
  let tmpHome: string;
  let tmpProjects: string;
  let registry: typeof import('../registry.js');
  let guardInit: typeof import('../guard-init.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-guard-home-'));
    tmpProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-guard-projects-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    registry = await import('../registry.js');
    guardInit = await import('../guard-init.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProjects, { recursive: true, force: true });
  });

  function makeProject(name: string): string {
    const root = path.join(tmpProjects, name);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  const readMode = (root: string) =>
    fs.readFileSync(guardInit.guardModeFile(root), 'utf8').trim();

  it('arms coach for a freshly registered project', () => {
    const root = makeProject('fresh');
    registry.registerProject(root);

    expect(readMode(root)).toBe('coach');
    const installedAt = Number(
      fs.readFileSync(guardInit.guardInstallDateFile(root), 'utf8').trim(),
    );
    expect(installedAt).toBeGreaterThan(0);
    expect(Math.abs(installedAt - Math.floor(Date.now() / 1000))).toBeLessThan(60);
  });

  it('does not touch a project that already has a mode set', () => {
    const root = makeProject('already-strict');
    fs.mkdirSync(path.dirname(guardInit.guardModeFile(root)), { recursive: true });
    fs.writeFileSync(guardInit.guardModeFile(root), 'strict\n');

    registry.registerProject(root);

    expect(readMode(root)).toBe('strict');
    // No grace period is armed for a project that already made a choice.
    expect(fs.existsSync(guardInit.guardInstallDateFile(root))).toBe(false);
  });

  it('does not re-arm coach after the user switches to strict', () => {
    const root = makeProject('re-register');
    registry.registerProject(root);
    // User (or the 7-day promotion) moves the project to strict.
    fs.writeFileSync(guardInit.guardModeFile(root), 'strict\n');
    fs.rmSync(guardInit.guardInstallDateFile(root));

    registry.registerProject(root);

    expect(readMode(root)).toBe('strict');
    expect(fs.existsSync(guardInit.guardInstallDateFile(root))).toBe(false);
  });

  // chmod 0500 does not stop root, and means nothing on Windows.
  const cannotBlockWrites = process.platform === 'win32' || process.getuid?.() === 0;
  it.skipIf(cannotBlockWrites)('never fails registration when the project root is not writable', () => {
    const root = makeProject('read-only');
    fs.chmodSync(root, 0o500);
    try {
      expect(() => registry.registerProject(root)).not.toThrow();
      expect(fs.existsSync(guardInit.guardModeFile(root))).toBe(false);
    } finally {
      fs.chmodSync(root, 0o700);
    }
  });
});
