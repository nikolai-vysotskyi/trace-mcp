/**
 * Pure builder for the daemon's `GET /api/projects` response.
 *
 * Split out of cli.ts so it can be unit-tested without spinning up an HTTP
 * server — same pattern as `daemon/health-payload.ts`.
 *
 * Contract (TRA-1996 — why this differs from `GET /health` on purpose):
 *   - `GET /health` reports *residency*: a registered-but-idle-unloaded
 *     project shows `status: "unloaded"` there so monitoring/autopilots see
 *     the daemon's real memory state.
 *   - `GET /api/projects` reports *index-readiness*: a registered entry was
 *     indexed at least once to get registered, so an idle-unloaded project
 *     keeps `status: "ready"` here as its last-known state. Reporting only
 *     the resident set (or `unloaded`) made the app's CTA read the daemon's
 *     memory pressure instead of the project's state: an already-indexed,
 *     merely-unloaded project showed "+ Index project" instead of "Reindex"
 *     (TRA-1052). Changing that value back to `unloaded` would regress the
 *     CTA, so `status` stays `ready` here by design.
 *   - Both surfaces now carry the same explicit `resident` flag so the two
 *     can be correlated root-by-root without guessing what `status` means:
 *     `resident: true` = in-memory with a live `ManagedProject.status`,
 *     `resident: false` = registered on disk but evicted from memory
 *     (idle-unload sweep or not yet reloaded after a restart); such an
 *     entry is lazily reloaded on next use via `resolveProjectForRest`.
 */

export interface ApiProjectsResident {
  root: string;
  status: string;
  error?: string;
}

export interface ApiProjectsRegistryEntry {
  root: string;
}

export interface ApiProjectsEntry {
  root: string;
  status: string;
  error?: string;
  /**
   * Whether the project is currently resident in daemon memory.
   * `false` means "registered on disk, last-known status shown" — pair with
   * `GET /health` (which reports the same root as `status: "unloaded"`)
   * instead of comparing `status` across the two endpoints.
   */
  resident: boolean;
}

/**
 * Build the `GET /api/projects` project list. Pure — no I/O.
 *
 * @param resident — in-memory projects (`projectManager.listProjects()`).
 * @param registered — every registered root (`listProjects()` from the registry).
 */
export function buildApiProjectsList(
  resident: ApiProjectsResident[],
  registered: ApiProjectsRegistryEntry[],
): ApiProjectsEntry[] {
  const residentByRoot = new Map(resident.map((p) => [p.root, p]));
  const projects: ApiProjectsEntry[] = registered.map((entry) => {
    const managed = residentByRoot.get(entry.root);
    return managed
      ? { root: managed.root, status: managed.status, error: managed.error, resident: true }
      : { root: entry.root, status: 'ready', resident: false };
  });
  // Resident projects the registry doesn't know about (read-mostly
  // subprojects served with `persist: false` — see addProject()) still
  // need to appear so their live status reaches the UI.
  for (const managed of residentByRoot.values()) {
    if (!projects.some((p) => p.root === managed.root)) {
      projects.push({
        root: managed.root,
        status: managed.status,
        error: managed.error,
        resident: true,
      });
    }
  }
  return projects;
}
