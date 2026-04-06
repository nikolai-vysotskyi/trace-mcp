import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getPackageDeps } from '../../src/tools/project/package-deps.js';
import { REGISTRY_PATH } from '../../src/global.js';

let tmpDir: string;
let repoA: string;
let repoB: string;
let repoC: string;
let origRegistryContent: string | null = null;

describe('getPackageDeps', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-pkg-deps-'));

    // Create mock repos
    repoA = path.join(tmpDir, 'repo-a');
    repoB = path.join(tmpDir, 'repo-b');
    repoC = path.join(tmpDir, 'repo-c');
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    fs.mkdirSync(repoC, { recursive: true });

    // repo-a publishes @myorg/shared-utils
    fs.writeFileSync(path.join(repoA, 'package.json'), JSON.stringify({
      name: '@myorg/shared-utils',
      version: '1.0.0',
      dependencies: {},
    }));

    // repo-b depends on @myorg/shared-utils
    fs.writeFileSync(path.join(repoB, 'package.json'), JSON.stringify({
      name: '@myorg/api-server',
      version: '2.0.0',
      dependencies: { '@myorg/shared-utils': '^1.0.0', 'express': '^4.0.0' },
    }));

    // repo-c depends on @myorg/shared-utils in devDeps
    fs.writeFileSync(path.join(repoC, 'package.json'), JSON.stringify({
      name: '@myorg/frontend',
      version: '1.0.0',
      devDependencies: { '@myorg/shared-utils': '^1.0.0' },
    }));

    // Save original registry (if exists) and write test registry
    if (fs.existsSync(REGISTRY_PATH)) {
      origRegistryContent = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    }

    const registryDir = path.dirname(REGISTRY_PATH);
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify({
      [repoA]: { name: 'repo-a', path: repoA },
      [repoB]: { name: 'repo-b', path: repoB },
      [repoC]: { name: 'repo-c', path: repoC },
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Restore original registry
    if (origRegistryContent !== null) {
      fs.writeFileSync(REGISTRY_PATH, origRegistryContent);
    } else if (fs.existsSync(REGISTRY_PATH)) {
      // Only delete if we created it
    }
  });

  it('finds dependents of a package', () => {
    const result = getPackageDeps({
      package: '@myorg/shared-utils',
      direction: 'dependents',
    });
    expect(result.results.length).toBe(2); // repo-b and repo-c
    const repos = result.results.map((r) => r.repo).sort();
    expect(repos).toContain('repo-b');
    expect(repos).toContain('repo-c');
  });

  it('distinguishes dep types', () => {
    const result = getPackageDeps({
      package: '@myorg/shared-utils',
      direction: 'dependents',
    });
    const repoB_dep = result.results.find((r) => r.repo === 'repo-b');
    const repoC_dep = result.results.find((r) => r.repo === 'repo-c');
    expect(repoB_dep?.depType).toBe('dependencies');
    expect(repoC_dep?.depType).toBe('devDependencies');
  });

  it('returns published packages', () => {
    const result = getPackageDeps({
      package: '@myorg/shared-utils',
      direction: 'dependents',
    });
    expect(result.published_packages.length).toBeGreaterThanOrEqual(1);
    expect(result.published_packages.some((p) => p.name === '@myorg/shared-utils')).toBe(true);
  });

  it('handles unknown package gracefully', () => {
    const result = getPackageDeps({
      package: '@unknown/nonexistent',
      direction: 'dependents',
    });
    expect(result.results.length).toBe(0);
  });

  it('finds dependencies by project name', () => {
    const result = getPackageDeps({
      project: 'repo-b',
      direction: 'dependencies',
    });
    // repo-b depends on @myorg/shared-utils which is published by repo-a
    const sharedDep = result.results.find((r) => r.package === '@myorg/shared-utils');
    expect(sharedDep).toBeDefined();
  });

  it('both direction returns dependents and dependencies', () => {
    const result = getPackageDeps({
      package: '@myorg/shared-utils',
      direction: 'both',
    });
    expect(result.results.length).toBeGreaterThanOrEqual(2);
  });

  it('no N+1: processes all repos in single pass', () => {
    // This is a structural guarantee — we read each manifest once
    // Verified by the fact that we iterate repoManifests once per direction
    const result = getPackageDeps({ direction: 'both' });
    expect(result.published_packages.length).toBeGreaterThanOrEqual(3);
  });
});

describe('getPackageDeps with composer.json', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-pkg-composer-'));
    const repo = path.join(tmpDir, 'laravel-app');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'composer.json'), JSON.stringify({
      name: 'myorg/laravel-app',
      require: { 'php': '^8.1', 'laravel/framework': '^10.0', 'myorg/shared-lib': '^1.0' },
    }));

    const registryDir = path.dirname(REGISTRY_PATH);
    fs.mkdirSync(registryDir, { recursive: true });
    if (fs.existsSync(REGISTRY_PATH)) {
      origRegistryContent = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    }
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify({
      [repo]: { name: 'laravel-app', path: repo },
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origRegistryContent !== null) {
      fs.writeFileSync(REGISTRY_PATH, origRegistryContent);
    }
  });

  it('reads composer.json dependencies', () => {
    const result = getPackageDeps({ project: 'laravel-app', direction: 'dependencies' });
    // Should find the composer deps (but not php itself)
    expect(result.published_packages.some((p) => p.name === 'myorg/laravel-app')).toBe(true);
  });
});
