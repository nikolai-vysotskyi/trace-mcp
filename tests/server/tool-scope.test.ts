/**
 * Worktree scope of every tool (GH #1481, step 2): which tools a worktree
 * session with a branch index sends to the copy and which stay on the
 * session. Read by the gate at registration from tool-annotations.ts.
 */
import { describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { ProgressState } from '../../src/progress.js';
import { createServer } from '../../src/server/server.js';
import { getToolStateScope, INDEX_SCOPE } from '../../src/server/tool-annotations.js';
import { UNGATED_META_TOOLS } from '../../src/server/tool-filter.js';

/** Tools that keep project or session state: they must never move to a copy. */
const SESSION_STATE_TOOLS = [
  'add_decision',
  'call_project_tool',
  'get_session_journal',
  'get_session_snapshot',
  'list_pins',
  'list_projects',
  'pin',
  'query_decisions',
  'remember_decision',
  'trace_state_get',
  'trace_state_init',
  'trace_state_patch',
  'unpin',
];

describe('tool worktree scope', () => {
  it('defaults to the session for a tool nobody classified', () => {
    expect(getToolStateScope('some_tool_added_tomorrow')).toBe('session');
  });

  it('keeps project and session state on the session', () => {
    for (const name of SESSION_STATE_TOOLS) expect(getToolStateScope(name), name).toBe('session');
    for (const name of ['search', 'find_usages', 'get_change_impact', 'register_edit', 'reindex']) {
      expect(getToolStateScope(name), name).toBe('index');
    }
  });

  it('scopes only tools that exist', () => {
    const db = initializeDatabase(':memory:');
    const handle = createServer(
      new Store(db),
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({ tools: { preset: 'full' } }),
      '/project',
      new ProgressState(db),
      { serveFullSurface: true, skipUsagePing: true },
    );
    const registered = Object.keys(
      (handle.server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    ).filter((name) => !UNGATED_META_TOOLS.has(name));
    handle.dispose();
    db.close();
    expect(registered.length).toBeGreaterThan(100);
    // No stale or misspelt name: each one scopes a tool that exists.
    expect([...INDEX_SCOPE].filter((name) => !registered.includes(name))).toEqual([]);
    // Everything the session keeps is still registered, so the list above
    // is not silently skipping it.
    expect(SESSION_STATE_TOOLS.filter((name) => !registered.includes(name))).toEqual([]);
  });
});
