/**
 * Endpoint operations — extracted from `TopologyStore` (god-class
 * decomposition). Owns the `api_endpoints` surface plus the endpoint-matching
 * helpers (`normalizeEndpointPattern`, `findBestEndpointMatch`) that the
 * client-call linker consumes.
 *
 * Depends only on the raw `Database` handle; `TopologyStore` holds one instance
 * and delegates its public endpoint methods to it verbatim.
 */

import type Database from 'better-sqlite3';
import type { EndpointRow } from './topology-types.js';

// Cache for normalizeEndpointPattern(): endpoint/URL patterns repeat heavily across
// linkClientCallsToEndpoints() calls (same small set of endpoint paths gets re-normalized
// for every unlinked client call, and re-normalized again on every reindex). Pure string
// transform, so a plain unbounded-within-process Map is safe — never goes stale, and the
// key space is bounded by the number of distinct path patterns actually seen (small
// relative to calls × endpoints). Cleared only implicitly on process exit.
const normalizeCache = new Map<string, string>();

/** Normalize: /api/users/{id} and /api/users/:id → /api/users/{*}. Memoized — see normalizeCache. */
export function normalizeEndpointPattern(p: string): string {
  const cached = normalizeCache.get(p);
  if (cached !== undefined) return cached;
  const normalized = p
    .replace(/\{[^}]+\}/g, '{*}')
    .replace(/:[\w]+/g, '{*}')
    .replace(/\/+$/, '');
  normalizeCache.set(p, normalized);
  return normalized;
}

/**
 * Match a client call URL pattern to the best-fitting endpoint.
 * Normalizes path params ({id}, :id) and compares.
 */
export function findBestEndpointMatch(
  urlPattern: string,
  method: string | null,
  endpoints: Array<EndpointRow & { service_name: string }>,
): (EndpointRow & { service_name: string; confidence: number }) | null {
  const normalizedUrl = normalizeEndpointPattern(urlPattern);
  // Skip overly generic URL patterns — they match everything and produce false positives
  if (!normalizedUrl || normalizedUrl === '/' || normalizedUrl === '') return null;

  let bestMatch: (EndpointRow & { service_name: string; confidence: number }) | null = null;
  let bestScore = 0;

  for (const ep of endpoints) {
    const normalizedEp = normalizeEndpointPattern(ep.path);
    // Skip root endpoints — too generic to produce meaningful matches
    if (!normalizedEp || normalizedEp === '/' || normalizedEp === '') continue;

    // Exact match
    if (normalizedUrl === normalizedEp) {
      const methodBonus =
        method && ep.method && method.toUpperCase() === ep.method.toUpperCase() ? 0.2 : 0;
      const score = 1.0 + methodBonus;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { ...ep, confidence: Math.min(score, 1.0) };
      }
      continue;
    }

    // Partial: url ends with the endpoint path
    if (normalizedUrl.endsWith(normalizedEp) || normalizedEp.endsWith(normalizedUrl)) {
      const score = 0.7;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { ...ep, confidence: score };
      }
    }
  }

  return bestMatch;
}

export class EndpointOperations {
  constructor(private readonly db: Database.Database) {}

  insertEndpoints(
    contractId: number,
    serviceId: number,
    endpoints: Array<{
      method?: string;
      path: string;
      operationId?: string;
      requestSchema?: string;
      responseSchema?: string;
      metadata?: Record<string, unknown>;
    }>,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO api_endpoints (contract_id, service_id, method, path, operation_id, request_schema, response_schema, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const ep of endpoints) {
        stmt.run(
          contractId,
          serviceId,
          ep.method ?? null,
          ep.path,
          ep.operationId ?? null,
          ep.requestSchema ?? null,
          ep.responseSchema ?? null,
          ep.metadata ? JSON.stringify(ep.metadata) : null,
        );
      }
    })();
  }

  getEndpointsByService(serviceId: number): EndpointRow[] {
    return this.db
      .prepare('SELECT * FROM api_endpoints WHERE service_id = ?')
      .all(serviceId) as EndpointRow[];
  }

  findEndpointByPath(
    pathQuery: string,
    method?: string,
  ): Array<EndpointRow & { service_name: string }> {
    // Escape LIKE wildcards in user input
    const escaped = pathQuery.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    if (method) {
      return this.db
        .prepare(`
        SELECT e.*, s.name as service_name FROM api_endpoints e
        JOIN services s ON e.service_id = s.id
        WHERE e.path LIKE ? ESCAPE '\\' AND e.method = ?
      `)
        .all(pattern, method) as Array<EndpointRow & { service_name: string }>;
    }
    return this.db
      .prepare(`
      SELECT e.*, s.name as service_name FROM api_endpoints e
      JOIN services s ON e.service_id = s.id
      WHERE e.path LIKE ? ESCAPE '\\'
    `)
      .all(pattern) as Array<EndpointRow & { service_name: string }>;
  }

  getAllEndpoints(): Array<EndpointRow & { service_name: string }> {
    return this.db
      .prepare(`
      SELECT e.*, s.name as service_name FROM api_endpoints e
      JOIN services s ON e.service_id = s.id
      ORDER BY s.name, e.path
    `)
      .all() as Array<EndpointRow & { service_name: string }>;
  }
}
