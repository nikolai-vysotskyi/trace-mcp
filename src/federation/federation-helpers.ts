/**
 * Federation impact helpers — risk computation, breaking-change detection,
 * and per-repo symbol resolution.
 * Extracted from FederationManager to reduce class complexity.
 */
import Database from 'better-sqlite3';
import type { TopologyStore } from '../topology/topology-db.js';
import { diffEndpoints, type EndpointSchemaDiff } from './schema-diff.js';

// ── Re-exported CrossRepoImpactResult subset used here ───────────────────────
// (imported from manager to avoid circular type duplication)

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export function computeRiskLevel(uniqueRepoCount: number, clientCount: number): RiskLevel {
  if (uniqueRepoCount >= 3) return 'critical';
  if (uniqueRepoCount >= 2) return 'high';
  if (clientCount >= 3) return 'medium';
  return 'low';
}

export function upgradeRiskIfBreaking(
  risk: RiskLevel,
  breakingChanges: EndpointSchemaDiff[] | undefined,
): RiskLevel {
  if (!breakingChanges?.some((d) => d.breaking)) return risk;
  const levels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  const idx = levels.indexOf(risk);
  return idx < levels.length - 1 ? levels[idx + 1] : risk;
}

/**
 * Detect breaking schema changes for an endpoint by comparing the latest
 * contract snapshot against current endpoint data.
 */
export function detectBreakingChanges(
  topoStore: TopologyStore,
  ep: { id: number; method: string | null; path: string; service_id: number },
): EndpointSchemaDiff[] | undefined {
  const contracts = topoStore.getContractsByService(ep.service_id);
  for (const contract of contracts) {
    const snapshot = topoStore.getLatestSnapshot(contract.id);
    if (!snapshot) continue;

    let oldEndpoints: Array<{ method: string | null; path: string; requestSchema?: string; responseSchema?: string }> = [];
    try {
      const parsed = JSON.parse(snapshot.endpoints_json) as {
        endpoints?: Array<{ method?: string; path: string; requestSchema?: string; responseSchema?: string }>;
      };
      oldEndpoints = (parsed.endpoints ?? []).map((e) => ({
        method: e.method ?? null,
        path: e.path,
        requestSchema: e.requestSchema,
        responseSchema: e.responseSchema,
      }));
    } catch { continue; }

    const currentEndpoints = topoStore.getEndpointsByService(ep.service_id).map((e) => ({
      method: e.method,
      path: e.path,
      requestSchema: e.request_schema,
      responseSchema: e.response_schema,
    }));

    const epDiffs = diffEndpoints(oldEndpoints, currentEndpoints)
      .filter((d) => d.endpoint.path === ep.path && (d.endpoint.method ?? '*') === (ep.method ?? '*'));

    if (epDiffs.length > 0 && epDiffs.some((d) => d.breaking)) {
      return epDiffs;
    }
  }
  return undefined;
}

/**
 * Open a per-repo DB and find symbols at a given file:line location.
 */
export function resolveSymbolsAtLocation(
  dbPath: string,
  filePath: string,
  line: number | null,
): Array<{ symbolId: string; name: string; kind: string; fqn: string | null }> {
  if (!line) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(`
        SELECT s.symbol_id, s.name, s.kind, s.fqn
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE f.path LIKE ? AND s.line_start <= ? AND (s.line_end >= ? OR s.line_end IS NULL)
        ORDER BY (s.line_end - s.line_start) ASC
        LIMIT 5
      `).all(`%${filePath}`, line, line) as Array<{
        symbol_id: string; name: string; kind: string; fqn: string | null;
      }>;
      return rows.map((r) => ({ symbolId: r.symbol_id, name: r.name, kind: r.kind, fqn: r.fqn }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
