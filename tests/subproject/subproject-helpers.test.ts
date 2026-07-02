/**
 * Behavioral coverage for src/subproject/subproject-helpers.ts.
 * This module had zero tests despite carrying real branching logic
 * (risk-level thresholds, breaking-change detection across contract
 * snapshots, and a raw-SQL symbol lookup) — flagged by the tech-debt
 * audit as complex + untested. Covers the actual decision branches,
 * not just "doesn't throw".
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import {
  computeRiskLevel,
  detectBreakingChanges,
  resolveSymbolsAtLocation,
  upgradeRiskIfBreaking,
} from '../../src/subproject/subproject-helpers.js';
import { TopologyStore } from '../../src/topology/topology-db.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('computeRiskLevel', () => {
  it('returns critical when 3 or more unique repos call the endpoint', () => {
    expect(computeRiskLevel(3, 1)).toBe('critical');
    expect(computeRiskLevel(5, 0)).toBe('critical');
  });

  it('returns high when exactly 2 unique repos call the endpoint', () => {
    expect(computeRiskLevel(2, 1)).toBe('high');
  });

  it('returns medium when fewer than 2 repos but 3+ total clients', () => {
    expect(computeRiskLevel(1, 3)).toBe('medium');
    expect(computeRiskLevel(0, 10)).toBe('medium');
  });

  it('returns low when fewer than 2 repos and fewer than 3 clients', () => {
    expect(computeRiskLevel(1, 2)).toBe('low');
    expect(computeRiskLevel(0, 0)).toBe('low');
  });

  it('prioritizes the repo-count threshold over the client-count threshold', () => {
    // 2 repos but only 1 client total still counts as "high" (cross-repo risk
    // outranks raw client volume).
    expect(computeRiskLevel(2, 1)).toBe('high');
  });
});

describe('upgradeRiskIfBreaking', () => {
  it('leaves risk unchanged when breakingChanges is undefined', () => {
    expect(upgradeRiskIfBreaking('low', undefined)).toBe('low');
    expect(upgradeRiskIfBreaking('high', undefined)).toBe('high');
  });

  it('leaves risk unchanged when no diff entry is breaking', () => {
    const diffs = [
      {
        endpoint: { method: 'GET', path: '/x' },
        requestChanges: [],
        responseChanges: [
          { type: 'field_added', path: 'age', breaking: false, confidence: 1 } as const,
        ],
        breaking: false,
      },
    ];
    expect(upgradeRiskIfBreaking('medium', diffs)).toBe('medium');
  });

  it('bumps risk exactly one level when a breaking diff is present', () => {
    const breakingDiffs = [
      {
        endpoint: { method: 'GET', path: '/x' },
        requestChanges: [],
        responseChanges: [
          { type: 'field_removed', path: 'email', breaking: true, confidence: 1 } as const,
        ],
        breaking: true,
      },
    ];
    expect(upgradeRiskIfBreaking('low', breakingDiffs)).toBe('medium');
    expect(upgradeRiskIfBreaking('medium', breakingDiffs)).toBe('high');
    expect(upgradeRiskIfBreaking('high', breakingDiffs)).toBe('critical');
  });

  it('caps at critical instead of overflowing', () => {
    const breakingDiffs = [
      {
        endpoint: { method: 'GET', path: '/x' },
        requestChanges: [],
        responseChanges: [
          { type: 'field_removed', path: 'email', breaking: true, confidence: 1 } as const,
        ],
        breaking: true,
      },
    ];
    expect(upgradeRiskIfBreaking('critical', breakingDiffs)).toBe('critical');
  });
});

describe('detectBreakingChanges', () => {
  let store: TopologyStore;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('trace-mcp-breaking-');
    dbPath = path.join(tmpDir, 'topology.db');
    store = new TopologyStore(dbPath);
  });

  afterEach(() => {
    store.close();
    removeTmpDir(tmpDir);
  });

  function setupService(): number {
    return store.upsertService({
      name: 'svc-a',
      repoRoot: '/repos/svc-a',
      dbPath: '/fake/a.db',
      serviceType: 'api',
      detectionSource: 'test',
    });
  }

  it('returns undefined when the service has no contracts', () => {
    const serviceId = setupService();
    const ep = { id: 1, method: 'GET', path: '/users', service_id: serviceId };
    expect(detectBreakingChanges(store, ep)).toBeUndefined();
  });

  it('returns undefined when a contract exists but has no snapshot', () => {
    const serviceId = setupService();
    store.insertContract(serviceId, {
      contractType: 'openapi',
      specPath: '/repos/svc-a/openapi.yaml',
      parsedSpec: '{}',
    });
    const ep = { id: 1, method: 'GET', path: '/users', service_id: serviceId };
    expect(detectBreakingChanges(store, ep)).toBeUndefined();
  });

  it('skips a snapshot with malformed endpoints_json instead of throwing', () => {
    const serviceId = setupService();
    const contractId = store.insertContract(serviceId, {
      contractType: 'openapi',
      specPath: '/repos/svc-a/openapi.yaml',
      parsedSpec: '{}',
    });
    store.insertContractSnapshot(contractId, serviceId, {
      version: '1.0.0',
      specPath: '/repos/svc-a/openapi.yaml',
      contentHash: 'abc',
      endpointsJson: '{not valid json',
      eventsJson: '[]',
    });
    const ep = { id: 1, method: 'GET', path: '/users', service_id: serviceId };
    expect(() => detectBreakingChanges(store, ep)).not.toThrow();
    expect(detectBreakingChanges(store, ep)).toBeUndefined();
  });

  it('returns undefined when the endpoint schema is unchanged', () => {
    const serviceId = setupService();
    const contractId = store.insertContract(serviceId, {
      contractType: 'openapi',
      specPath: '/repos/svc-a/openapi.yaml',
      parsedSpec: '{}',
    });
    store.insertEndpoints(contractId, serviceId, [
      {
        method: 'GET',
        path: '/users',
        responseSchema: JSON.stringify({ properties: { name: { type: 'string' } } }),
      },
    ]);
    store.insertContractSnapshot(contractId, serviceId, {
      version: '1.0.0',
      specPath: '/repos/svc-a/openapi.yaml',
      contentHash: 'abc',
      endpointsJson: JSON.stringify({
        endpoints: [
          {
            method: 'GET',
            path: '/users',
            responseSchema: JSON.stringify({ properties: { name: { type: 'string' } } }),
          },
        ],
      }),
      eventsJson: '[]',
    });
    const endpoints = store.getAllEndpoints();
    const ep = endpoints.find((e) => e.path === '/users')!;
    expect(detectBreakingChanges(store, ep)).toBeUndefined();
  });

  it('returns the breaking diffs when a response field was removed since the snapshot', () => {
    const serviceId = setupService();
    const contractId = store.insertContract(serviceId, {
      contractType: 'openapi',
      specPath: '/repos/svc-a/openapi.yaml',
      parsedSpec: '{}',
    });
    // Current endpoint no longer has `email` in the response.
    store.insertEndpoints(contractId, serviceId, [
      {
        method: 'GET',
        path: '/users',
        responseSchema: JSON.stringify({ properties: { name: { type: 'string' } } }),
      },
    ]);
    // Snapshot (previous version) had `email`.
    store.insertContractSnapshot(contractId, serviceId, {
      version: '1.0.0',
      specPath: '/repos/svc-a/openapi.yaml',
      contentHash: 'abc',
      endpointsJson: JSON.stringify({
        endpoints: [
          {
            method: 'GET',
            path: '/users',
            responseSchema: JSON.stringify({
              properties: { name: { type: 'string' }, email: { type: 'string' } },
            }),
          },
        ],
      }),
      eventsJson: '[]',
    });
    const endpoints = store.getAllEndpoints();
    const ep = endpoints.find((e) => e.path === '/users')!;

    const diffs = detectBreakingChanges(store, ep);
    expect(diffs).toBeDefined();
    expect(diffs!.length).toBeGreaterThan(0);
    expect(diffs![0].breaking).toBe(true);
    expect(
      diffs![0].responseChanges.some((d) => d.type === 'field_removed' && d.path === 'email'),
    ).toBe(true);
  });

  it('only returns diffs for the requested method+path, not other endpoints on the same contract', () => {
    const serviceId = setupService();
    const contractId = store.insertContract(serviceId, {
      contractType: 'openapi',
      specPath: '/repos/svc-a/openapi.yaml',
      parsedSpec: '{}',
    });
    store.insertEndpoints(contractId, serviceId, [
      { method: 'GET', path: '/users', responseSchema: JSON.stringify({ properties: {} }) },
      { method: 'POST', path: '/users', responseSchema: JSON.stringify({ properties: {} }) },
    ]);
    store.insertContractSnapshot(contractId, serviceId, {
      version: '1.0.0',
      specPath: '/repos/svc-a/openapi.yaml',
      contentHash: 'abc',
      endpointsJson: JSON.stringify({
        endpoints: [
          {
            method: 'GET',
            path: '/users',
            responseSchema: JSON.stringify({ properties: { removedField: { type: 'string' } } }),
          },
          {
            method: 'POST',
            path: '/users',
            responseSchema: JSON.stringify({ properties: { alsoRemoved: { type: 'string' } } }),
          },
        ],
      }),
      eventsJson: '[]',
    });
    const endpoints = store.getAllEndpoints();
    const postUsers = endpoints.find((e) => e.method === 'POST' && e.path === '/users')!;

    const diffs = detectBreakingChanges(store, postUsers);
    expect(diffs).toBeDefined();
    // Only the POST endpoint's own breaking change should show up.
    for (const d of diffs!) {
      expect(d.endpoint.method).toBe('POST');
    }
    expect(diffs!.some((d) => d.responseChanges.some((c) => c.path === 'alsoRemoved'))).toBe(true);
    expect(diffs!.some((d) => d.responseChanges.some((c) => c.path === 'removedField'))).toBe(
      false,
    );
  });
});

describe('resolveSymbolsAtLocation', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir('trace-mcp-symloc-');
    dbPath = path.join(tmpDir, 'repo-index.db');
    const db = initializeDatabase(dbPath);

    const fileId = db
      .prepare(`INSERT INTO files (path, language, indexed_at) VALUES (?, ?, ?)`)
      .run('src/users.ts', 'typescript', new Date().toISOString()).lastInsertRowid as number;

    // Outer function spanning lines 1-50.
    db.prepare(
      `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(fileId, 'sym-outer', 'handleRequest', 'function', 'handleRequest', 0, 500, 1, 50);

    // Inner (nested) function spanning lines 10-20 — smaller range, should
    // rank first when both match the same line.
    db.prepare(
      `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(fileId, 'sym-inner', 'validate', 'function', 'handleRequest.validate', 50, 150, 10, 20);

    // A symbol with no line_end (spans indefinitely — e.g. malformed/partial data).
    db.prepare(
      `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(fileId, 'sym-open-ended', 'globalConst', 'variable', 'globalConst', 600, 610, 60, null);

    db.close();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('returns [] when line is null', () => {
    expect(resolveSymbolsAtLocation(dbPath, 'src/users.ts', null)).toEqual([]);
  });

  it('returns the smallest enclosing symbol first when ranges overlap', () => {
    const results = resolveSymbolsAtLocation(dbPath, 'src/users.ts', 15);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].name).toBe('validate');
    expect(results.map((r) => r.name)).toContain('handleRequest');
  });

  it('returns only the outer symbol for a line outside the inner range', () => {
    const results = resolveSymbolsAtLocation(dbPath, 'src/users.ts', 30);
    expect(results.map((r) => r.name)).toEqual(['handleRequest']);
  });

  it('returns [] for a line outside every symbol range', () => {
    // Line 55 falls between the outer function's end (line 50) and the
    // open-ended symbol's start (line 60) — no symbol covers it.
    const results = resolveSymbolsAtLocation(dbPath, 'src/users.ts', 55);
    expect(results).toEqual([]);
  });

  it('matches symbols with a null line_end as open-ended (still enclosing)', () => {
    const results = resolveSymbolsAtLocation(dbPath, 'src/users.ts', 5000);
    expect(results.map((r) => r.name)).toContain('globalConst');
  });

  it('matches by file path suffix (LIKE %path)', () => {
    // resolveSymbolsAtLocation queries `f.path LIKE '%<filePath>'`, so a
    // relative path should match a file stored with a longer/absolute path.
    const results = resolveSymbolsAtLocation(dbPath, 'users.ts', 15);
    expect(results.map((r) => r.name)).toContain('validate');
  });

  it('returns [] when the db file does not exist (caught, not thrown)', () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.db');
    expect(() => resolveSymbolsAtLocation(missingPath, 'src/users.ts', 15)).not.toThrow();
    expect(resolveSymbolsAtLocation(missingPath, 'src/users.ts', 15)).toEqual([]);
  });

  it('returns symbolId/name/kind/fqn shape', () => {
    const results = resolveSymbolsAtLocation(dbPath, 'src/users.ts', 15);
    const inner = results.find((r) => r.name === 'validate')!;
    expect(inner).toEqual({
      symbolId: 'sym-inner',
      name: 'validate',
      kind: 'function',
      fqn: 'handleRequest.validate',
    });
  });
});
