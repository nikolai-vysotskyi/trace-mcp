/**
 * TRA-951: a running daemon must not impose its own preset on a session.
 *
 * The daemon registers one server per project and serves every session from
 * it, so a `tools.preset` in the daemon's config used to defer those tools for
 * everybody — a session started with `--preset full` got `Tool X disabled` per
 * call, with no signal at startup. `serveFullSurface` is the seam: daemon-side
 * servers register everything, and the preset is applied per session by the
 * proxy (guarded by daemon/router/__tests__/proxy-tool-preset.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../config.js';
import type { ServerHandle } from '../server.js';

let tmpHome: string;
let projectRoot: string;
const handles: ServerHandle[] = [];
const closers: Array<() => void> = [];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-tra951-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
  projectRoot = join(tmpHome, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'p' }));
});

afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  for (const c of closers.splice(0)) c();
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
});

/** A tool that exists in `full` but not in `minimal` — the surface at stake. */
const OUTSIDE_MINIMAL = 'get_tests_for';

async function build(deps: Record<string, unknown>): Promise<ServerHandle> {
  const { initializeDatabase } = await import('../../db/schema.js');
  const { Store } = await import('../../db/store.js');
  const { PluginRegistry } = await import('../../plugin-api/registry.js');
  const { ProgressState } = await import('../../progress.js');
  const { createServer } = await import('../server.js');

  const db = initializeDatabase(join(tmpHome, 'index.db'));
  closers.push(() => db.close());
  const config = { tools: { preset: 'minimal' } } as TraceMcpConfig;
  const handle = createServer(
    new Store(db),
    PluginRegistry.createWithDefaults(),
    config,
    projectRoot,
    new ProgressState(db),
    deps,
  );
  handles.push(handle);
  return handle;
}

describe('serveFullSurface (TRA-951)', () => {
  it('a narrow preset still defers tools on a session-owned server', async () => {
    const handle = await build({});
    expect(handle.toolHandlers.has(OUTSIDE_MINIMAL)).toBe(false);
  });

  it('registers the full surface on a daemon-side server despite tools.preset', async () => {
    const handle = await build({ serveFullSurface: true });
    expect(handle.toolHandlers.has(OUTSIDE_MINIMAL)).toBe(true);
  });

  it('ignores TRACE_MCP_PRESET too — the daemon inherits the env of whoever spawned it', async () => {
    vi.stubEnv('TRACE_MCP_PRESET', 'minimal');
    const handle = await build({ serveFullSurface: true });
    expect(handle.toolHandlers.has(OUTSIDE_MINIMAL)).toBe(true);
  });

  it('still honours tools.exclude, which is a hard restriction, not a preset', async () => {
    const { initializeDatabase } = await import('../../db/schema.js');
    const { Store } = await import('../../db/store.js');
    const { PluginRegistry } = await import('../../plugin-api/registry.js');
    const { ProgressState } = await import('../../progress.js');
    const { createServer } = await import('../server.js');
    const db = initializeDatabase(join(tmpHome, 'index.db'));
    closers.push(() => db.close());
    const handle = createServer(
      new Store(db),
      PluginRegistry.createWithDefaults(),
      { tools: { exclude: [OUTSIDE_MINIMAL] } } as TraceMcpConfig,
      projectRoot,
      new ProgressState(db),
      { serveFullSurface: true },
    );
    handles.push(handle);
    expect(handle.toolHandlers.has(OUTSIDE_MINIMAL)).toBe(false);
  });
});
