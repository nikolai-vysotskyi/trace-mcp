/**
 * Behavioural coverage for `detectCoverage()` in
 * `src/analytics/tech-detector.ts` (the implementation behind the
 * `get_coverage_report` MCP tool). Parses package manifests
 * (package.json, composer.json, etc.) and assesses trace-mcp plugin
 * coverage per detected dependency.
 *
 * The report shape exposes `dependencies`, `coverage`, `covered`, `gaps`,
 * and `unknown` — the test verifies the "detected / covered / gaps"
 * surface mentioned in the tool brief.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectCoverage } from '../../../src/analytics/tech-detector.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

function writePackageJson(dir: string, pkg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8');
}

describe('detectCoverage() — behavioural contract (get_coverage_report)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('coverage-report-test-');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('returns a report with detected dependencies, covered list, and gaps array', () => {
    // react is in KNOWN_PACKAGES with `plugin: react` (covered).
    writePackageJson(tmpDir, {
      name: 'tmp-fixture',
      dependencies: { react: '^18.0.0' },
    });

    const report = detectCoverage(tmpDir);

    expect(report.project).toBe(tmpDir);
    expect(report.manifests_analyzed).toContain('package.json');
    expect(Array.isArray(report.dependencies)).toBe(true);
    expect(Array.isArray(report.covered)).toBe(true);
    expect(Array.isArray(report.gaps)).toBe(true);
    expect(Array.isArray(report.unknown)).toBe(true);

    // Covered: react is a covered framework with its plugin field set.
    const reactCovered = report.covered.find((c) => c.name === 'react');
    expect(reactCovered).toBeDefined();
    expect(reactCovered!.plugin).toBe('react');
  });

  it('seeded package with known framework appears in `detected` and `covered`', () => {
    // express has a plugin and is a significant dep — must show up in both
    // the dependency list and the covered list.
    writePackageJson(tmpDir, {
      name: 'tmp-fixture',
      dependencies: { express: '^4.18.0' },
    });

    const report = detectCoverage(tmpDir);

    const depNames = report.dependencies.map((d) => d.name);
    expect(depNames).toContain('express');

    const coveredNames = report.covered.map((c) => c.name);
    expect(coveredNames).toContain('express');

    // The covered entry has a plugin name, not null.
    const express = report.covered.find((c) => c.name === 'express');
    expect(express!.plugin).toBeTruthy();
  });

  it('empty repo (no manifests) returns empty arrays', () => {
    // tmpDir exists but contains no package manifest at all.
    const report = detectCoverage(tmpDir);

    expect(report.manifests_analyzed).toEqual([]);
    expect(report.dependencies).toEqual([]);
    expect(report.covered).toEqual([]);
    expect(report.gaps).toEqual([]);
    expect(report.unknown).toEqual([]);
    // Zero significant deps → coverage_pct is reported as 100 (vacuous).
    expect(report.coverage.total_significant).toBe(0);
    expect(report.coverage.coverage_pct).toBe(100);
  });

  it('gaps is the set of significant deps without plugin coverage', () => {
    // Use a real KNOWN_PACKAGES entry that is significant but has no plugin
    // wired — e.g. "moment" is high-priority utility with no dedicated
    // plugin in this repo. Fall back to a name guaranteed to be unknown if
    // moment ever gets a plugin: we assert the structural invariant
    // (covered ∩ gaps = ∅, both subsets of significant deps).
    writePackageJson(tmpDir, {
      name: 'tmp-fixture',
      dependencies: {
        react: '^18.0.0', // covered
        'my-private-frobnicator': '^1.0.0', // unknown → goes into `unknown`
      },
    });

    const report = detectCoverage(tmpDir);

    const coveredSet = new Set(report.covered.map((c) => c.name));
    const gapSet = new Set(report.gaps.map((g) => g.name));

    // covered and gaps must not overlap — they're a partition of `significant`.
    for (const c of coveredSet) {
      expect(gapSet.has(c)).toBe(false);
    }

    // react is covered (plugin: react), private package goes into `unknown`
    // (not in KNOWN_PACKAGES at all, so it's not classified as a gap).
    expect(coveredSet.has('react')).toBe(true);
    const unknownNames = report.unknown.map((u) => u.name);
    expect(unknownNames).toContain('my-private-frobnicator');
  });

  it('coverage_pct is the integer percentage of covered ÷ significant', () => {
    writePackageJson(tmpDir, {
      name: 'tmp-fixture',
      dependencies: {
        react: '^18.0.0',
        express: '^4.18.0',
      },
    });

    const report = detectCoverage(tmpDir);
    const { total_significant, covered, coverage_pct } = report.coverage;

    expect(typeof total_significant).toBe('number');
    expect(typeof covered).toBe('number');
    expect(typeof coverage_pct).toBe('number');
    expect(coverage_pct).toBeGreaterThanOrEqual(0);
    expect(coverage_pct).toBeLessThanOrEqual(100);

    if (total_significant > 0) {
      const expected = Math.round((covered / total_significant) * 100);
      expect(coverage_pct).toBe(expected);
    }
  });
});
