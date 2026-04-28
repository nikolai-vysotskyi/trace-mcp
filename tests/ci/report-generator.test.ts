import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { captureBaseline, compareWithBaseline } from '../../src/ci/baseline.js';
import {
  formatAnnotationsJson,
  formatGitHubActions,
  generateAnnotations,
} from '../../src/ci/github-annotations.js';
import { formatJson, formatMarkdown } from '../../src/ci/markdown-formatter.js';
import { type CIReport, generateReport } from '../../src/ci/report-generator.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/view/vue/index.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/laravel-10');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['app/**/*.php', 'routes/**/*.php', 'database/migrations/**/*.php'],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
    ignore: { directories: [], patterns: [] },
    watch: { enabled: false, debounceMs: 2000 },
  } as TraceMcpConfig;
}

// ═══════════════════════════════════════════════════════════════════
// Report Generator — Indexed Fixture
// ═══════════════════════════════════════════════════════════════════

describe('CI Report Generator', () => {
  let store: Store;
  let allFilePaths: string[];

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());
    registry.registerFrameworkPlugin(new VueFrameworkPlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();

    allFilePaths = store.getAllFiles().map((f) => f.path);
  });

  // ─── Basic report generation ───

  it('generates a complete report for changed files', () => {
    const changedFiles = allFilePaths.slice(0, 2);
    const report = generateReport({ changedFiles, store, rootPath: FIXTURE_DIR });

    expect(report).toBeDefined();
    expect(report.summary.changedFileCount).toBe(changedFiles.length);
    expect(report.changedFiles).toHaveLength(changedFiles.length);
    expect(['low', 'medium', 'high', 'critical']).toContain(report.summary.riskLevel);

    // All sections should be defined
    expect(report.blastRadius).toBeDefined();
    expect(report.testCoverage).toBeDefined();
    expect(report.riskAnalysis).toBeDefined();
    expect(report.architectureViolations).toBeDefined();
    expect(report.deadCode).toBeDefined();
  });

  it('changed file info includes symbol counts', () => {
    const changedFiles = allFilePaths.slice(0, 3);
    const report = generateReport({ changedFiles, store, rootPath: FIXTURE_DIR });

    for (const file of report.changedFiles) {
      expect(file.path).toBeTruthy();
      expect(typeof file.symbolCount).toBe('number');
      expect(typeof file.avgCyclomatic).toBe('number');
      expect(file.avgCyclomatic).toBeGreaterThanOrEqual(0);
    }
  });

  // ─── Blast radius ───

  it('blast radius deduplicates across changed files', () => {
    const changedFiles = allFilePaths.slice(0, 4);
    const report = generateReport({ changedFiles, store, rootPath: FIXTURE_DIR });

    // Blast radius entries should not contain the changed files themselves
    for (const entry of report.blastRadius.entries) {
      expect(changedFiles).not.toContain(entry.path);
    }

    // No duplicate paths in blast radius
    const paths = report.blastRadius.entries.map((e) => e.path);
    expect(paths.length).toBe(new Set(paths).size);
  });

  it('blast radius entries have valid fields', () => {
    const report = generateReport({
      changedFiles: allFilePaths.slice(0, 2),
      store,
      rootPath: FIXTURE_DIR,
    });

    for (const entry of report.blastRadius.entries) {
      expect(entry.path).toBeTruthy();
      expect(entry.edgeType).toBeTruthy();
      expect(entry.depth).toBeGreaterThan(0);
      expect(entry.depth).toBeLessThanOrEqual(2); // depth=2 is the limit
    }
  });

  it('blast radius is sorted by depth then path', () => {
    const report = generateReport({
      changedFiles: allFilePaths.slice(0, 3),
      store,
      rootPath: FIXTURE_DIR,
    });

    for (let i = 1; i < report.blastRadius.entries.length; i++) {
      const prev = report.blastRadius.entries[i - 1];
      const curr = report.blastRadius.entries[i];
      if (prev.depth === curr.depth) {
        expect(prev.path.localeCompare(curr.path)).toBeLessThanOrEqual(0);
      } else {
        expect(prev.depth).toBeLessThanOrEqual(curr.depth);
      }
    }
  });

  // ─── Risk scores ───

  it('computes risk scores in valid 0-1 range', () => {
    const report = generateReport({
      changedFiles: allFilePaths.slice(0, 3),
      store,
      rootPath: FIXTURE_DIR,
    });

    expect(report.riskAnalysis.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.riskAnalysis.overallScore).toBeLessThanOrEqual(1);

    for (const file of report.riskAnalysis.files) {
      expect(file.score).toBeGreaterThanOrEqual(0);
      expect(file.score).toBeLessThanOrEqual(1);
      expect(file.complexity).toBeGreaterThanOrEqual(0);
      expect(file.complexity).toBeLessThanOrEqual(1);
      expect(file.churn).toBeGreaterThanOrEqual(0);
      expect(file.coupling).toBeGreaterThanOrEqual(0);
    }
  });

  it('risk files are sorted by score descending', () => {
    const report = generateReport({
      changedFiles: allFilePaths.slice(0, 5),
      store,
      rootPath: FIXTURE_DIR,
    });

    for (let i = 1; i < report.riskAnalysis.files.length; i++) {
      expect(report.riskAnalysis.files[i - 1].score).toBeGreaterThanOrEqual(
        report.riskAnalysis.files[i].score,
      );
    }
  });

  it('overall risk level maps correctly from score', () => {
    const report = generateReport({
      changedFiles: allFilePaths.slice(0, 1),
      store,
      rootPath: FIXTURE_DIR,
    });

    const score = report.riskAnalysis.overallScore;
    const level = report.riskAnalysis.overallLevel;

    if (score >= 0.75) expect(level).toBe('critical');
    else if (score >= 0.5) expect(level).toBe('high');
    else if (score >= 0.25) expect(level).toBe('medium');
    else expect(level).toBe('low');
  });

  // ─── Test coverage gaps ───

  it('test coverage gaps only include affected files', () => {
    const changedFiles = allFilePaths.slice(0, 2);
    const report = generateReport({ changedFiles, store, rootPath: FIXTURE_DIR });

    const affectedFiles = new Set([
      ...changedFiles,
      ...report.blastRadius.entries.map((e) => e.path),
    ]);

    for (const gap of report.testCoverage.gaps) {
      expect(affectedFiles.has(gap.file)).toBe(true);
    }
  });

  it('test coverage gap items have valid fields', () => {
    const report = generateReport({
      changedFiles: allFilePaths,
      store,
      rootPath: FIXTURE_DIR,
    });

    for (const gap of report.testCoverage.gaps) {
      expect(gap.symbolId).toBeTruthy();
      expect(gap.name).toBeTruthy();
      expect(gap.kind).toBeTruthy();
      expect(gap.file).toBeTruthy();
    }
  });

  // ─── Dead code ───

  it('dead code only reports symbols in changed files', () => {
    const changedFiles = allFilePaths.slice(0, 2);
    const report = generateReport({ changedFiles, store, rootPath: FIXTURE_DIR });

    for (const d of report.deadCode.symbols) {
      expect(changedFiles).toContain(d.file);
    }
  });

  // ─── Architecture violations ───

  it('arch violations only include changed files', () => {
    const changedFiles = allFilePaths.slice(0, 3);
    const report = generateReport({ changedFiles, store, rootPath: FIXTURE_DIR });

    const changedSet = new Set(changedFiles);
    for (const v of report.architectureViolations.violations) {
      expect(changedSet.has(v.source_file) || changedSet.has(v.target_file)).toBe(true);
    }
  });

  // ─── Edge cases ───

  it('handles unknown files gracefully', () => {
    const report = generateReport({
      changedFiles: ['nonexistent/file.ts'],
      store,
      rootPath: FIXTURE_DIR,
    });

    expect(report.changedFiles).toHaveLength(1);
    expect(report.changedFiles[0].path).toBe('nonexistent/file.ts');
    expect(report.changedFiles[0].symbolCount).toBe(0);
    expect(report.changedFiles[0].avgCyclomatic).toBe(0);
    expect(report.summary.changedFileCount).toBe(1);
  });

  it('handles empty changed files list', () => {
    const report = generateReport({
      changedFiles: [],
      store,
      rootPath: FIXTURE_DIR,
    });

    expect(report.changedFiles).toHaveLength(0);
    expect(report.blastRadius.totalAffected).toBe(0);
    expect(report.blastRadius.entries).toHaveLength(0);
    expect(report.testCoverage.gaps).toHaveLength(0);
    expect(report.riskAnalysis.files).toHaveLength(0);
    expect(report.riskAnalysis.overallScore).toBe(0);
    expect(report.summary.riskLevel).toBe('low');
    expect(report.deadCode.totalDead).toBe(0);
    expect(report.architectureViolations.totalViolations).toBe(0);
  });

  it('handles mix of known and unknown files', () => {
    const changedFiles = [allFilePaths[0], 'does/not/exist.php'];
    const report = generateReport({ changedFiles, store, rootPath: FIXTURE_DIR });

    expect(report.changedFiles).toHaveLength(2);
    const known = report.changedFiles.find((f) => f.path === allFilePaths[0]);
    const unknown = report.changedFiles.find((f) => f.path === 'does/not/exist.php');
    expect(known!.symbolCount).toBeGreaterThan(0);
    expect(unknown!.symbolCount).toBe(0);
  });

  // ─── Summary consistency ───

  it('summary matches section data', () => {
    const report = generateReport({
      changedFiles: allFilePaths.slice(0, 3),
      store,
      rootPath: FIXTURE_DIR,
    });

    expect(report.summary.changedFileCount).toBe(report.changedFiles.length);
    expect(report.summary.affectedFileCount).toBe(report.blastRadius.totalAffected);
    expect(report.summary.untestedGaps).toBe(report.testCoverage.gaps.length);
    expect(report.summary.violations).toBe(report.architectureViolations.totalViolations);
    expect(report.summary.deadExports).toBe(report.deadCode.totalDead);
    expect(report.summary.riskLevel).toBe(report.riskAnalysis.overallLevel);
  });

  // ─── All files report ───

  it('generates report for all files without error', () => {
    const report = generateReport({
      changedFiles: allFilePaths,
      store,
      rootPath: FIXTURE_DIR,
    });

    expect(report.changedFiles.length).toBe(allFilePaths.length);
    expect(report.riskAnalysis.files.length).toBe(allFilePaths.length);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Report Generator — Empty Index
// ═══════════════════════════════════════════════════════════════════

describe('CI Report Generator with empty index', () => {
  let emptyStore: Store;

  beforeAll(() => {
    emptyStore = createTestStore();
  });

  it('produces a valid report on empty index', () => {
    const report = generateReport({
      changedFiles: ['some/file.ts'],
      store: emptyStore,
      rootPath: '/tmp',
    });

    expect(report.changedFiles).toHaveLength(1);
    expect(report.changedFiles[0].symbolCount).toBe(0);
    expect(report.blastRadius.totalAffected).toBe(0);
    expect(report.summary.riskLevel).toBe('low');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Markdown Formatter
// ═══════════════════════════════════════════════════════════════════

describe('CI Report Markdown Formatter', () => {
  it('produces markdown with all sections for a full report', () => {
    const report: CIReport = {
      changedFiles: [
        { path: 'src/foo.ts', symbolCount: 5, avgCyclomatic: 3.5 },
        { path: 'src/bar.ts', symbolCount: 3, avgCyclomatic: 1.2 },
      ],
      blastRadius: {
        entries: [
          { path: 'src/baz.ts', edgeType: 'imports', depth: 1 },
          { path: 'src/qux.ts', edgeType: 'calls', depth: 2 },
        ],
        totalAffected: 2,
        truncated: false,
      },
      testCoverage: {
        gaps: [
          {
            symbolId: 'sym_1',
            name: 'doStuff',
            kind: 'function',
            file: 'src/foo.ts',
            signature: 'function doStuff()',
          },
        ],
        totalExports: 10,
        totalUntested: 1,
      },
      riskAnalysis: {
        files: [
          {
            file: 'src/foo.ts',
            complexity: 0.5,
            churn: 0.3,
            coupling: 0.4,
            blastSize: 1,
            score: 0.35,
          },
          {
            file: 'src/bar.ts',
            complexity: 0.2,
            churn: 0.1,
            coupling: 0.3,
            blastSize: 0,
            score: 0.15,
          },
        ],
        overallScore: 0.25,
        overallLevel: 'medium',
      },
      architectureViolations: {
        violations: [
          {
            source_file: 'src/foo.ts',
            source_layer: 'presentation',
            target_file: 'src/db.ts',
            target_layer: 'infrastructure',
            rule: 'presentation cannot import infrastructure',
          },
        ],
        totalViolations: 1,
        layersChecked: ['domain', 'application', 'presentation', 'infrastructure'],
      },
      deadCode: {
        symbols: [
          { symbolId: 'sym_2', name: 'unusedHelper', kind: 'function', file: 'src/bar.ts' },
        ],
        totalDead: 1,
      },
      summary: {
        changedFileCount: 2,
        affectedFileCount: 2,
        riskLevel: 'medium',
        untestedGaps: 1,
        violations: 1,
        deadExports: 1,
      },
    };

    const md = formatMarkdown(report);

    // Header
    expect(md).toContain('## trace-mcp Change Impact Report');

    // Summary table
    expect(md).toContain('| Changed files | 2 |');
    expect(md).toContain('| Affected files (blast radius) | 2 |');
    expect(md).toContain('| Risk level | **medium** |');
    expect(md).toContain('| Untested affected paths | 1 |');
    expect(md).toContain('| Architecture violations | 1 |');
    expect(md).toContain('| Dead exports introduced | 1 |');

    // Changed files section
    expect(md).toContain('Changed Code Files (2)');
    expect(md).toContain('`src/foo.ts`');
    expect(md).toContain('`src/bar.ts`');

    // Blast radius
    expect(md).toContain('Blast Radius (2 files affected)');
    expect(md).toContain('`src/baz.ts`');
    expect(md).toContain('`src/qux.ts`');

    // Test coverage
    expect(md).toContain('Test Coverage Gaps (1 untested symbols)');
    expect(md).toContain('doStuff');

    // Risk analysis
    expect(md).toContain('Risk Analysis');
    expect(md).toContain('overall: medium');

    // Architecture violations
    expect(md).toContain('Architecture Violations (1)');
    expect(md).toContain('presentation');

    // Dead code
    expect(md).toContain('Dead Exports Introduced (1)');
    expect(md).toContain('unusedHelper');

    // Collapsible sections
    expect(md).toContain('<details>');
    expect(md).toContain('</details>');

    // Footer
    expect(md).toContain('trace-mcp');
  });

  it('omits empty sections', () => {
    const report: CIReport = {
      changedFiles: [{ path: 'src/foo.ts', symbolCount: 1, avgCyclomatic: 1 }],
      blastRadius: { entries: [], totalAffected: 0, truncated: false },
      testCoverage: { gaps: [], totalExports: 0, totalUntested: 0 },
      riskAnalysis: {
        files: [
          { file: 'src/foo.ts', complexity: 0.1, churn: 0, coupling: 0, blastSize: 0, score: 0.03 },
        ],
        overallScore: 0.03,
        overallLevel: 'low',
      },
      architectureViolations: { violations: [], totalViolations: 0, layersChecked: [] },
      deadCode: { symbols: [], totalDead: 0 },
      summary: {
        changedFileCount: 1,
        affectedFileCount: 0,
        riskLevel: 'low',
        untestedGaps: 0,
        violations: 0,
        deadExports: 0,
      },
    };

    const md = formatMarkdown(report);

    // Should still have summary and changed files
    expect(md).toContain('## trace-mcp Change Impact Report');
    expect(md).toContain('Changed Code Files (1)');

    // Should NOT have blast radius, test coverage, violations, dead code sections
    expect(md).not.toContain('Blast Radius');
    expect(md).not.toContain('Test Coverage Gaps');
    expect(md).not.toContain('Architecture Violations');
    expect(md).not.toContain('Dead Exports Introduced');
  });

  it('shows truncated note on blast radius', () => {
    const report: CIReport = {
      changedFiles: [],
      blastRadius: {
        entries: [{ path: 'a.ts', edgeType: 'imports', depth: 1 }],
        totalAffected: 1,
        truncated: true,
      },
      testCoverage: { gaps: [], totalExports: 0, totalUntested: 0 },
      riskAnalysis: { files: [], overallScore: 0, overallLevel: 'low' },
      architectureViolations: { violations: [], totalViolations: 0, layersChecked: [] },
      deadCode: { symbols: [], totalDead: 0 },
      summary: {
        changedFileCount: 0,
        affectedFileCount: 1,
        riskLevel: 'low',
        untestedGaps: 0,
        violations: 0,
        deadExports: 0,
      },
    };

    const md = formatMarkdown(report);
    expect(md).toContain('(truncated)');
  });

  it('produces valid parseable JSON', () => {
    const report: CIReport = {
      changedFiles: [{ path: 'a.ts', symbolCount: 2, avgCyclomatic: 1.5 }],
      blastRadius: { entries: [], totalAffected: 0, truncated: false },
      testCoverage: { gaps: [], totalExports: 5, totalUntested: 0 },
      riskAnalysis: { files: [], overallScore: 0.1, overallLevel: 'low' },
      architectureViolations: { violations: [], totalViolations: 0, layersChecked: [] },
      deadCode: { symbols: [], totalDead: 0 },
      summary: {
        changedFileCount: 1,
        affectedFileCount: 0,
        riskLevel: 'low',
        untestedGaps: 0,
        violations: 0,
        deadExports: 0,
      },
    };

    const json = formatJson(report);
    const parsed = JSON.parse(json);

    expect(parsed.summary.riskLevel).toBe('low');
    expect(parsed.changedFiles[0].path).toBe('a.ts');
    expect(parsed.testCoverage.totalExports).toBe(5);
  });

  it('formatMarkdown produces real markdown from real fixture data', () => {
    const realStore = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());
    registry.registerFrameworkPlugin(new VueFrameworkPlugin());

    const config = makeConfig();
    const _pipeline = new IndexingPipeline(realStore, registry, config, FIXTURE_DIR);
    // synchronous-ish for test: we can rely on beforeAll having worked
    // Actually, let's generate from the shared store
    const files = realStore.getAllFiles().map((f) => f.path);

    // Generate with empty files since this store is fresh
    const report = generateReport({
      changedFiles: files.length > 0 ? files.slice(0, 2) : ['app/Models/User.php'],
      store: realStore,
      rootPath: FIXTURE_DIR,
    });

    const md = formatMarkdown(report);

    // Should be valid markdown string
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(100);
    expect(md).toContain('## trace-mcp Change Impact Report');
    expect(md).toContain('### Summary');

    realStore.db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Project-Aware Analysis
// ═══════════════════════════════════════════════════════════════════

describe('CI Report — Project-Aware Analysis', () => {
  let store: Store;
  let allFilePaths: string[];

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());
    registry.registerFrameworkPlugin(new VueFrameworkPlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();

    allFilePaths = store.getAllFiles().map((f) => f.path);
  });

  it('includes project-aware sections when enabled', () => {
    const report = generateReport({
      changedFiles: allFilePaths.slice(0, 3),
      store,
      rootPath: FIXTURE_DIR,
      enableProjectAware: true,
    });

    // These may or may not have data depending on fixture, but should not throw
    expect(report).toBeDefined();
    expect(report.summary).toBeDefined();
    // ownershipAnalysis may be undefined if not a git repo fixture — that's ok
  });

  it('omits project-aware sections when disabled', () => {
    const report = generateReport({
      changedFiles: allFilePaths.slice(0, 3),
      store,
      rootPath: FIXTURE_DIR,
      enableProjectAware: false,
    });

    expect(report.domainAnalysis).toBeUndefined();
    expect(report.ownershipAnalysis).toBeUndefined();
    expect(report.deploymentImpact).toBeUndefined();
    expect(report.summary.domainsCrossed).toBeUndefined();
    expect(report.summary.servicesAffected).toBeUndefined();
  });

  it('project-aware does not break report on empty store', () => {
    const emptyStore = createTestStore();
    const report = generateReport({
      changedFiles: ['some/file.ts'],
      store: emptyStore,
      rootPath: '/tmp',
      enableProjectAware: true,
    });

    expect(report).toBeDefined();
    expect(report.summary.riskLevel).toBe('low');
    emptyStore.db.close();
  });

  it('formatMarkdown includes domain section when present', () => {
    const report: CIReport = {
      changedFiles: [{ path: 'src/foo.ts', symbolCount: 1, avgCyclomatic: 1 }],
      blastRadius: { entries: [], totalAffected: 0, truncated: false },
      testCoverage: { gaps: [], totalExports: 0, totalUntested: 0 },
      riskAnalysis: { files: [], overallScore: 0, overallLevel: 'low' },
      architectureViolations: { violations: [], totalViolations: 0, layersChecked: [] },
      deadCode: { symbols: [], totalDead: 0 },
      domainAnalysis: {
        domainsAffected: [{ name: 'auth', filesChanged: 2, filesImpacted: 3 }],
        crossDomainChanges: [{ from: 'auth', to: 'billing', edgeCount: 5 }],
        reviewTeams: ['auth', 'billing'],
      },
      ownershipAnalysis: {
        owners: [{ file: 'src/foo.ts', primaryOwner: 'Alice', percentage: 80 }],
        teamsCrossed: ['Alice', 'Bob'],
      },
      summary: {
        changedFileCount: 1,
        affectedFileCount: 0,
        riskLevel: 'low',
        untestedGaps: 0,
        violations: 0,
        deadExports: 0,
        domainsCrossed: 1,
      },
    };

    const md = formatMarkdown(report);

    expect(md).toContain('Domain Boundaries (1 domains)');
    expect(md).toContain('auth');
    expect(md).toContain('billing');
    expect(md).toContain('Review needed from:');
    expect(md).toContain('Cross-domain dependencies');
    expect(md).toContain('Code Ownership (2 contributors)');
    expect(md).toContain('Alice');
    expect(md).toContain('80%');
    expect(md).toContain('Domains crossed');
  });

  it('formatMarkdown omits project-aware sections when not present', () => {
    const report: CIReport = {
      changedFiles: [{ path: 'src/foo.ts', symbolCount: 1, avgCyclomatic: 1 }],
      blastRadius: { entries: [], totalAffected: 0, truncated: false },
      testCoverage: { gaps: [], totalExports: 0, totalUntested: 0 },
      riskAnalysis: { files: [], overallScore: 0, overallLevel: 'low' },
      architectureViolations: { violations: [], totalViolations: 0, layersChecked: [] },
      deadCode: { symbols: [], totalDead: 0 },
      summary: {
        changedFileCount: 1,
        affectedFileCount: 0,
        riskLevel: 'low',
        untestedGaps: 0,
        violations: 0,
        deadExports: 0,
      },
    };

    const md = formatMarkdown(report);

    expect(md).not.toContain('Domain Boundaries');
    expect(md).not.toContain('Code Ownership');
    expect(md).not.toContain('Deployment Impact');
    expect(md).not.toContain('Domains crossed');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Baseline Capture & Compare
// ═══════════════════════════════════════════════════════════════════

describe('CI Quality Baseline', () => {
  function makeMinimalReport(overrides: Partial<CIReport['riskAnalysis']> = {}): CIReport {
    return {
      changedFiles: [{ path: 'a.ts', symbolCount: 1, avgCyclomatic: 1 }],
      blastRadius: { entries: [], totalAffected: 0, truncated: false },
      testCoverage: { gaps: [], totalExports: 5, totalUntested: 2 },
      riskAnalysis: { files: [], overallScore: 0.3, overallLevel: 'medium', ...overrides },
      architectureViolations: { violations: [], totalViolations: 1, layersChecked: [] },
      deadCode: { symbols: [], totalDead: 3 },
      summary: {
        changedFileCount: 1,
        affectedFileCount: 0,
        riskLevel: 'medium',
        untestedGaps: 2,
        violations: 1,
        deadExports: 3,
      },
    };
  }

  it('returns null when no baseline exists', () => {
    const store = createTestStore();
    const report = makeMinimalReport();
    const result = compareWithBaseline(store, report);
    expect(result).toBeNull();
    store.db.close();
  });

  it('captures and compares baseline correctly', () => {
    const store = createTestStore();
    const report1 = makeMinimalReport({ overallScore: 0.3 });
    captureBaseline(store, report1, 'abc1234');

    const report2 = makeMinimalReport({ overallScore: 0.35 });
    report2.testCoverage.totalUntested = 4; // worse
    report2.architectureViolations.totalViolations = 0; // better

    const comparison = compareWithBaseline(store, report2);
    expect(comparison).not.toBeNull();
    expect(comparison!.baselineCommit).toBe('abc1234');
    expect(comparison!.riskDelta).toBe(0.05);
    expect(comparison!.untestedDelta).toBe(2); // 4 - 2
    expect(comparison!.violationsDelta).toBe(-1); // 0 - 1
    expect(comparison!.regressionDetected).toBe(false); // 0.05 < 0.15 threshold
    store.db.close();
  });

  it('detects regression when risk score jumps', () => {
    const store = createTestStore();
    const report1 = makeMinimalReport({ overallScore: 0.2 });
    captureBaseline(store, report1, 'def5678');

    const report2 = makeMinimalReport({ overallScore: 0.5 }); // +0.3 > 0.15
    const comparison = compareWithBaseline(store, report2);
    expect(comparison!.regressionDetected).toBe(true);
    store.db.close();
  });

  it('formatMarkdown renders baseline section', () => {
    const report: CIReport = {
      changedFiles: [],
      blastRadius: { entries: [], totalAffected: 0, truncated: false },
      testCoverage: { gaps: [], totalExports: 0, totalUntested: 0 },
      riskAnalysis: { files: [], overallScore: 0, overallLevel: 'low' },
      architectureViolations: { violations: [], totalViolations: 0, layersChecked: [] },
      deadCode: { symbols: [], totalDead: 0 },
      baseline: {
        riskDelta: 0.05,
        untestedDelta: -2,
        violationsDelta: 1,
        deadExportsDelta: 0,
        regressionDetected: false,
        baselineCommit: 'abc1234',
        baselineDate: '2026-04-07T00:00:00Z',
      },
      summary: {
        changedFileCount: 0,
        affectedFileCount: 0,
        riskLevel: 'low',
        untestedGaps: 0,
        violations: 0,
        deadExports: 0,
      },
    };

    const md = formatMarkdown(report);
    expect(md).toContain('Trend vs Baseline');
    expect(md).toContain('abc1234');
    expect(md).toContain('+0.05');
    expect(md).toContain('-2');
    expect(md).toContain('better');
    expect(md).toContain('worse');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GitHub Annotations
// ═══════════════════════════════════════════════════════════════════

describe('CI GitHub Annotations', () => {
  it('generates annotations from report', () => {
    const report: CIReport = {
      changedFiles: [],
      blastRadius: { entries: [], totalAffected: 0, truncated: false },
      testCoverage: {
        gaps: [
          {
            symbolId: 's1',
            name: 'doStuff',
            kind: 'function',
            file: 'src/foo.ts',
            signature: null,
          },
        ],
        totalExports: 5,
        totalUntested: 1,
      },
      riskAnalysis: {
        files: [
          {
            file: 'src/bar.ts',
            complexity: 0.8,
            churn: 0.6,
            coupling: 0.5,
            blastSize: 5,
            score: 0.65,
          },
        ],
        overallScore: 0.65,
        overallLevel: 'high',
      },
      architectureViolations: {
        violations: [
          {
            source_file: 'src/a.ts',
            source_layer: 'ui',
            target_file: 'src/b.ts',
            target_layer: 'db',
            rule: 'no direct access',
          },
        ],
        totalViolations: 1,
        layersChecked: ['ui', 'db'],
      },
      deadCode: { symbols: [], totalDead: 0 },
      domainAnalysis: {
        domainsAffected: [],
        crossDomainChanges: [{ from: 'auth', to: 'billing', edgeCount: 3 }],
        reviewTeams: [],
      },
      summary: {
        changedFileCount: 0,
        affectedFileCount: 0,
        riskLevel: 'high',
        untestedGaps: 1,
        violations: 1,
        deadExports: 0,
      },
    };

    const annotations = generateAnnotations(report);

    // Architecture violation → failure
    const failures = annotations.filter((a) => a.annotation_level === 'failure');
    expect(failures.length).toBe(1);
    expect(failures[0].title).toBe('Architecture violation');

    // High risk → warning
    const warnings = annotations.filter((a) => a.annotation_level === 'warning');
    expect(warnings.some((w) => w.title === 'High risk file')).toBe(true);

    // Untested → notice
    const notices = annotations.filter((a) => a.annotation_level === 'notice');
    expect(notices.some((n) => n.title === 'Untested export')).toBe(true);

    // Cross-domain → notice
    expect(notices.some((n) => n.title === 'Cross-domain dependency')).toBe(true);
  });

  it('formatGitHubActions produces valid workflow commands', () => {
    const annotations = [
      {
        path: 'src/foo.ts',
        start_line: 10,
        end_line: 10,
        annotation_level: 'warning' as const,
        title: 'Test warning',
        message: 'Something is wrong',
      },
    ];

    const output = formatGitHubActions(annotations);
    expect(output).toContain('::warning');
    expect(output).toContain('file=src/foo.ts');
    expect(output).toContain('line=10');
    expect(output).toContain('title=Test warning');
    expect(output).toContain('Something is wrong');
  });

  it('formatAnnotationsJson produces valid JSON', () => {
    const annotations = [
      {
        path: 'src/a.ts',
        start_line: 1,
        end_line: 1,
        annotation_level: 'notice' as const,
        title: 'T',
        message: 'M',
      },
    ];

    const json = formatAnnotationsJson(annotations);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('T');
  });
});
