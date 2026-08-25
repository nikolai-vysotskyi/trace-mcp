/**
 * TRA-93 (Option B): cross-project relay used by `call_project_tool`.
 *
 * Covers:
 *  (a) successful relay — createLightweightProjectRelay().openProject() on a
 *      registered, already-indexed project returns a handler map whose
 *      `get_index_health` response matches calling the SAME project's own
 *      directly-constructed server.
 *  (d) stdio lazy-load path — opening a second already-indexed project's
 *      read-only handle with no daemon/ProjectManager involved, and without
 *      ever writing to a fresh DB file (registered-but-never-indexed roots
 *      are rejected instead of silently creating an empty index).
 *  Plus: unknown project (not registered) and registered-but-unindexed
 *  return null instead of throwing or fabricating state.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;
let projectA: string;
let projectB: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-relay-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
  projectA = join(tmpHome, 'project-a');
  projectB = join(tmpHome, 'project-b');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFileSync(join(projectA, 'package.json'), JSON.stringify({ name: 'a' }));
  writeFileSync(join(projectB, 'package.json'), JSON.stringify({ name: 'b' }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('createLightweightProjectRelay (stdio path, TRA-93)', () => {
  it('returns null for a root that was never registered', async () => {
    const { createLightweightProjectRelay } = await import('../project-relay.js');
    const relay = createLightweightProjectRelay();
    const opened = await relay.openProject(join(tmpHome, 'never-registered'));
    expect(opened).toBeNull();
    relay.dispose();
  });

  it('returns null for a root that is registered but never indexed (no DB file yet)', async () => {
    const { registerProject } = await import('../../registry.js');
    const { createLightweightProjectRelay } = await import('../project-relay.js');
    registerProject(projectB);

    const relay = createLightweightProjectRelay();
    const opened = await relay.openProject(projectB);
    expect(opened).toBeNull();
    relay.dispose();
  });

  it('lists exactly the registered roots', async () => {
    const { registerProject } = await import('../../registry.js');
    const { createLightweightProjectRelay } = await import('../project-relay.js');
    registerProject(projectA);
    registerProject(projectB);

    const relay = createLightweightProjectRelay();
    expect(relay.listRelayTargets().sort()).toEqual([projectA, projectB].sort());
    relay.dispose();
  });

  it('opens an already-indexed project read-only and dispatches get_index_health matching a direct createServer() call on the same DB — no watcher/indexAll runs (TRA-93 d)', async () => {
    const { registerProject, getProject } = await import('../../registry.js');
    const { initializeDatabase } = await import('../../db/schema.js');
    const { Store } = await import('../../db/store.js');
    const { PluginRegistry } = await import('../../plugin-api/registry.js');
    const { ProgressState } = await import('../../progress.js');
    const { loadConfig } = await import('../../config.js');
    const { createServer } = await import('../../server/server.js');
    const { createLightweightProjectRelay } = await import('../project-relay.js');

    registerProject(projectB);
    const entry = getProject(projectB);
    expect(entry).not.toBeNull();

    // Pre-create the index DB so the project counts as "already indexed" —
    // the relay must never index it itself.
    const preDb = initializeDatabase(entry!.dbPath);
    preDb.close();

    const relay = createLightweightProjectRelay();
    const opened = await relay.openProject(projectB);
    expect(opened).not.toBeNull();
    const relayedHandler = opened!.toolHandlers.get('get_index_health');
    expect(relayedHandler).toBeTypeOf('function');
    const relayedResponse = await relayedHandler!({});

    // Build a completely independent, directly-constructed server against
    // the same DB file to compare against — this is "calling it directly on
    // that project's own server", not a re-check of the relay's own output.
    const directDb = initializeDatabase(entry!.dbPath);
    const directStore = new Store(directDb);
    const directRegistry = PluginRegistry.createWithDefaults();
    const directProgress = new ProgressState(directDb);
    const configResult = await loadConfig(projectB);
    if (configResult.isErr()) throw new Error('loadConfig failed');
    const directHandle = createServer(
      directStore,
      directRegistry,
      configResult.value,
      projectB,
      directProgress,
      {},
    );
    const directHandler = directHandle.toolHandlers.get('get_index_health');
    const directResponse = await directHandler!({});

    const relayedText = relayedResponse.content?.[0]?.text;
    const directText = directResponse.content?.[0]?.text;
    expect(relayedText).toBeDefined();
    expect(JSON.parse(relayedText!)).toEqual(JSON.parse(directText!));

    directHandle.dispose();
    directDb.close();
    relay.dispose();
  });

  it('caches the opened handle — a second openProject() call for the same root returns the same handle instance', async () => {
    const { registerProject, getProject } = await import('../../registry.js');
    const { initializeDatabase } = await import('../../db/schema.js');
    const { createLightweightProjectRelay } = await import('../project-relay.js');

    registerProject(projectB);
    const entry = getProject(projectB);
    initializeDatabase(entry!.dbPath).close();

    const relay = createLightweightProjectRelay();
    const first = await relay.openProject(projectB);
    const second = await relay.openProject(projectB);
    expect(second).toBe(first);
    relay.dispose();
  });
});
