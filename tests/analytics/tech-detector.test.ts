import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_PACKAGES } from '../../src/analytics/known-packages.js';
import { detectCoverage } from '../../src/analytics/tech-detector.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('tech-detector', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTmpDir('tech-detector-test-');
  });

  afterAll(() => {
    removeTmpDir(tmpDir);
  });

  describe('KNOWN_PACKAGES lookup', () => {
    it('finds direct match for known package', () => {
      const meta = KNOWN_PACKAGES['react'];
      expect(meta).toBeDefined();
      expect(meta.category).toBe('ui');
      expect(meta.priority).toBe('high');
      expect(meta.plugin).toBe('react');
    });

    it('finds scoped package', () => {
      const meta = KNOWN_PACKAGES['@nestjs/core'];
      expect(meta).toBeDefined();
      expect(meta.category).toBe('framework');
      expect(meta.plugin).toBe('nestjs');
    });

    it('returns undefined for unknown package', () => {
      expect(KNOWN_PACKAGES['some-unknown-package-xyz']).toBeUndefined();
    });

    it('has correct structure for all entries', () => {
      for (const [name, meta] of Object.entries(KNOWN_PACKAGES)) {
        expect(meta).toHaveProperty('category');
        expect(meta).toHaveProperty('priority');
        expect(meta).toHaveProperty('plugin');
        expect(['framework', 'orm', 'ui', 'testing', 'infra', 'utility']).toContain(meta.category);
        expect(['high', 'medium', 'low', 'none']).toContain(meta.priority);
      }
    });
  });

  describe('detectCoverage', () => {
    it('detects dependencies from a minimal package.json', () => {
      const projDir = path.join(tmpDir, 'proj-npm');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({
        name: 'test-project',
        dependencies: {
          'react': '^18.0.0',
          'express': '^4.18.0',
          'lodash': '^4.17.0',
        },
        devDependencies: {
          'vitest': '^1.0.0',
        },
      }));

      const report = detectCoverage(projDir);

      expect(report.project).toBe(projDir);
      expect(report.manifests_analyzed).toContain('package.json');

      // lodash is 'none' priority so not significant; vitest is devDep (excluded by default)
      // react and express are high priority with plugins
      expect(report.dependencies.length).toBeGreaterThanOrEqual(3);

      // Coverage structure
      expect(report.coverage).toHaveProperty('total_significant');
      expect(report.coverage).toHaveProperty('covered');
      expect(report.coverage).toHaveProperty('coverage_pct');
      expect(report.coverage.coverage_pct).toBeGreaterThanOrEqual(0);
      expect(report.coverage.coverage_pct).toBeLessThanOrEqual(100);

      // covered list
      const coveredNames = report.covered.map(c => c.name);
      expect(coveredNames).toContain('react');
      expect(coveredNames).toContain('express');

      // gaps
      expect(Array.isArray(report.gaps)).toBe(true);

      // unknown — lodash has 'none' priority and is in KNOWN_PACKAGES, so it
      // won't be in the unknown list (unknown = not in KNOWN_PACKAGES at all).
      expect(Array.isArray(report.unknown)).toBe(true);
    });

    it('includes devDependencies when includeDev is true', () => {
      const projDir = path.join(tmpDir, 'proj-dev');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({
        name: 'test-dev',
        dependencies: {},
        devDependencies: {
          'vitest': '^1.0.0',
        },
      }));

      const withoutDev = detectCoverage(projDir);
      const withDev = detectCoverage(projDir, { includeDev: true });

      expect(withDev.dependencies.length).toBeGreaterThan(withoutDev.dependencies.length);
    });

    it('returns empty report for project with no manifests', () => {
      const emptyDir = path.join(tmpDir, 'proj-empty');
      fs.mkdirSync(emptyDir, { recursive: true });

      const report = detectCoverage(emptyDir);
      expect(report.manifests_analyzed).toEqual([]);
      expect(report.dependencies).toEqual([]);
      expect(report.coverage.coverage_pct).toBe(100); // 0 significant => 100%
    });

    it('identifies unknown packages', () => {
      const projDir = path.join(tmpDir, 'proj-unknown');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({
        name: 'test-unknown',
        dependencies: {
          'my-custom-internal-lib': '^1.0.0',
        },
      }));

      const report = detectCoverage(projDir);
      const unknownNames = report.unknown.map(u => u.name);
      expect(unknownNames).toContain('my-custom-internal-lib');
    });
  });
});
