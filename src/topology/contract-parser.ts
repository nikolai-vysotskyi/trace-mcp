/**
 * Contract Parser — discovers and parses API spec files (OpenAPI, GraphQL SDL, Proto).
 * Returns normalized endpoint and event definitions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface ParsedContract {
  type: 'openapi' | 'grpc' | 'graphql';
  specPath: string;
  version: string;
  endpoints: ParsedEndpoint[];
  events: ParsedEvent[];
}

interface ParsedEndpoint {
  method: string | null;
  path: string;
  operationId?: string;
  tags?: string[];
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
 * Parse OpenAPI spec (JSON or simple YAML key extraction).
 * No yaml dependency — uses regex for YAML, JSON.parse for JSON.
 */
function parseOpenApi(content: string, specPath: string): ParsedContract | null {
  let version = '';
  const endpoints: ParsedEndpoint[] = [];

  // Try JSON first
  if (content.trim().startsWith('{')) {
    try {
      const spec = JSON.parse(content);
      version = spec.openapi ?? spec.swagger ?? '';

      const paths = spec.paths ?? {};
      for (const [pathStr, methods] of Object.entries(paths)) {
        if (typeof methods !== 'object' || !methods) continue;
        for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
          if ((methods as Record<string, unknown>)[method]) {
            const op = (methods as Record<string, Record<string, unknown>>)[method];
            endpoints.push({
              method: method.toUpperCase(),
              path: pathStr,
              operationId: op?.operationId as string | undefined,
              tags: op?.tags as string[] | undefined,
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
