/**
 * Contract-snapshot operations — extracted from `TopologyStore` (god-class
 * decomposition). Owns the `contract_snapshots` table surface: insert plus the
 * per-contract / per-service history reads.
 *
 * Depends only on the raw `Database` handle; `TopologyStore` holds one instance
 * and delegates its public snapshot methods to it verbatim.
 */

import type Database from 'better-sqlite3';
import type { ContractSnapshotRow } from './topology-types.js';

export class SnapshotOperations {
  constructor(private readonly db: Database.Database) {}

  insertContractSnapshot(
    contractId: number,
    serviceId: number,
    input: {
      version: string | null;
      specPath: string;
      contentHash: string;
      endpointsJson: string;
      eventsJson: string;
    },
  ): number {
    const result = this.db
      .prepare(`
      INSERT INTO contract_snapshots (contract_id, service_id, version, spec_path, content_hash, endpoints_json, events_json, snapshot_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        contractId,
        serviceId,
        input.version,
        input.specPath,
        input.contentHash,
        input.endpointsJson,
        input.eventsJson,
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  getContractSnapshots(contractId: number, limit = 50): ContractSnapshotRow[] {
    return this.db
      .prepare(
        'SELECT * FROM contract_snapshots WHERE contract_id = ? ORDER BY snapshot_at DESC LIMIT ?',
      )
      .all(contractId, limit) as ContractSnapshotRow[];
  }

  getLatestSnapshot(contractId: number): ContractSnapshotRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM contract_snapshots WHERE contract_id = ? ORDER BY snapshot_at DESC LIMIT 1',
      )
      .get(contractId) as ContractSnapshotRow | undefined;
  }

  getSnapshotsByService(serviceId: number, limit = 50): ContractSnapshotRow[] {
    return this.db
      .prepare(
        'SELECT * FROM contract_snapshots WHERE service_id = ? ORDER BY snapshot_at DESC LIMIT ?',
      )
      .all(serviceId, limit) as ContractSnapshotRow[];
  }
}
