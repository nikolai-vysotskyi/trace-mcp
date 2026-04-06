import { describe, test, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { generateSbom } from '../../src/tools/project/sbom.js';

const TEST_DIR = path.join(tmpdir(), 'trace-mcp-sbom-test-' + process.pid);

function writeJson(relPath: string, data: unknown): void {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(data, null, 2));
}

function writeText(relPath: string, content: string): void {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
}

describe('SBOM Generation', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  // -------------------------------------------------------------------
  // npm
  // -------------------------------------------------------------------

  test('parses package.json without lockfile', () => {
    writeJson('package.json', {
      name: 'test-project',
      dependencies: { express: '^4.18.0', lodash: '^4.17.21' },
      devDependencies: { vitest: '^1.0.0' },
    });

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.components.length).toBe(2); // no dev deps by default
    expect(data.direct_count).toBe(2);
    expect(data.components.find((c) => c.name === 'express')).toBeDefined();
  });

  test('includes devDependencies when requested', () => {
    writeJson('package.json', {
      dependencies: { express: '^4.18.0' },
      devDependencies: { vitest: '^1.0.0' },
    });

    const result = generateSbom(TEST_DIR, { includeDev: true });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.components.length).toBe(2);
    expect(data.components.find((c) => c.name === 'vitest')).toBeDefined();
  });

  test('parses package-lock.json v2 with transitive deps', () => {
    writeJson('package.json', {
      dependencies: { express: '^4.18.0' },
    });
    writeJson('package-lock.json', {
      lockfileVersion: 2,
      packages: {
        '': { name: 'test-project', version: '1.0.0' },
        'node_modules/express': { version: '4.18.2', license: 'MIT' },
        'node_modules/body-parser': { version: '1.20.1', license: 'MIT' },
        'node_modules/debug': { version: '2.6.9', license: 'MIT', dev: true },
      },
    });

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.components.length).toBe(2); // express + body-parser, not debug (dev)
    const express = data.components.find((c) => c.name === 'express');
    expect(express?.version).toBe('4.18.2');
    expect(express?.license).toBe('MIT');
    expect(express?.direct).toBe(true);
    const bp = data.components.find((c) => c.name === 'body-parser');
    expect(bp?.direct).toBe(false);
  });

  // -------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------

  test('parses composer.lock', () => {
    writeJson('composer.json', {
      require: { 'laravel/framework': '^10.0' },
    });
    writeJson('composer.lock', {
      packages: [
        { name: 'laravel/framework', version: 'v10.48.0', license: ['MIT'] },
        { name: 'symfony/console', version: 'v6.4.0', license: ['MIT'] },
      ],
      'packages-dev': [
        { name: 'phpunit/phpunit', version: '10.5.0', license: ['BSD-3-Clause'] },
      ],
    });

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.components.length).toBe(2); // no dev
    const laravel = data.components.find((c) => c.name === 'laravel/framework');
    expect(laravel?.direct).toBe(true);
    expect(laravel?.license).toBe('MIT');
  });

  test('includes composer dev deps when requested', () => {
    writeJson('composer.json', {
      require: { 'laravel/framework': '^10.0' },
      'require-dev': { 'phpunit/phpunit': '^10.5' },
    });
    writeJson('composer.lock', {
      packages: [{ name: 'laravel/framework', version: 'v10.48.0' }],
      'packages-dev': [{ name: 'phpunit/phpunit', version: '10.5.0' }],
    });

    const result = generateSbom(TEST_DIR, { includeDev: true });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().components.length).toBe(2);
  });

  // -------------------------------------------------------------------
  // pip
  // -------------------------------------------------------------------

  test('parses requirements.txt', () => {
    writeText('requirements.txt', `
flask==2.3.0
requests>=2.28.0
# comment
numpy~=1.24
`);

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.components.length).toBe(3);
    const flask = data.components.find((c) => c.name === 'flask');
    expect(flask?.version).toBe('2.3.0');
    expect(flask?.ecosystem).toBe('pip');
  });

  // -------------------------------------------------------------------
  // Go
  // -------------------------------------------------------------------

  test('parses go.mod', () => {
    writeText('go.mod', `module github.com/example/app

go 1.21

require (
\tgithub.com/gin-gonic/gin v1.9.1
\tgithub.com/lib/pq v1.10.9 // indirect
)
`);

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.components.length).toBe(2);
    const gin = data.components.find((c) => c.name === 'github.com/gin-gonic/gin');
    expect(gin?.direct).toBe(true);
    expect(gin?.version).toBe('v1.9.1');
    const pq = data.components.find((c) => c.name === 'github.com/lib/pq');
    expect(pq?.direct).toBe(false);
  });

  test('go excludes indirect when includeTransitive=false', () => {
    writeText('go.mod', `module example.com/app

require (
\tgithub.com/direct v1.0.0
\tgithub.com/indirect v2.0.0 // indirect
)
`);

    const result = generateSbom(TEST_DIR, { includeTransitive: false });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.components.length).toBe(1);
    expect(data.components[0].name).toBe('github.com/direct');
  });

  // -------------------------------------------------------------------
  // Cargo
  // -------------------------------------------------------------------

  test('parses Cargo.lock', () => {
    writeText('Cargo.toml', `[package]
name = "myapp"
version = "0.1.0"

[dependencies]
serde = "1.0"
`);
    writeText('Cargo.lock', `[[package]]
name = "serde"
version = "1.0.195"
checksum = "abc123"

[[package]]
name = "serde_derive"
version = "1.0.195"
`);

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.components.length).toBe(2);
    const serde = data.components.find((c) => c.name === 'serde');
    expect(serde?.version).toBe('1.0.195');
    expect(serde?.resolved).toBe('abc123');
  });

  // -------------------------------------------------------------------
  // Maven
  // -------------------------------------------------------------------

  test('parses pom.xml', () => {
    writeText('pom.xml', `<?xml version="1.0"?>
<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter</artifactId>
      <version>3.2.0</version>
    </dependency>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
  </dependencies>
</project>
`);

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.components.length).toBe(2);
    expect(data.components[0].name).toBe('org.springframework.boot:spring-boot-starter');
    expect(data.components[0].ecosystem).toBe('maven');
  });

  // -------------------------------------------------------------------
  // License warnings
  // -------------------------------------------------------------------

  test('warns about GPL licenses', () => {
    writeJson('package.json', {
      dependencies: { express: '^4.18.0' },
    });
    writeJson('package-lock.json', {
      lockfileVersion: 2,
      packages: {
        '': {},
        'node_modules/express': { version: '4.18.2', license: 'MIT' },
        'node_modules/gpl-lib': { version: '1.0.0', license: 'GPL-3.0' },
      },
    });

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.license_warnings.length).toBeGreaterThanOrEqual(1);
    const gplWarning = data.license_warnings.find((w) => w.license === 'GPL-3.0');
    expect(gplWarning?.reason).toContain('Copyleft');
  });

  test('warns about unknown licenses', () => {
    writeJson('package.json', {
      dependencies: { express: '^4.18.0' },
    });
    writeJson('package-lock.json', {
      lockfileVersion: 2,
      packages: {
        '': {},
        'node_modules/no-license': { version: '1.0.0' },
      },
    });

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const warning = data.license_warnings.find((w) => w.component === 'no-license');
    expect(warning?.reason).toContain('No license');
  });

  // -------------------------------------------------------------------
  // Format output
  // -------------------------------------------------------------------

  test('generates CycloneDX format', () => {
    writeJson('package.json', {
      dependencies: { express: '^4.18.0' },
    });

    const result = generateSbom(TEST_DIR, { format: 'cyclonedx' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.formatted).toBeDefined();
    const cdx = data.formatted as Record<string, unknown>;
    expect(cdx.bomFormat).toBe('CycloneDX');
    expect(cdx.specVersion).toBe('1.5');
    expect(Array.isArray(cdx.components)).toBe(true);
  });

  test('generates SPDX format', () => {
    writeJson('package.json', {
      dependencies: { express: '^4.18.0' },
    });

    const result = generateSbom(TEST_DIR, { format: 'spdx' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.formatted).toBeDefined();
    const spdx = data.formatted as Record<string, unknown>;
    expect(spdx.spdxVersion).toBe('SPDX-2.3');
    expect(Array.isArray(spdx.packages)).toBe(true);
  });

  // -------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------

  test('returns error when no manifests found', () => {
    const result = generateSbom(TEST_DIR, {});
    expect(result.isErr()).toBe(true);
  });

  test('deduplicates components', () => {
    // Same dep in both package.json and requirements.txt won't happen
    // but same name in lockfile can
    writeJson('package.json', {
      dependencies: { lodash: '^4.17.21' },
    });

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const names = result._unsafeUnwrap().components.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('license_summary counts correctly', () => {
    writeJson('package.json', { dependencies: { a: '1' } });
    writeJson('package-lock.json', {
      lockfileVersion: 2,
      packages: {
        '': {},
        'node_modules/a': { version: '1.0.0', license: 'MIT' },
        'node_modules/b': { version: '1.0.0', license: 'MIT' },
        'node_modules/c': { version: '1.0.0', license: 'Apache-2.0' },
      },
    });

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.license_summary['MIT']).toBe(2);
    expect(data.license_summary['Apache-2.0']).toBe(1);
  });

  test('handles multi-ecosystem project', () => {
    writeJson('package.json', { dependencies: { express: '^4.18.0' } });
    writeText('requirements.txt', 'flask==2.3.0\n');

    const result = generateSbom(TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const ecosystems = new Set(data.components.map((c) => c.ecosystem));
    expect(ecosystems.has('npm')).toBe(true);
    expect(ecosystems.has('pip')).toBe(true);
  });
});
