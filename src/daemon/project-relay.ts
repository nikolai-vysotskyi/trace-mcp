/**
 * Cross-project relay for `call_project_tool` (src/tools/register/projects.ts).
 *
 * Two implementations, one per runtime:
 *  - `createDaemonProjectRelay` — daemon/HTTP: reuses `ProjectManager` (a
 *    target project already warm in the daemon is served directly; a cold
 *    one is lazily opened via the same `addProject(root, { watch: false,
 *    persist: false })` read-mostly path already used for on-demand
 *    subprojects) and `ProjectResourcePool` (shared TopologyStore/
 *    DecisionStore — no second pool is created).
 *  - `createLightweightProjectRelay` — stdio (LocalBackend): there is no
 *    daemon/ProjectManager to reuse (LocalBackend manages exactly one
 *    project), so this opens the target project's ALREADY-INDEXED database
 *    directly — no indexAll(), no FileWatcher — and caches the resulting
 *    ServerHandle for the process's lifetime.
 *
 * Both cache opened handles by resolved root and expose `dispose()` for the
 * owning runtime to release everything on shutdown.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { ProgressState } from '../progress.js';
import { getProject, listProjects, resolveRegisteredAncestor } from '../registry.js';
import { createServer, type ServerHandle } from '../server/server.js';
import type { ProjectRelay } from '../server/types.js';
import type { ManagedProject, ProjectManager } from './project-manager.js';
import type { ProjectResourcePool } from './resource-pool.js';

/** Resolve a requested root to its exact registered entry — direct match, or
 *  a registered ancestor / multi-root parent, mirroring how registry.ts's
 *  other consumers (e.g. the daemon's project-request routing) resolve paths. */
function resolveRegisteredRoot(targetRoot: string): { root: string; dbPath: string } | null {
  const abs = path.resolve(targetRoot);
  const entry = getProject(abs) ?? resolveRegisteredAncestor(abs);
  return entry ? { root: entry.root, dbPath: entry.dbPath } : null;
}

/**
 * Daemon/HTTP relay. `projectManager`/`resourcePool` are the same instances
 * cli.ts's `serve-http` command already constructs and uses for every
 * per-session `createServer()` call (see `createSessionTransport`) — this
 * relay is additive wiring on top of that existing machinery, not a second
 * pool.
 */
export function createDaemonProjectRelay(
  projectManager: ProjectManager,
  resourcePool: ProjectResourcePool,
): ProjectRelay {
  /**
   * Cached handles paired with the exact ManagedProject instance they were
   * built on. The idle-unload sweep (project_idle_unload_minutes /
   * daemon_eager_load_projects) closes a project's DB out from under any
   * cached handle via stopProject() while the project stays registered, so
   * identity against `projectManager.getProject()` is the liveness check: a
   * cache entry whose instance is no longer managed is stale and must be
   * dropped + reopened, never served (TRA-1738).
   */
  const cache = new Map<string, { handle: ServerHandle; managed: ManagedProject; root: string }>();

  const dropEntry = (handle: ServerHandle): void => {
    for (const [key, entry] of cache) {
      if (entry.handle === handle) cache.delete(key);
    }
    try {
      handle.dispose();
    } catch {
      /* best-effort */
    }
  };

  return {
    listRelayTargets() {
      return listProjects().map((p) => p.root);
    },
    async openProject(targetRoot) {
      const abs = path.resolve(targetRoot);
      const direct = cache.get(abs);
      if (direct) {
        const live = projectManager.getProject(direct.root);
        if (live && live === direct.managed) {
          projectManager.touchActivity(direct.root);
          return direct.handle;
        }
        // Stale: the target was idle-unloaded (or removed) since we cached
        // the handle — drop it and fall through to resolve + reopen.
        dropEntry(direct.handle);
      }

      const resolved = resolveRegisteredRoot(abs);
      if (!resolved) return null;

      let managed = projectManager.getProject(resolved.root);
      if (!managed) {
        try {
          // Read-mostly: no watcher. `persist: false` is harmless here since
          // the project is already registered (setupProject() would just
          // re-write the same registry entry) — this mirrors the read-mostly
          // mode ProjectManager already uses for on-demand subprojects.
          managed = await projectManager.addProject(resolved.root, {
            watch: false,
            persist: false,
          });
        } catch {
          return null;
        }
      }

      const byRoot = cache.get(resolved.root);
      if (byRoot) {
        if (byRoot.managed === managed) {
          if (abs !== resolved.root) cache.set(abs, byRoot);
          projectManager.touchActivity(resolved.root);
          return byRoot.handle;
        }
        dropEntry(byRoot.handle);
      }

      // TRA-1738: deliberately getSharedDeps(), NOT acquire(). The relay's
      // cached handle is not a client session, but acquire() bumps the
      // per-project refcount that gates the idle-unload sweep — and nothing
      // ever released it until daemon shutdown, so every project ever touched
      // via call_project_tool was pinned resident forever (the field case:
      // 12 pinned + 0 evictable with RSS stuck at 5.1 GB). The shared
      // TopologyStore/DecisionStore/StateEngine are daemon-wide singletons
      // that never close per-project, so there is no lifecycle to refcount
      // here — getSharedDeps() returns the same instances without touching
      // the sweep's "connected clients" signal (see resource-pool.ts).
      const deps = resourcePool.getSharedDeps(managed.config);
      const handle = createServer(
        managed.store,
        managed.registry,
        managed.config,
        managed.root,
        managed.progress,
        // TRA-951: shared server, never a client session's own surface.
        { ...deps, serveFullSurface: true, skipUsagePing: true },
      );
      // A relay call is real use of the target: without this, a hot
      // call_project_tool target would look idle to the sweep (its
      // lastAccessedAt froze at load time) and churn through
      // unload → full lazy reload on every TTL window (TRA-1738 review).
      projectManager.touchActivity(resolved.root);
      const entry = { handle, managed, root: resolved.root };
      cache.set(resolved.root, entry);
      if (abs !== resolved.root) {
        cache.set(abs, entry);
      }
      return handle;
    },
    dispose() {
      const seen = new Set<ServerHandle>();
      for (const entry of cache.values()) {
        if (seen.has(entry.handle)) continue;
        seen.add(entry.handle);
        try {
          entry.handle.dispose();
        } catch {
          /* best-effort */
        }
      }
      cache.clear();
    },
  };
}

/**
 * Stdio/no-daemon relay. Opens each target project's already-indexed database
 * read-only-in-spirit (no indexAll(), no FileWatcher) and caches the result
 * for the caller's lifetime. Used by LocalBackend, which owns exactly one
 * project and has no ProjectManager/ResourcePool to reuse.
 */
export function createLightweightProjectRelay(): ProjectRelay {
  const cache = new Map<string, { handle: ServerHandle; db: Database.Database }>();

  return {
    listRelayTargets() {
      return listProjects().map((p) => p.root);
    },
    async openProject(targetRoot) {
      const abs = path.resolve(targetRoot);
      const cached = cache.get(abs);
      if (cached) return cached.handle;

      const resolved = resolveRegisteredRoot(abs);
      if (!resolved) return null;
      // Registered but never indexed — nothing to relay to. Never trigger an
      // index build here; this path is read-only access to an existing index.
      if (!fs.existsSync(resolved.dbPath)) return null;

      const configResult = await loadConfig(resolved.root);
      if (configResult.isErr()) return null;

      const db = initializeDatabase(resolved.dbPath);
      const store = new Store(db);
      const registry = PluginRegistry.createWithDefaults();
      const progress = new ProgressState(db);
      const handle = createServer(store, registry, configResult.value, resolved.root, progress, {
        // TRA-951: relay target — dispatch is by name, not through a preset,
        // and no client session sits behind it.
        serveFullSurface: true,
        skipUsagePing: true,
      });
      cache.set(abs, { handle, db });
      return handle;
    },
    dispose() {
      for (const { handle, db } of cache.values()) {
        try {
          handle.dispose();
        } catch {
          /* best-effort */
        }
        try {
          db.close();
        } catch {
          /* best-effort */
        }
      }
      cache.clear();
    },
  };
}
