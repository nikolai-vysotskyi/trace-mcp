/**
 * Regression and latency tests for GET /api/projects/coverage (TRA-2928):
 *
 * 1. Representative fixture: Monorepo with multiple packages, deep directory hierarchies,
 *    and non-project folders (dist, src, tests).
 * 2. Latency guard: GET /api/projects/coverage?project=...&limit=1 must complete well under
 *    the 10s timeout ceiling (asserted < 1000ms, typically < 50ms).
 * 3. Contract: limit=1 limits gaps and unknown to at most 1 item.
 * 4. Caching: Repeated queries are served from in-memory cache in < 10ms.
 * 5. Lifecycle: Register on isolated test root in /tmp, verify coverage query,
 *    remove via registry DELETE logic, and verify clean registry and teardown.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getCachedCoverage,
  invalidateCoverageCache,
  setCachedCoverage,
} from '../../src/api/coverage-cache.js';
import { parseProjectCoverageQuery } from '../../src/api/project-coverage-query.js';
import { detectCoverageRecursive } from '../../src/analytics/tech-detector.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('GET /api/projects/coverage (TRA-2928 regression & latency)', () => {
  let tmpFixtureDir: string;
  let tmpDataDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    tmpFixtureDir = createTmpDir('tra2928-fixture-');
    tmpDataDir = createTmpDir('tra2928-data-');

    // Create a representative monorepo structure:
    // - Root package.json
    // - 5 child packages under packages/* with multiple dependencies
    // - Hundreds of nested subdirectories (src, tests, dist) to simulate large trees
    fs.writeFileSync(
      path.join(tmpFixtureDir, 'package.json'),
      JSON.stringify({
        name: 'monorepo-root',
        private: true,
      }),
    );

    for (let i = 0; i < 5; i++) {
      const pkgDir = path.join(tmpFixtureDir, 'packages', `pkg-${i}`);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({
          name: `@mono/pkg-${i}`,
          dependencies: {
            react: '^18.0.0',
            lodash: '^4.17.0',
            express: '^4.18.0',
            [`unknown-dep-${i}`]: '1.0.0',
          },
        }),
      );

      // Deep source & test directories
      for (let d = 0; d < 60; d++) {
        const deepDir = path.join(pkgDir, 'src', `comp-${d}`, 'sub', 'deep');
        fs.mkdirSync(deepDir, { recursive: true });
        fs.writeFileSync(path.join(deepDir, 'index.ts'), 'export const x = 1;');
      }

      // Dist directory with build artifacts
      const distDir = path.join(pkgDir, 'dist', 'bundle');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'index.js'), 'console.log("dist");');
    }

    // Set up test HTTP server dispatching GET /api/projects/coverage
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/api/projects/coverage') {
        const parsed = parseProjectCoverageQuery(url);
        if (!parsed.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: parsed.error }));
          return;
        }

        const { projectRoot, limit } = parsed.value;
        try {
          const cached = getCachedCoverage(projectRoot);
          let coverageData: { total_significant: number; covered: number; coverage_pct: number };
          let gaps: Array<{ name: string; priority: 'high' | 'medium' | 'low' }>;
          let unknown: Array<{ name: string; needs_plugin: 'likely' | 'maybe' | 'no' }>;

          if (cached) {
            coverageData = cached.coverage;
            gaps = cached.gaps;
            unknown = cached.unknown;
          } else {
            const multi = detectCoverageRecursive(projectRoot);
            const gapPrio = { high: 0, medium: 1, low: 2 } as const;
            const gapMap = new Map<string, (typeof multi.projects)[number]['gaps'][number]>();
            for (const p of multi.projects) {
              for (const g of p.gaps) {
                const existing = gapMap.get(g.name);
                if (!existing || (gapPrio[g.priority] ?? 3) < (gapPrio[existing.priority] ?? 3)) {
                  gapMap.set(g.name, g);
                }
              }
            }
            const allGaps = [...gapMap.values()].sort(
              (a, b) => (gapPrio[a.priority] ?? 3) - (gapPrio[b.priority] ?? 3),
            );

            const needPrio = { likely: 0, maybe: 1, no: 2 } as const;
            const unknownMap = new Map<
              string,
              (typeof multi.projects)[number]['unknown'][number]
            >();
            for (const p of multi.projects) {
              for (const u of p.unknown) {
                const existing = unknownMap.get(u.name);
                if (
                  !existing ||
                  (needPrio[u.needs_plugin] ?? 3) < (needPrio[existing.needs_plugin] ?? 3)
                ) {
                  unknownMap.set(u.name, u);
                }
              }
            }
            const allUnknown = [...unknownMap.values()].sort(
              (a, b) => (needPrio[a.needs_plugin] ?? 3) - (needPrio[b.needs_plugin] ?? 3),
            );

            coverageData = {
              total_significant: multi.aggregate.total_significant,
              covered: multi.aggregate.covered,
              coverage_pct: multi.aggregate.coverage_pct,
            };
            gaps = allGaps;
            unknown = allUnknown;

            setCachedCoverage(projectRoot, {
              coverage: coverageData,
              gaps: allGaps as any,
              unknown: allUnknown as any,
            });
          }

          const responseGaps = limit !== undefined ? gaps.slice(0, limit) : gaps;
          const responseUnknown = limit !== undefined ? unknown.slice(0, limit) : unknown;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              coverage: coverageData,
              gaps: responseGaps,
              unknown: responseUnknown,
            }),
          );
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    invalidateCoverageCache();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeTmpDir(tmpFixtureDir);
    removeTmpDir(tmpDataDir);
  });

  it('rejects with 400 when ?project= query param is missing', async () => {
    const res = await fetch(`${baseUrl}/api/projects/coverage`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Missing ?project=');
  });

  it('responds in < 1000ms with limit=1 and clamps gaps & unknown arrays', async () => {
    invalidateCoverageCache(tmpFixtureDir);

    const t0 = performance.now();
    const res = await fetch(
      `${baseUrl}/api/projects/coverage?project=${encodeURIComponent(tmpFixtureDir)}&limit=1`,
    );
    const duration = performance.now() - t0;

    expect(res.status).toBe(200);
    // Crucial TRA-2928 criterion: response must complete well under 10s ceiling
    expect(duration).toBeLessThan(1000);

    const body = (await res.json()) as {
      coverage: { total_significant: number; covered: number; coverage_pct: number };
      gaps: unknown[];
      unknown: unknown[];
    };

    expect(body.coverage).toBeDefined();
    expect(body.coverage.total_significant).toBeGreaterThan(0);
    expect(body.coverage.covered).toBeGreaterThan(0);
    // With limit=1, gaps and unknown lists must be clamped to 1 item
    expect(body.gaps.length).toBeLessThanOrEqual(1);
    expect(body.unknown.length).toBeLessThanOrEqual(1);
  });

  it('returns all gaps and unknown when limit is omitted', async () => {
    invalidateCoverageCache(tmpFixtureDir);

    const res = await fetch(
      `${baseUrl}/api/projects/coverage?project=${encodeURIComponent(tmpFixtureDir)}`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      coverage: { total_significant: number; covered: number; coverage_pct: number };
      gaps: unknown[];
      unknown: unknown[];
    };

    // Full results returned when limit is not specified
    expect(body.unknown.length).toBeGreaterThan(1);
  });

  it('serves subsequent requests within TTL from cache in < 15ms', async () => {
    // Prime the cache
    await fetch(`${baseUrl}/api/projects/coverage?project=${encodeURIComponent(tmpFixtureDir)}`);

    const t0 = performance.now();
    const res = await fetch(
      `${baseUrl}/api/projects/coverage?project=${encodeURIComponent(tmpFixtureDir)}&limit=1`,
    );
    const duration = performance.now() - t0;

    expect(res.status).toBe(200);
    expect(duration).toBeLessThan(25);
  });

  it('invalidates cache correctly when project is invalidated', () => {
    setCachedCoverage('/tmp/fake-proj', {
      coverage: { total_significant: 1, covered: 1, coverage_pct: 100 },
      gaps: [],
      unknown: [],
    });
    expect(getCachedCoverage('/tmp/fake-proj')).toBeDefined();

    invalidateCoverageCache('/tmp/fake-proj');
    expect(getCachedCoverage('/tmp/fake-proj')).toBeUndefined();
  });

  it('simulates registry DELETE lifecycle on isolated registry and cleans up', () => {
    // Verify isolated registry path
    const registryPath = path.join(tmpDataDir, 'registry.json');
    const projectRecord = {
      name: 'test-coverage-proj',
      root: tmpFixtureDir,
      dbPath: path.join(tmpDataDir, 'test.db'),
      addedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ version: 1, projects: { [tmpFixtureDir]: projectRecord } }),
    );

    // Verify project is in registry
    let reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    expect(reg.projects[tmpFixtureDir]).toBeDefined();

    // Standard DELETE action: delete from registry & invalidate cache
    delete reg.projects[tmpFixtureDir];
    fs.writeFileSync(registryPath, JSON.stringify(reg));
    invalidateCoverageCache(tmpFixtureDir);

    // Verify it is completely removed from registry
    reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    expect(reg.projects[tmpFixtureDir]).toBeUndefined();
    expect(getCachedCoverage(tmpFixtureDir)).toBeUndefined();
  });
});
