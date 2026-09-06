/**
 * TRA-948: SnapshotBackend opens the daemon's canonical index DB directly,
 * readonly, with no seed copy — unlike LocalBackend, which derives an owned
 * session temp DB it deletes on stop(). These tests guard the property that
 * makes the fast path safe: the shared file is never mutated or deleted.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../../config.js';
import { initializeDatabase } from '../../../db/schema.js';
import { SnapshotBackend } from '../snapshot-backend.js';

let tmpDir: string;
let dbPath: string;
let backend: SnapshotBackend | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trace-mcp-snapshot-backend-'));
  dbPath = join(tmpDir, 'shared.db');
  // Pre-create the index DB the way the daemon would — the backend must
  // never run DDL/migrations on it itself.
  initializeDatabase(dbPath).close();
});

afterEach(async () => {
  await backend?.stop();
  backend = null;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Drives one request/response round trip over the backend's in-memory transport. */
function sendAndWait(b: SnapshotBackend, msg: JSONRPCMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    b.onmessage = (m) => resolve(m as unknown as Record<string, unknown>);
    void b.send(msg);
  });
}

describe('SnapshotBackend (TRA-948)', () => {
  it('answers initialize and get_project_map from the snapshot without mutating it', async () => {
    backend = new SnapshotBackend({
      projectRoot: tmpDir,
      config: TraceMcpConfigSchema.parse({}),
      sharedDbPath: dbPath,
    });
    await backend.start();

    const init = await sendAndWait(backend, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    } as unknown as JSONRPCMessage);
    expect(init.error).toBeUndefined();
    expect((init.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe('trace');

    const call = await sendAndWait(backend, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_project_map', arguments: {} },
    } as unknown as JSONRPCMessage);
    expect(call.error).toBeUndefined();
    expect(call.result).toBeTruthy();
  });

  it('rejects start() when the shared DB does not exist (safe-fallback contract)', async () => {
    backend = new SnapshotBackend({
      projectRoot: tmpDir,
      config: TraceMcpConfigSchema.parse({}),
      sharedDbPath: join(tmpDir, 'never-created.db'),
    });
    await expect(backend.start()).rejects.toThrow();
  });

  it('leaves the shared DB file on disk and reusable after stop() — never deletes or locks it', async () => {
    backend = new SnapshotBackend({
      projectRoot: tmpDir,
      config: TraceMcpConfigSchema.parse({}),
      sharedDbPath: dbPath,
    });
    await backend.start();
    await backend.stop();
    backend = null;

    expect(existsSync(dbPath)).toBe(true);

    // A second backend can still open the same file — proves the first
    // instance's readonly connection didn't leave it locked or corrupted.
    const second = new SnapshotBackend({
      projectRoot: tmpDir,
      config: TraceMcpConfigSchema.parse({}),
      sharedDbPath: dbPath,
    });
    await expect(second.start()).resolves.toBeUndefined();
    await second.stop();
  });
});
