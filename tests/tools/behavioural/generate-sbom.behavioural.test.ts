/**
 * Behavioural coverage for `generateSbom()` in
 * `src/tools/project/sbom.ts` (the implementation behind the
 * `generate_sbom` MCP tool). Parses package manifests / lockfiles from the
 * project root and emits CycloneDX, SPDX, or plain JSON. Uses real temp
 * directories so the parsers see actual files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSbom } from '../../../src/tools/project/sbom.js';
import { createTmpDir, removeTmpDir, writeFixtureFile } from '../../test-utils.js';

function writeNpmFixture(
  root: string,
  opts: { withLock?: boolean; withDev?: boolean; withGpl?: boolean } = {},
): void {
  const pkg: Record<string, unknown> = {
    name: 'sbom-fixture',
    version: '1.0.0',
    dependencies: {
      express: '^4.18.0',
      lodash: '^4.17.21',
    },
  };
  if (opts.withDev) {
    pkg.devDependencies = { vitest: '^1.0.0' };
  }
  writeFixtureFile(root, 'package.json', JSON.stringify(pkg, null, 2));

  if (opts.withLock) {
    const lock = {
      name: 'sbom-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'sbom-fixture', version: '1.0.0' },
        'node_modules/express': { version: '4.18.2', license: 'MIT' },
        'node_modules/lodash': {
          version: '4.17.21',
          license: opts.withGpl ? 'GPL-3.0' : 'MIT',
        },
        'node_modules/accepts': { version: '1.3.8', license: 'MIT' }, // transitive
        ...(opts.withDev
          ? { 'node_modules/vitest': { version: '1.0.4', license: 'MIT', dev: true } }
          : {}),
      },
    };
    writeFixtureFile(root, 'package-lock.json', JSON.stringify(lock, null, 2));
  }
}

describe('generateSbom() — behavioural contract', () => {
  let root: string;

  beforeEach(() => {
    root = createTmpDir('sbom-test-');
  });

  afterEach(() => {
    removeTmpDir(root);
  });

  it('format="json" returns components with name/version/ecosystem and includes direct deps', () => {
    writeNpmFixture(root, { withLock: true });

    const result = generateSbom(root, { format: 'json' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.format).toBe('json');
    expect(Array.isArray(result.value.components)).toBe(true);
    expect(result.value.components.length).toBeGreaterThan(0);

    const names = result.value.components.map((c) => c.name);
    expect(names).toContain('express');
    expect(names).toContain('lodash');

    for (const c of result.value.components) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.version).toBe('string');
      expect(typeof c.ecosystem).toBe('string');
      expect(typeof c.direct).toBe('boolean');
    }
  });

  it('format="cyclonedx" attaches a CycloneDX-shaped `formatted` payload', () => {
    writeNpmFixture(root, { withLock: true });

    const result = generateSbom(root, { format: 'cyclonedx' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.format).toBe('cyclonedx');
    expect(result.value.formatted).toBeDefined();
    const cdx = result.value.formatted as Record<string, unknown>;
    expect(cdx.bomFormat).toBe('CycloneDX');
    expect(cdx.specVersion).toBe('1.5');
    expect(Array.isArray(cdx.components)).toBe(true);
  });

  it('format="spdx" attaches an SPDX-shaped `formatted` payload', () => {
    writeNpmFixture(root, { withLock: true });

    const result = generateSbom(root, { format: 'spdx' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.format).toBe('spdx');
    expect(result.value.formatted).toBeDefined();
    const spdx = result.value.formatted as Record<string, unknown>;
    expect(spdx.spdxVersion).toBe('SPDX-2.3');
    expect(spdx.dataLicense).toBe('CC0-1.0');
    expect(Array.isArray(spdx.packages)).toBe(true);
  });

  it('includeDev toggles whether devDependencies appear in the components list', () => {
    writeNpmFixture(root, { withLock: true, withDev: true });

    const withDev = generateSbom(root, { format: 'json', includeDev: true });
    const withoutDev = generateSbom(root, { format: 'json', includeDev: false });
    expect(withDev.isOk()).toBe(true);
    expect(withoutDev.isOk()).toBe(true);
    if (withDev.isErr() || withoutDev.isErr()) return;

    const namesWithDev = withDev.value.components.map((c) => c.name);
    const namesWithoutDev = withoutDev.value.components.map((c) => c.name);
    expect(namesWithDev).toContain('vitest');
    expect(namesWithoutDev).not.toContain('vitest');
  });

  it('includeTransitive=false restricts the npm component set to direct dependencies', () => {
    writeNpmFixture(root, { withLock: true });

    const result = generateSbom(root, { format: 'json', includeTransitive: false });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    // With transitive disabled the parser falls back to the manifest's dep list,
    // so we should NOT see lockfile-only transitive entries like `accepts`.
    const names = result.value.components.map((c) => c.name);
    expect(names).toContain('express');
    expect(names).toContain('lodash');
    expect(names).not.toContain('accepts');
    // Every emitted component should be flagged direct.
    for (const c of result.value.components) {
      expect(c.direct).toBe(true);
    }
  });

  it('copyleft licenses surface in license_warnings', () => {
    writeNpmFixture(root, { withLock: true, withGpl: true });

    const result = generateSbom(root, { format: 'json' });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(Array.isArray(result.value.license_warnings)).toBe(true);
    const gpl = result.value.license_warnings.find((w) => w.component === 'lodash');
    expect(gpl).toBeDefined();
    expect(gpl!.license).toMatch(/^GPL/);
  });

  it('errors with VALIDATION_ERROR when no manifests exist in the project root', () => {
    // Empty temp dir — no package.json, composer.json, etc.
    // Ensure dir is empty (createTmpDir gives an empty dir already, but guard).
    for (const f of fs.readdirSync(root)) fs.rmSync(path.join(root, f), { recursive: true });

    const result = generateSbom(root, { format: 'json' });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});
