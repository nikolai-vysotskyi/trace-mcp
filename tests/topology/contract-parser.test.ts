import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseContracts } from '../../src/topology/contract-parser.js';

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
          User: { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' } } },
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
    fs.writeFileSync(path.join(nmDir, 'openapi.json'), JSON.stringify({
      openapi: '3.0.0',
      paths: { '/ignored': { get: {} } },
    }));

    expect(parseContracts(tmpDir)).toEqual([]);
  });

  it('handles malformed specs gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{ not valid json !!!');
    // Should not throw
    const result = parseContracts(tmpDir);
    expect(result).toEqual([]);
  });
});
