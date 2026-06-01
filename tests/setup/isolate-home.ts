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
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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
