/**
 * Vitest setupFile — isolates the trace-mcp global home for the whole test run.
 *
 * trace-mcp resolves TRACE_MCP_HOME (and TOPOLOGY_DB_PATH / DECISIONS_DB_PATH /
 * REGISTRY_PATH / telemetry / savings) from ~/.trace-mcp at *import time*,
 * honoring the TRACE_MCP_DATA_DIR env override (see src/global.ts). Without this
 * setup, the suite reads AND writes the developer's real ~/.trace-mcp:
 *
 *   - daemon/subproject tests that call ProjectManager.addProject() trigger
 *     runSubprojectAutoSync() → TopologyStore(TOPOLOGY_DB_PATH), which registers
 *     the test's throwaway temp dir as a subproject in the user's real
 *     topology.db (observed in the wild: 100+ orphan `daemon-task-cache-*` rows).
 *   - decision/registry tests similarly mutate real global state.
 *
 * Fix: point TRACE_MCP_DATA_DIR at a per-worker temp dir BEFORE any project
 * module is imported, and clean it up on process exit. setupFiles run before the
 * test file's own imports, so the module-level const in global.ts picks up the
 * override. This file imports only node builtins, so nothing pulls in global.ts
 * before the env is set.
 *
 * Idempotent per worker: the first test file in a worker creates the dir; later
 * files in the same worker reuse the already-set env value.
 *
 * Escape hatch: if TRACE_MCP_DATA_DIR is already set (e.g. CI deliberately
 * targets a specific home) we leave it untouched. We also stash the real home in
 * TRACE_MCP_REAL_DATA_DIR so the rare test that must target the developer's
 * actual index (eval-cli-smoke validates the built CLI against the self-index)
 * can opt back in for a spawned subprocess.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Step the temp root out of a one-shot agent-run scratch directory (TRA-992).
 *
 * The Multica runtime exports TMPDIR as its own `multica-task-<run-id>`
 * directory, and `isEphemeralProjectRoot` classifies anything under such a path
 * as a throwaway checkout that is never persisted to registry.json. That is
 * correct in production and wrong for the suite: ~200 tests build their
 * "ordinary persistent project" fixture with `mkdtempSync(join(tmpdir(), ...))`,
 * so on that one runtime every one of them silently became an ephemeral root —
 * 36 failures across 14 files that pass everywhere else. Retargeting TMPDIR once
 * here fixes all of them, and keeps future fixtures from inheriting the trap. A
 * test that wants the ephemeral shape still builds the path explicitly.
 *
 * `os.tmpdir()` re-reads TMPDIR on every call on POSIX, so this must run before
 * any test module calls it — which is what a setupFile guarantees.
 */
function escapeTaskScopedTmpdir(): void {
  let dir = tmpdir();
  let changed = false;
  while (/^multica-task-\d+$/i.test(basename(dir))) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    changed = true;
  }
  if (changed) {
    // Resolve symlinks: on macOS the walk lands on `/tmp`, which is a symlink
    // to `/private/tmp`. `find "$TMPDIR" -maxdepth 1` in hooks/*.sh does not
    // descend a symlink argument, so an unresolved value silently disables the
    // hooks' own GC — and the test that asserts it.
    dir = realpathSync(dir);
    process.env.TMPDIR = dir;
    // Windows and some libs read these instead; keep them in step.
    if (process.env.TEMP) process.env.TEMP = dir;
    if (process.env.TMP) process.env.TMP = dir;
  }
}

escapeTaskScopedTmpdir();

if (!process.env.TRACE_MCP_DATA_DIR) {
  // Preserve a pointer to the real home before we redirect it. When the override
  // is unset the real home is the package default (~/.trace-mcp).
  if (!process.env.TRACE_MCP_REAL_DATA_DIR) {
    process.env.TRACE_MCP_REAL_DATA_DIR = join(homedir(), '.trace-mcp');
  }

  const isolated = mkdtempSync(join(tmpdir(), 'trace-mcp-test-home-'));
  process.env.TRACE_MCP_DATA_DIR = isolated;

  process.on('exit', () => {
    try {
      rmSync(isolated, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup; the OS reaps tmpdir eventually */
    }
  });
}
