/**
 * Contract Parser — discovers and parses API spec files (OpenAPI, GraphQL SDL, Proto).
 * Returns normalized endpoint and event definitions.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '../logger.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface ParsedContract {
  type: 'openapi' | 'grpc' | 'graphql' | 'framework_routes';
  specPath: string;
  version: string;
  endpoints: ParsedEndpoint[];
  events: ParsedEvent[];
}

export interface ParsedEndpoint {
  method: string | null;
  path: string;
  operationId?: string;
  tags?: string[];
  requestSchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
}

interface ParsedEvent {
  channelName: string;
  direction: 'publish' | 'subscribe';
}

// ════════════════════════════════════════════════════════════════════════
// DISCOVERY
// ════════════════════════════════════════════════════════════════════════

const EXCLUDE_DIRS = ['node_modules', 'vendor', '.git', 'dist', 'build', '__pycache__'];

/**
 * Discover and parse all API contracts in a directory.
 */
export function parseContracts(repoRoot: string): ParsedContract[] {
  const contracts: ParsedContract[] = [];

  // Walk for spec files
  const specFiles = findSpecFiles(repoRoot);

  for (const { filePath, type } of specFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relPath = path.relative(repoRoot, filePath);

      let contract: ParsedContract | null = null;

      switch (type) {
        case 'openapi':
          contract = parseOpenApi(content, relPath);
          break;
        case 'graphql':
          contract = parseGraphqlSdl(content, relPath);
          break;
        case 'grpc':
          contract = parseProto(content, relPath);
          break;
      }

      if (contract && (contract.endpoints.length > 0 || contract.events.length > 0)) {
        contracts.push(contract);
      }
    } catch (e) {
      logger.warn({ error: e, filePath }, 'Failed to parse contract');
    }
  }

  return contracts;
}

// ════════════════════════════════════════════════════════════════════════
// PARSERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Resolve single-level $ref pointers within a JSON Schema object.
 * Inlines top-level references from components.schemas so field names are visible for diffing.
 */
function resolveRefs(
  schema: Record<string, unknown>,
  components: Record<string, unknown> | undefined,
  depth = 0,
): Record<string, unknown> {
  if (depth > 5 || !schema || typeof schema !== 'object') return schema;

  // Direct $ref: { "$ref": "#/components/schemas/User" }
  if (typeof schema['$ref'] === 'string') {
    const refPath = schema['$ref'] as string;
    const match = /^#\/components\/schemas\/(\w+)$/.exec(refPath);
    if (match && components?.[match[1]] && typeof components[match[1]] === 'object') {
      return resolveRefs(components[match[1]] as Record<string, unknown>, components, depth + 1);
    }
    return schema;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && typeof value === 'object' && value) {
      const resolved: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        if (typeof propSchema === 'object' && propSchema) {
          resolved[propName] = resolveRefs(propSchema as Record<string, unknown>, components, depth + 1);
        } else {
          resolved[propName] = propSchema;
        }
      }
      result[key] = resolved;
    } else if (key === 'items' && typeof value === 'object' && value) {
      result[key] = resolveRefs(value as Record<string, unknown>, components, depth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract the response schema from an OpenAPI operation's responses object.
 * Picks the first 2xx response with content.
 */
function extractResponseSchema(
  responses: Record<string, unknown>,
  components: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  for (const code of ['200', '201', '202', '204']) {
    const resp = responses[code] as Record<string, unknown> | undefined;
    if (!resp) continue;
    const content = resp.content as Record<string, Record<string, unknown>> | undefined;
    const jsonContent = content?.['application/json'];
    if (jsonContent?.schema && typeof jsonContent.schema === 'object') {
      return resolveRefs(jsonContent.schema as Record<string, unknown>, components);
    }
  }
  return undefined;
}

/**
 * Parse OpenAPI spec (JSON or simple YAML key extraction).
 * No yaml dependency — uses regex for YAML, JSON.parse for JSON.
 * JSON specs also extract request/response schemas for field-level diffing.
 */
function parseOpenApi(content: string, specPath: string): ParsedContract | null {
  let version = '';
  const endpoints: ParsedEndpoint[] = [];

  // Try JSON first
  if (content.trim().startsWith('{')) {
    try {
      const spec = JSON.parse(content);
      version = spec.openapi ?? spec.swagger ?? '';
      const components = spec.components?.schemas as Record<string, unknown> | undefined;

      const paths = spec.paths ?? {};
      for (const [pathStr, methods] of Object.entries(paths)) {
        if (typeof methods !== 'object' || !methods) continue;
        for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
          if ((methods as Record<string, unknown>)[method]) {
            const op = (methods as Record<string, Record<string, unknown>>)[method];

            // Extract request schema
            let requestSchema: Record<string, unknown> | undefined;
            const reqBody = op?.requestBody as Record<string, unknown> | undefined;
            const reqContent = reqBody?.content as Record<string, Record<string, unknown>> | undefined;
            const reqJsonSchema = reqContent?.['application/json']?.schema;
            if (reqJsonSchema && typeof reqJsonSchema === 'object') {
              requestSchema = resolveRefs(reqJsonSchema as Record<string, unknown>, components);
            }

            // Extract response schema
            const respObj = op?.responses as Record<string, unknown> | undefined;
            const responseSchema = respObj ? extractResponseSchema(respObj, components) : undefined;

            endpoints.push({
              method: method.toUpperCase(),
              path: pathStr,
              operationId: op?.operationId as string | undefined,
              tags: op?.tags as string[] | undefined,
              requestSchema,
              responseSchema,
            });
          }
        }
      }

      return { type: 'openapi', specPath, version, endpoints, events: [] };
    } catch { /* not valid JSON, try YAML approach */ }
  }

  // Simple YAML path extraction using regex
  const versionMatch = /^(?:openapi|swagger):\s*['"]?(\S+?)['"]?\s*$/m.exec(content);
  version = versionMatch?.[1] ?? '';

  // Extract paths using indentation patterns
  const pathRegex = /^\s{2}(\/\S+):\s*$/gm;
  const methodRegex = /^\s{4}(get|post|put|patch|delete|head|options):\s*$/gm;

  let currentPath = '';
  for (const line of content.split('\n')) {
    const pathMatch = /^\s{2}(\/\S+):/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }

    if (currentPath) {
      const methodMatch = /^\s{4}(get|post|put|patch|delete|head|options):/.exec(line);
      if (methodMatch) {
        endpoints.push({
          method: methodMatch[1].toUpperCase(),
          path: currentPath,
        });
      }

      // New top-level key resets current path
      if (/^\S/.test(line) && line.trim().length > 0) {
        currentPath = '';
      }
    }
  }

  if (endpoints.length === 0) return null;
  return { type: 'openapi', specPath, version, endpoints, events: [] };
}

/**
 * Parse GraphQL SDL — extract Query/Mutation/Subscription fields as endpoints.
 */
function parseGraphqlSdl(content: string, specPath: string): ParsedContract | null {
  const endpoints: ParsedEndpoint[] = [];

  // Match type Query { ... }, type Mutation { ... }
  const typeBlockRegex = /type\s+(Query|Mutation|Subscription)\s*\{([^}]+)\}/g;
  let match;

  while ((match = typeBlockRegex.exec(content)) !== null) {
    const typeName = match[1];
    const body = match[2];
    const fieldRegex = /^\s*(\w+)\s*[\(:]/gm;
    let fieldMatch;

    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      endpoints.push({
        method: typeName,
        path: fieldMatch[1],
      });
    }
  }

  if (endpoints.length === 0) return null;
  return { type: 'graphql', specPath, version: 'SDL', endpoints, events: [] };
}

/**
 * Parse .proto file — extract service/rpc definitions.
 */
function parseProto(content: string, specPath: string): ParsedContract | null {
  const endpoints: ParsedEndpoint[] = [];

  const serviceRegex = /service\s+(\w+)\s*\{([^}]+)\}/g;
  let serviceMatch;

  while ((serviceMatch = serviceRegex.exec(content)) !== null) {
    const serviceName = serviceMatch[1];
    const body = serviceMatch[2];
    const rpcRegex = /rpc\s+(\w+)\s*\(/g;
    let rpcMatch;

    while ((rpcMatch = rpcRegex.exec(body)) !== null) {
      endpoints.push({
        method: 'gRPC',
        path: `${serviceName}.${rpcMatch[1]}`,
      });
    }
  }

  if (endpoints.length === 0) return null;
  return { type: 'grpc', specPath, version: 'proto3', endpoints, events: [] };
}

// ════════════════════════════════════════════════════════════════════════
// FILE DISCOVERY
// ════════════════════════════════════════════════════════════════════════

function findSpecFiles(root: string): Array<{ filePath: string; type: 'openapi' | 'grpc' | 'graphql' }> {
  const results: Array<{ filePath: string; type: 'openapi' | 'grpc' | 'graphql' }> = [];

  function walk(dir: string, depth: number): void {
    if (depth > 5) return; // limit recursion
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (EXCLUDE_DIRS.includes(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();

        if (lower === 'openapi.yml' || lower === 'openapi.yaml' || lower === 'openapi.json'
          || lower === 'swagger.yml' || lower === 'swagger.yaml' || lower === 'swagger.json'
          || lower === 'api-spec.yml' || lower === 'api-spec.yaml' || lower === 'api-spec.json') {
          results.push({ filePath: fullPath, type: 'openapi' });
        } else if (lower === 'schema.graphql' || lower === 'schema.gql') {
          results.push({ filePath: fullPath, type: 'graphql' });
        } else if (lower.endsWith('.proto')) {
          results.push({ filePath: fullPath, type: 'grpc' });
        }
      }
    }
  }

  walk(root, 0);
  return results;
}

// ════════════════════════════════════════════════════════════════════════
// ROUTE EXTRACTION FROM TRACE-MCP INDEX DB
// ════════════════════════════════════════════════════════════════════════

/**
 * Extract routes from an existing trace-mcp index DB as a synthetic contract.
 * Used as fallback when no formal API spec files (OpenAPI/GraphQL/Proto) exist.
 *
 * @param dbPath      Path to the trace-mcp SQLite index DB.
 * @param pathPrefix  Optional absolute path prefix — when set, only routes whose
 *                    source file path starts with this prefix are included.
 *                    Enables filtering sub-service routes from a monorepo DB.
 */
// HTTP methods that represent real API endpoints (vs CLI, JOB, TOOL, TEST, etc.)
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY']);

export function extractRoutesFromDb(dbPath: string, pathPrefix?: string): ParsedContract | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      let rows: Array<{ method: string; uri: string; name: string | null }>;

      if (pathPrefix) {
        // Normalise: ensure trailing slash so "fair-laravel" doesn't match "fair-laravel-admin"
        const prefix = pathPrefix.endsWith('/') ? pathPrefix : `${pathPrefix}/`;
        rows = db.prepare(`
          SELECT r.method, r.uri, r.name
          FROM routes r
          JOIN files f ON r.file_id = f.id
          WHERE f.path LIKE ? OR f.path LIKE ?
          ORDER BY r.uri
        `).all(`${prefix}%`, `${pathPrefix}`) as Array<{ method: string; uri: string; name: string | null }>;
      } else {
        rows = db.prepare(
          'SELECT method, uri, name FROM routes ORDER BY uri',
        ).all() as Array<{ method: string; uri: string; name: string | null }>;
      }

      // Filter to HTTP routes only — exclude CLI commands, CI jobs, MCP tools, test routes, etc.
      rows = rows.filter((r) => HTTP_METHODS.has(r.method));

      if (rows.length === 0) return null;

      const endpoints: ParsedEndpoint[] = rows.map((r) => ({
        method: r.method === 'ANY' ? null : r.method,
        path: r.uri.startsWith('/') ? r.uri : `/${r.uri}`,
        operationId: r.name ?? undefined,
      }));

      logger.debug({ dbPath, pathPrefix, count: endpoints.length }, 'Extracted routes from trace-mcp DB');
      return {
        type: 'framework_routes',
        specPath: dbPath,
        version: 'auto',
        endpoints,
        events: [],
      };
    } finally {
      db.close();
    }
  } catch (e) {
    logger.warn({ dbPath, error: (e as Error).message }, 'Failed to extract routes from DB');
    return null;
  }
}
