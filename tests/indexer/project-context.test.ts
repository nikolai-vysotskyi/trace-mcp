/**
 * Tests for buildProjectContext — manifest file parsing and version detection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProjectContext } from '../../src/indexer/project-context.js';
import { createTmpDir, removeTmpDir, writeFixtureFile } from '../test-utils.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = createTmpDir('trace-ctx-');
});

afterEach(() => {
  removeTmpDir(tmpDir);
});

describe('buildProjectContext', () => {
  it('returns empty context for an empty directory', () => {
    const ctx = buildProjectContext(tmpDir);
    expect(ctx.detectedVersions).toEqual([]);
    expect(ctx.allDependencies).toEqual([]);
    expect(ctx.packageJson).toBeUndefined();
    expect(ctx.composerJson).toBeUndefined();
  });

  // ========== package.json ==========

  describe('package.json', () => {
    it('parses dependencies and engines', () => {
      writeFixtureFile(
        tmpDir,
        'package.json',
        JSON.stringify({
          engines: { node: '>=18.0.0', npm: '>=9' },
          dependencies: { express: '^4.18.0', lodash: '4.17.21' },
          devDependencies: { vitest: '^1.0.0' },
        }),
      );
      const ctx = buildProjectContext(tmpDir);

      expect(ctx.packageJson).toBeDefined();
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'node',
        version: '>=18.0.0',
        source: 'package.json#engines.node',
      });
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'npm',
        version: '>=9',
        source: 'package.json#engines.npm',
      });
      expect(ctx.allDependencies).toContainEqual({
        name: 'express',
        version: '^4.18.0',
        dev: undefined,
      });
      expect(ctx.allDependencies).toContainEqual({ name: 'vitest', version: '^1.0.0', dev: true });
      expect(ctx.allDependencies).toHaveLength(3);
    });

    it('handles peerDependencies', () => {
      writeFixtureFile(
        tmpDir,
        'package.json',
        JSON.stringify({
          peerDependencies: { react: '>=17' },
        }),
      );
      const ctx = buildProjectContext(tmpDir);
      expect(ctx.allDependencies).toContainEqual({
        name: 'react',
        version: '>=17',
        dev: undefined,
      });
    });

    it('tolerates malformed JSON', () => {
      writeFixtureFile(tmpDir, 'package.json', '{ invalid json }');
      const ctx = buildProjectContext(tmpDir);
      expect(ctx.packageJson).toBeUndefined();
    });
  });

  // ========== .nvmrc / .node-version ==========

  describe('.nvmrc and .node-version', () => {
    it('detects node version from .nvmrc', () => {
      writeFixtureFile(tmpDir, '.nvmrc', 'v20.11.0\n');
      const ctx = buildProjectContext(tmpDir);
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'node',
        version: '20.11.0',
        source: '.nvmrc',
      });
    });

    it('detects node version from .node-version', () => {
      writeFixtureFile(tmpDir, '.node-version', '18.19.0');
      const ctx = buildProjectContext(tmpDir);
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'node',
        version: '18.19.0',
        source: '.node-version',
      });
    });

    it('prefers .nvmrc over .node-version', () => {
      writeFixtureFile(tmpDir, '.nvmrc', '20');
      writeFixtureFile(tmpDir, '.node-version', '18');
      const ctx = buildProjectContext(tmpDir);
      const nodeVersions = ctx.detectedVersions.filter(
        (v) => v.runtime === 'node' && (v.source === '.nvmrc' || v.source === '.node-version'),
      );
      expect(nodeVersions).toHaveLength(1);
      expect(nodeVersions[0].source).toBe('.nvmrc');
    });
  });

  // ========== composer.json ==========

  describe('composer.json', () => {
    it('parses PHP version and dependencies', () => {
      writeFixtureFile(
        tmpDir,
        'composer.json',
        JSON.stringify({
          require: { php: '>=8.2', 'laravel/framework': '^11.0' },
          'require-dev': { 'phpunit/phpunit': '^10.0' },
        }),
      );
      const ctx = buildProjectContext(tmpDir);

      expect(ctx.composerJson).toBeDefined();
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'php',
        version: '>=8.2',
        source: 'composer.json#require.php',
      });
      // php itself should not be in allDependencies
      expect(ctx.allDependencies.find((d) => d.name === 'php')).toBeUndefined();
      expect(ctx.allDependencies).toContainEqual({
        name: 'laravel/framework',
        version: '^11.0',
        dev: undefined,
      });
      expect(ctx.allDependencies).toContainEqual({
        name: 'phpunit/phpunit',
        version: '^10.0',
        dev: true,
      });
    });
  });

  // ========== pyproject.toml ==========

  describe('pyproject.toml', () => {
    it('parses inline dependencies and requires-python', () => {
      writeFixtureFile(
        tmpDir,
        'pyproject.toml',
        `
[project]
name = "my-app"
requires-python = ">=3.11"
dependencies = ["fastapi>=0.100", "pydantic>=2.0"]
`,
      );
      const ctx = buildProjectContext(tmpDir);

      expect(ctx.pyprojectToml).toBeDefined();
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'python',
        version: '>=3.11',
        source: 'pyproject.toml#requires-python',
      });
      expect(ctx.allDependencies).toContainEqual(expect.objectContaining({ name: 'fastapi' }));
      expect(ctx.allDependencies).toContainEqual(expect.objectContaining({ name: 'pydantic' }));
    });
  });

  // ========== .python-version ==========

  describe('.python-version', () => {
    it('detects python version', () => {
      writeFixtureFile(tmpDir, '.python-version', '3.12.1');
      const ctx = buildProjectContext(tmpDir);
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'python',
        version: '3.12.1',
        source: '.python-version',
      });
    });
  });

  // ========== requirements.txt ==========

  describe('requirements.txt', () => {
    it('parses package names and versions', () => {
      writeFixtureFile(
        tmpDir,
        'requirements.txt',
        `
django>=4.2
celery[redis]>=5.3.0
# this is a comment
-r base.txt
gunicorn==21.2.0
`,
      );
      const ctx = buildProjectContext(tmpDir);
      expect(ctx.requirementsTxt).toContain('django');
      expect(ctx.requirementsTxt).toContain('celery');
      expect(ctx.requirementsTxt).toContain('gunicorn');
      expect(ctx.allDependencies).toContainEqual(expect.objectContaining({ name: 'django' }));
    });
  });

  // ========== go.mod ==========

  describe('go.mod', () => {
    it('parses module, go version, and dependencies', () => {
      writeFixtureFile(
        tmpDir,
        'go.mod',
        `module github.com/example/app

go 1.22

require (
	github.com/gin-gonic/gin v1.9.1
	github.com/go-sql-driver/mysql v1.7.1
)
`,
      );
      const ctx = buildProjectContext(tmpDir);

      expect(ctx.goMod).toBeDefined();
      expect(ctx.goMod!.module).toBe('github.com/example/app');
      expect(ctx.goMod!.goVersion).toBe('1.22');
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'go',
        version: '1.22',
        source: 'go.mod',
      });
      expect(ctx.goMod!.deps).toContainEqual({
        name: 'github.com/gin-gonic/gin',
        version: 'v1.9.1',
      });
      expect(ctx.allDependencies).toContainEqual({
        name: 'github.com/gin-gonic/gin',
        version: 'v1.9.1',
      });
    });
  });

  // ========== Cargo.toml ==========

  describe('Cargo.toml', () => {
    it('parses rust version, edition, and dependencies', () => {
      writeFixtureFile(
        tmpDir,
        'Cargo.toml',
        `
[package]
name = "my-app"
version = "0.1.0"
edition = "2021"
rust-version = "1.75"

[dependencies]
serde = "1.0"
tokio = { version = "1.35", features = ["full"] }

[dev-dependencies]
criterion = "0.5"
`,
      );
      const ctx = buildProjectContext(tmpDir);

      expect(ctx.cargoToml).toBeDefined();
      expect(ctx.cargoToml!.package).toEqual({ name: 'my-app', version: '0.1.0' });
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'rust',
        version: 'edition-2021',
        source: 'Cargo.toml#edition',
      });
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'rust',
        version: '1.75',
        source: 'Cargo.toml#rust-version',
      });
      expect(ctx.cargoToml!.deps).toContainEqual({ name: 'serde', version: '1.0', dev: undefined });
      expect(ctx.cargoToml!.deps).toContainEqual({
        name: 'tokio',
        version: '1.35',
        dev: undefined,
      });
      expect(ctx.cargoToml!.deps).toContainEqual({ name: 'criterion', version: '0.5', dev: true });
    });
  });

  // ========== Gemfile ==========

  describe('Gemfile', () => {
    it('parses gem dependencies', () => {
      writeFixtureFile(
        tmpDir,
        'Gemfile',
        `
source "https://rubygems.org"
gem 'rails', '~> 7.1'
gem 'pg'
gem 'puma', '>= 5.0'
`,
      );
      const ctx = buildProjectContext(tmpDir);

      expect(ctx.gemfile).toBeDefined();
      expect(ctx.gemfile!.deps).toContainEqual({ name: 'rails', version: '~> 7.1' });
      expect(ctx.gemfile!.deps).toContainEqual({ name: 'pg', version: undefined });
      expect(ctx.gemfile!.deps).toContainEqual({ name: 'puma', version: '>= 5.0' });
    });
  });

  // ========== .ruby-version ==========

  describe('.ruby-version', () => {
    it('detects ruby version', () => {
      writeFixtureFile(tmpDir, '.ruby-version', 'ruby-3.3.0');
      const ctx = buildProjectContext(tmpDir);
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'ruby',
        version: '3.3.0',
        source: '.ruby-version',
      });
    });

    it('strips ruby- prefix', () => {
      writeFixtureFile(tmpDir, '.ruby-version', 'ruby-3.2.2');
      const ctx = buildProjectContext(tmpDir);
      const rv = ctx.detectedVersions.find((v) => v.runtime === 'ruby');
      expect(rv!.version).toBe('3.2.2');
    });
  });

  // ========== pom.xml ==========

  describe('pom.xml', () => {
    it('parses Java version and Maven dependencies', () => {
      writeFixtureFile(
        tmpDir,
        'pom.xml',
        `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.source>21</maven.compiler.source>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.2.0</version>
    </dependency>
  </dependencies>
</project>`,
      );
      const ctx = buildProjectContext(tmpDir);

      expect(ctx.pomXml).toBeDefined();
      expect(ctx.pomXml!.groupId).toBe('com.example');
      expect(ctx.pomXml!.artifactId).toBe('my-app');
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'java',
        version: '21',
        source: 'pom.xml',
      });
      expect(ctx.pomXml!.deps).toContainEqual({
        name: 'org.springframework.boot:spring-boot-starter-web',
        version: '3.2.0',
      });
    });
  });

  // ========== build.gradle ==========

  describe('build.gradle', () => {
    it('parses Gradle dependencies and Java version', () => {
      writeFixtureFile(
        tmpDir,
        'build.gradle',
        `
plugins {
    id 'java'
}
sourceCompatibility = '17'
dependencies {
    implementation 'org.springframework:spring-web:6.1.0'
    testImplementation 'junit:junit:4.13.2'
}
`,
      );
      const ctx = buildProjectContext(tmpDir);

      expect(ctx.buildGradle).toBeDefined();
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'java',
        version: '17',
        source: 'build.gradle',
      });
      expect(ctx.buildGradle!.deps).toContainEqual({
        name: 'org.springframework:spring-web',
        version: '6.1.0',
      });
    });
  });

  // ========== .tool-versions ==========

  describe('.tool-versions (asdf)', () => {
    it('detects multiple runtimes', () => {
      writeFixtureFile(
        tmpDir,
        '.tool-versions',
        `nodejs 20.11.0
python 3.12.1
ruby 3.3.0
golang 1.22.0
`,
      );
      const ctx = buildProjectContext(tmpDir);

      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'node',
        version: '20.11.0',
        source: '.tool-versions',
      });
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'python',
        version: '3.12.1',
        source: '.tool-versions',
      });
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'ruby',
        version: '3.3.0',
        source: '.tool-versions',
      });
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'go',
        version: '1.22.0',
        source: '.tool-versions',
      });
    });
  });

  // ========== Config files scan ==========

  describe('configFiles', () => {
    it('detects known config files', () => {
      writeFixtureFile(tmpDir, 'tsconfig.json', '{}');
      writeFixtureFile(tmpDir, 'vite.config.ts', 'export default {}');
      writeFixtureFile(tmpDir, '.env', 'FOO=bar');
      const ctx = buildProjectContext(tmpDir);

      expect(ctx.configFiles).toContain('tsconfig.json');
      expect(ctx.configFiles).toContain('vite.config.ts');
      expect(ctx.configFiles).toContain('.env');
    });
  });

  // ========== Multi-ecosystem project ==========

  describe('multi-ecosystem', () => {
    it('aggregates versions and deps from multiple manifests', () => {
      writeFixtureFile(
        tmpDir,
        'package.json',
        JSON.stringify({
          engines: { node: '>=20' },
          dependencies: { next: '14.0.0' },
        }),
      );
      writeFixtureFile(tmpDir, '.nvmrc', '20');
      writeFixtureFile(tmpDir, '.python-version', '3.12');
      writeFixtureFile(tmpDir, 'requirements.txt', 'django>=4.2');

      const ctx = buildProjectContext(tmpDir);

      const runtimes = ctx.detectedVersions.map((v) => v.runtime);
      expect(runtimes).toContain('node');
      expect(runtimes).toContain('python');
      expect(ctx.allDependencies.length).toBeGreaterThanOrEqual(2);
    });
  });
});
