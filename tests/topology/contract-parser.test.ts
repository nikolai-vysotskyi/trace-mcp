import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { parseContracts, extractRoutesFromDb } from '../../src/topology/contract-parser.js';

describe('parseContracts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-parser-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for empty directory', () => {
    expect(parseContracts(tmpDir)).toEqual([]);
  });

  it('parses OpenAPI 3.x JSON spec', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/users': {
          get: { operationId: 'listUsers', tags: ['users'] },
          post: {
            operationId: 'createUser',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { name: { type: 'string' } } },
                },
              },
            },
            responses: {
              '201': {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { id: { type: 'number' } } },
                  },
                },
              },
            },
          },
        },
        '/users/{id}': {
          get: { operationId: 'getUser' },
          delete: { operationId: 'deleteUser' },
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'openapi.json'), JSON.stringify(spec));

    const result = parseContracts(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('openapi');
    expect(result[0].version).toBe('3.0.3');
    expect(result[0].endpoints.length).toBeGreaterThanOrEqual(4);

    const post = result[0].endpoints.find((e) => e.method === 'POST' && e.path === '/users');
    expect(post).toBeDefined();
    expect(post!.operationId).toBe('createUser');
    expect(post!.requestSchema).toBeDefined();
    expect(post!.responseSchema).toBeDefined();
  });

  it('parses OpenAPI YAML spec (regex fallback)', () => {
    const yaml = `
openapi: "3.0.0"
paths:
  /health:
    get:
      operationId: healthCheck
  /items:
    post:
      operationId: createItem
`;
    fs.writeFileSync(path.join(tmpDir, 'openapi.yaml'), yaml);

    const result = parseContracts(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('openapi');
    expect(result[0].version).toBe('3.0.0');
    expect(result[0].endpoints.length).toBeGreaterThanOrEqual(2);
  });

  it('parses Swagger 2.0 JSON spec', () => {
    const spec = {
      swagger: '2.0',
      paths: {
        '/api/v1/orders': {
          get: { operationId: 'listOrders' },
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'swagger.json'), JSON.stringify(spec));

    const result = parseContracts(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe('2.0');
  });

  it('parses GraphQL SDL', () => {
    const sdl = `
type Query {
  users: [User!]!
  user(id: ID!): User
}

type Mutation {
  createUser(input: CreateUserInput!): User!
}
`;
    fs.writeFileSync(path.join(tmpDir, 'schema.graphql'), sdl);

    const result = parseContracts(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('graphql');
    expect(result[0].endpoints.length).toBeGreaterThanOrEqual(2);

    const queryEp = result[0].endpoints.find((e) => e.path === 'users' && e.method === 'Query');
    expect(queryEp).toBeDefined();
  });

  it('parses Protobuf service definitions', () => {
    const proto = `
syntax = "proto3";

service UserService {
  rpc GetUser (GetUserRequest) returns (User);
  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);
}
`;
    fs.writeFileSync(path.join(tmpDir, 'user.proto'), proto);

    const result = parseContracts(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('grpc');
    expect(result[0].endpoints).toHaveLength(2);
    expect(result[0].endpoints[0].path).toContain('UserService');
  });

  it('resolves $ref in OpenAPI schemas', () => {
    const spec = {
      openapi: '3.0.0',
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: { id: { type: 'number' }, name: { type: 'string' } },
          },
        },
      },
      paths: {
        '/users': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'openapi.json'), JSON.stringify(spec));

    const result = parseContracts(tmpDir);
    const ep = result[0].endpoints[0];
    expect(ep.responseSchema).toBeDefined();
    expect(ep.responseSchema).toHaveProperty('properties');
  });

  it('ignores files in node_modules', () => {
    const nmDir = path.join(tmpDir, 'node_modules', 'some-pkg');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nmDir, 'openapi.json'),
      JSON.stringify({
        openapi: '3.0.0',
        paths: { '/ignored': { get: {} } },
      }),
    );

    expect(parseContracts(tmpDir)).toEqual([]);
  });

  it('handles malformed specs gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{ not valid json !!!');
    // Should not throw
    const result = parseContracts(tmpDir);
    expect(result).toEqual([]);
  });
});

describe('extractRoutesFromDb', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routes-db-')), 'index.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE routes (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id),
        method TEXT NOT NULL,
        uri TEXT NOT NULL,
        name TEXT
      );
      INSERT INTO files (id, path) VALUES (1, 'app/routes/web.php');
      INSERT INTO files (id, path) VALUES (2, 'src/cli.ts');
    `);
    // HTTP routes (should be included)
    db.exec(`
      INSERT INTO routes (file_id, method, uri, name) VALUES (1, 'GET', '/users', 'users.index');
      INSERT INTO routes (file_id, method, uri, name) VALUES (1, 'POST', '/users', 'users.store');
      INSERT INTO routes (file_id, method, uri, name) VALUES (1, 'ANY', '/webhook', NULL);
    `);
    // Non-HTTP routes (should be filtered out)
    db.exec(`
      INSERT INTO routes (file_id, method, uri, name) VALUES (2, 'CLI', 'serve', NULL);
      INSERT INTO routes (file_id, method, uri, name) VALUES (2, 'JOB', 'deploy', NULL);
      INSERT INTO routes (file_id, method, uri, name) VALUES (2, 'TOOL', 'search', NULL);
      INSERT INTO routes (file_id, method, uri, name) VALUES (2, 'TEST', 'test_foo', NULL);
    `);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('only extracts HTTP method routes', () => {
    const contract = extractRoutesFromDb(dbPath);
    expect(contract).not.toBeNull();
    expect(contract!.type).toBe('framework_routes');
    expect(contract!.endpoints).toHaveLength(3); // GET, POST, ANY
    const methods = contract!.endpoints.map((e) => e.method);
    expect(methods).not.toContain('CLI');
    expect(methods).not.toContain('JOB');
    expect(methods).not.toContain('TOOL');
    expect(methods).not.toContain('TEST');
  });

  it('returns null when only non-HTTP routes exist', () => {
    // Remove HTTP routes
    const db = new Database(dbPath);
    db.exec("DELETE FROM routes WHERE method IN ('GET', 'POST', 'ANY')");
    db.close();

    const contract = extractRoutesFromDb(dbPath);
    expect(contract).toBeNull();
  });

  it('returns null for non-existent DB', () => {
    expect(extractRoutesFromDb('/nonexistent/path.db')).toBeNull();
  });

  it('filters by pathPrefix when provided', () => {
    const contract = extractRoutesFromDb(dbPath, 'app/routes');
    // Only routes from files matching the prefix should be included
    expect(contract).not.toBeNull();
    // File 1 matches 'app/routes/web.php', file 2 doesn't
    expect(contract!.endpoints).toHaveLength(3);
  });
});
