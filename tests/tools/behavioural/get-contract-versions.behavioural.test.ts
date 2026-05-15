/**
 * Behavioural coverage for `getContractVersions()`. Seeds multiple
 * contract_snapshots rows for one service, then verifies:
 *   - service with no snapshots returns empty versions array
 *   - multiple snapshots are returned, newest first
 *   - `limit` argument is respected
 *   - each version entry has expected shape (version, specPath, snapshotAt, endpointCount)
 *   - unknown service returns NOT_FOUND
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getContractVersions } from '../../../src/tools/advanced/subproject.js';
import { TopologyStore } from '../../../src/topology/topology-db.js';

interface Fixture {
  store: TopologyStore;
  dbPath: string;
  emptySvcId: number;
  versionedSvcId: number;
  contractId: number;
}

function seed(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-versions-'));
  const dbPath = path.join(tmpDir, 'topology.db');
  const store = new TopologyStore(dbPath);

  // Service with no snapshots.
  const emptySvcId = store.upsertService({
    name: 'empty-svc',
    repoRoot: '/repos/empty',
    dbPath: '/fake/empty.db',
    serviceType: 'api',
    detectionSource: 'test',
  });

  // Service with three snapshots inserted in chronological order.
  const versionedSvcId = store.upsertService({
    name: 'versioned-svc',
    repoRoot: '/repos/versioned',
    dbPath: '/fake/versioned.db',
    serviceType: 'api',
    detectionSource: 'test',
  });
  const contractId = store.insertContract(versionedSvcId, {
    contractType: 'openapi',
    specPath: '/repos/versioned/openapi.yaml',
    parsedSpec: '{}',
  });

  // Three snapshots: v1, v2, v3 — inserted with tiny sleeps so snapshot_at
  // values are strictly increasing. snapshot_at is set to new Date().toISOString()
  // inside insertContractSnapshot, which has millisecond resolution.
  const snapshots = [
    {
      version: 'v1.0.0',
      specPath: '/repos/versioned/openapi.yaml',
      contentHash: 'hash-v1',
      endpointsJson: JSON.stringify({ endpoints: [{ method: 'GET', path: '/a' }] }),
      eventsJson: '[]',
    },
    {
      version: 'v1.1.0',
      specPath: '/repos/versioned/openapi.yaml',
      contentHash: 'hash-v1.1',
      endpointsJson: JSON.stringify({
        endpoints: [
          { method: 'GET', path: '/a' },
          { method: 'GET', path: '/b' },
        ],
      }),
      eventsJson: '[]',
    },
    {
      version: 'v2.0.0',
      specPath: '/repos/versioned/openapi.yaml',
      contentHash: 'hash-v2',
      endpointsJson: JSON.stringify({
        endpoints: [
          { method: 'GET', path: '/a' },
          { method: 'GET', path: '/b' },
          { method: 'POST', path: '/c' },
        ],
      }),
      eventsJson: '[]',
    },
  ];
  for (let i = 0; i < snapshots.length; i++) {
    store.insertContractSnapshot(contractId, versionedSvcId, snapshots[i]);
    // Busy-wait ~2ms so each snapshot_at differs.
    const start = Date.now();
    while (Date.now() - start < 2) {
      // spin
    }
  }

  return { store, dbPath, emptySvcId, versionedSvcId, contractId };
}

describe('getContractVersions() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    ctx.store.close();
    fs.rmSync(path.dirname(ctx.dbPath), { recursive: true, force: true });
  });

  it('service with no snapshots returns empty versions array', () => {
    const result = getContractVersions(ctx.store, { service: 'empty-svc' });
    expect(result.isOk()).toBe(true);
    const versions = result._unsafeUnwrap();
    expect(versions.service).toBe('empty-svc');
    expect(versions.versions).toEqual([]);
    expect(versions.totalBreakingChanges).toBe(0);
  });

  it('multiple snapshots are returned newest first', () => {
    const versions = getContractVersions(ctx.store, {
      service: 'versioned-svc',
    })._unsafeUnwrap();

    expect(versions.versions.length).toBe(3);
    // getSnapshotsByService orders by snapshot_at DESC → newest first.
    const labels = versions.versions.map((v) => v.version);
    expect(labels).toEqual(['v2.0.0', 'v1.1.0', 'v1.0.0']);
  });

  it('limit argument caps returned versions', () => {
    const versions = getContractVersions(ctx.store, {
      service: 'versioned-svc',
      limit: 2,
    })._unsafeUnwrap();

    expect(versions.versions.length).toBe(2);
    expect(versions.versions[0].version).toBe('v2.0.0');
    expect(versions.versions[1].version).toBe('v1.1.0');
  });

  it('each version has expected shape (version, specPath, snapshotAt, endpointCount)', () => {
    const versions = getContractVersions(ctx.store, {
      service: 'versioned-svc',
    })._unsafeUnwrap();

    for (const v of versions.versions) {
      expect(v.version === null || typeof v.version === 'string').toBe(true);
      expect(typeof v.specPath).toBe('string');
      expect(typeof v.snapshotAt).toBe('string');
      expect(typeof v.endpointCount).toBe('number');
    }
    // Endpoint counts come from the parsed endpoints_json.
    const byVersion = new Map(versions.versions.map((v) => [v.version, v.endpointCount]));
    expect(byVersion.get('v1.0.0')).toBe(1);
    expect(byVersion.get('v1.1.0')).toBe(2);
    expect(byVersion.get('v2.0.0')).toBe(3);
  });

  it('unknown service returns NOT_FOUND with candidates', () => {
    const result = getContractVersions(ctx.store, { service: 'no-such' });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('NOT_FOUND');
    if (error.code === 'NOT_FOUND') {
      expect(error.candidates).toEqual(expect.arrayContaining(['versioned-svc', 'empty-svc']));
    }
  });
});
