import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #168: a deleted project folder (a stale registry.json row) surfaced as
// "Project not found" at runtime, and a corrupt registry.json was silently
// treated as empty. These tests pin the registry resilience + cleanup the
// `doctor`/`prune` commands rely on, using an isolated TRACE_MCP_DATA_DIR so no
// real ~/.trace-mcp state is touched.

describe('registry health (#168)', () => {
  let tmpHome: string;
  let registry: typeof import('../registry.js');
  let REGISTRY_PATH: string;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-registry-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    registry = await import('../registry.js');
    ({ REGISTRY_PATH } = await import('../global.js'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function makeProjectDir(name: string): string {
    const dir = path.join(tmpHome, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  describe('inspectRegistry', () => {
    it('reports a missing registry as empty (not corrupt)', () => {
      const r = registry.inspectRegistry();
      expect(r.exists).toBe(false);
      expect(r.corrupt).toBe(false);
      expect(r.entries).toEqual([]);
    });

    it('flags an unparseable registry.json as corrupt', () => {
      fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
      fs.writeFileSync(REGISTRY_PATH, '{ this is not valid json', 'utf-8');

      const r = registry.inspectRegistry();
      expect(r.exists).toBe(true);
      expect(r.corrupt).toBe(true);
      expect(r.entries).toEqual([]);
      // The lossy loader must not crash on corrupt input — it degrades to empty.
      expect(() => registry.listProjects()).not.toThrow();
      expect(registry.listProjects()).toEqual([]);
    });

    it('returns parsed entries for a valid registry', () => {
      const a = makeProjectDir('alpha');
      registry.registerProject(a);

      const r = registry.inspectRegistry();
      expect(r.exists).toBe(true);
      expect(r.corrupt).toBe(false);
      expect(r.entries.map((e) => e.root)).toContain(a);
    });
  });

  describe('pruneStaleProjects', () => {
    // The #168 acceptance scenario: register 3 projects, delete one folder,
    // prune removes only the dead one and leaves the two live projects intact.
    it('removes only entries whose root folder no longer exists', () => {
      const a = makeProjectDir('alpha');
      const b = makeProjectDir('beta');
      const gone = makeProjectDir('gamma');
      registry.registerProject(a);
      registry.registerProject(b);
      registry.registerProject(gone);

      // Physically delete one project folder.
      fs.rmSync(gone, { recursive: true, force: true });

      const removed = registry.pruneStaleProjects();
      expect(removed).toEqual([gone]);

      const remaining = registry
        .listProjects()
        .map((e) => e.root)
        .sort();
      expect(remaining).toEqual([a, b].sort());
    });

    it('is a no-op when every registered folder still exists', () => {
      const a = makeProjectDir('alpha');
      registry.registerProject(a);

      expect(registry.pruneStaleProjects()).toEqual([]);
      expect(registry.listProjects()).toHaveLength(1);
    });
  });
});
