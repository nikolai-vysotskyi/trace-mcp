/**
 * Contract operations — extracted from `TopologyStore` (god-class
 * decomposition). Owns the `api_contracts` table surface: insert, per-service
 * lookup, and per-service deletion (with client-call detachment).
 *
 * Depends only on the raw `Database` handle; `TopologyStore` holds one instance
 * and delegates its public contract methods to it verbatim.
 */

import type Database from 'better-sqlite3';
import type { ContractRow } from './topology-types.js';

export class ContractOperations {
  constructor(private readonly db: Database.Database) {}

  insertContract(
    serviceId: number,
    input: {
      contractType: string;
      specPath: string;
      version?: string;
      contentHash?: string;
      parsedSpec: string;
    },
  ): number {
    return this.db
      .prepare(`
      INSERT INTO api_contracts (service_id, contract_type, spec_path, version, content_hash, parsed_spec, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `)
      .run(
        serviceId,
        input.contractType,
        input.specPath,
        input.version ?? null,
        input.contentHash ?? null,
        input.parsedSpec,
      ).lastInsertRowid as number;
  }

  getContractsByService(serviceId: number): ContractRow[] {
    return this.db
      .prepare('SELECT * FROM api_contracts WHERE service_id = ?')
      .all(serviceId) as ContractRow[];
  }

  deleteContractsByService(serviceId: number): void {
    // client_calls.matched_endpoint_id references api_endpoints(id) without ON DELETE CASCADE/SET NULL,
    // so cascading the contract delete would hit an FK violation. Null out those matches first —
    // linkClientCallsToEndpoints() will re-resolve them after fresh endpoints are inserted.
    this.db.transaction(() => {
      this.db
        .prepare(`
        UPDATE client_calls SET matched_endpoint_id = NULL
        WHERE matched_endpoint_id IN (SELECT id FROM api_endpoints WHERE service_id = ?)
      `)
        .run(serviceId);
      this.db.prepare('DELETE FROM api_contracts WHERE service_id = ?').run(serviceId);
    })();
  }
}
