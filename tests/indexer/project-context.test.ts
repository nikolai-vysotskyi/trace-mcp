/**
 * Tests for buildProjectContext — manifest file parsing and version detection.
 */
import fs from 'node:fs';
import path from 'node:path';
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

  // ========== Monorepo / Nested Manifests (1-2 levels deep) ==========

  describe('monorepo & nested subproject manifests', () => {
    it('discovers and aggregates manifests 1 level deep (e.g. thewed-laravel / thewed-front)', () => {
      writeFixtureFile(
        tmpDir,
        'thewed-laravel/composer.json',
        JSON.stringify({
          require: { php: '^8.2', 'laravel/framework': '^11.0' },
          'require-dev': { 'phpunit/phpunit': '^10.0' },
        }),
      );
      writeFixtureFile(
        tmpDir,
        'thewed-front/package.json',
        JSON.stringify({
          dependencies: { vue: '^3.4.0', nuxt: '^3.10.0' },
          devDependencies: { vitest: '^1.0.0' },
        }),
      );
      writeFixtureFile(
        tmpDir,
        'thewed-front/nuxt.config.ts',
        'export default defineNuxtConfig({})',
      );

      const ctx = buildProjectContext(tmpDir);

      // Manifests populated
      expect(ctx.composerJson).toBeDefined();
      expect((ctx.composerJson?.require as Record<string, string>)?.['laravel/framework']).toBe(
        '^11.0',
      );
      expect(ctx.packageJson).toBeDefined();
      expect((ctx.packageJson?.dependencies as Record<string, string>)?.vue).toBe('^3.4.0');
      expect((ctx.packageJson?.dependencies as Record<string, string>)?.nuxt).toBe('^3.10.0');
      expect((ctx.packageJson?.devDependencies as Record<string, string>)?.vitest).toBe('^1.0.0');

      // allDependencies contains both subprojects
      expect(ctx.allDependencies).toContainEqual(
        expect.objectContaining({ name: 'laravel/framework', version: '^11.0' }),
      );
      expect(ctx.allDependencies).toContainEqual(
        expect.objectContaining({ name: 'vue', version: '^3.4.0' }),
      );
      expect(ctx.allDependencies).toContainEqual(
        expect.objectContaining({ name: 'nuxt', version: '^3.10.0' }),
      );
      expect(ctx.allDependencies).toContainEqual(
        expect.objectContaining({ name: 'vitest', version: '^1.0.0', dev: true }),
      );

      // detectedVersions includes runtimes with relative subproject sources
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'php',
        version: '^8.2',
        source: 'thewed-laravel/composer.json#require.php',
      });
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'laravel',
        version: '^11.0',
        source: 'thewed-laravel/composer.json#laravel/framework',
      });
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'vue',
        version: '^3.4.0',
        source: 'thewed-front/package.json#vue',
      });
      expect(ctx.detectedVersions).toContainEqual({
        runtime: 'nuxt',
        version: '^3.10.0',
        source: 'thewed-front/package.json#nuxt',
      });

      // configFiles contains subproject config files
      expect(ctx.configFiles).toContain('thewed-front/nuxt.config.ts');
    });

    it('discovers manifests 2 levels deep', () => {
      writeFixtureFile(
        tmpDir,
        'services/api/pyproject.toml',
        `
[project]
name = "api-service"
requires-python = ">=3.11"
dependencies = ["fastapi>=0.100.0"]
`,
      );
      writeFixtureFile(tmpDir, 'services/worker/requirements.txt', 'celery>=5.3.0\nredis>=5.0.0\n');
      writeFixtureFile(
        tmpDir,
        'packages/shared/go.mod',
        'module example.com/shared\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
      );

      const ctx = buildProjectContext(tmpDir);

      expect(ctx.pyprojectToml).toBeDefined();
      expect(ctx.pyprojectToml?._parsedDeps).toContain('fastapi');
      expect(ctx.requirementsTxt).toContain('celery');
      expect(ctx.requirementsTxt).toContain('redis');
      expect(ctx.goMod).toBeDefined();
      expect(ctx.goMod?.deps).toContainEqual(
        expect.objectContaining({ name: 'github.com/gin-gonic/gin', version: 'v1.9.1' }),
      );

      expect(ctx.allDependencies).toContainEqual(expect.objectContaining({ name: 'fastapi' }));
      expect(ctx.allDependencies).toContainEqual(expect.objectContaining({ name: 'celery' }));
      expect(ctx.allDependencies).toContainEqual(expect.objectContaining({ name: 'redis' }));
      expect(ctx.allDependencies).toContainEqual(
        expect.objectContaining({ name: 'github.com/gin-gonic/gin' }),
      );
    });

    /**
     * The require-block line parser used `([^\s/]+(?:\/[^\s]+)*)`, whose repeated
     * group could itself consume slashes — so "a/b/c" was matchable 2^n ways and a
     * go.mod line of many "!/" repetitions backtracked exponentially (js/redos,
     * flagged by CodeQL on #711). Indexing is pointed at arbitrary checkouts, so
     * the input is not trusted. 200 repetitions hangs for minutes unfixed.
     */
    it('parses a go.mod require block in linear time on a crafted line', () => {
      writeFixtureFile(
        tmpDir,
        'go.mod',
        `module example.com/m\n\ngo 1.22\n\nrequire (\n\t${'!/'.repeat(200)}\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n`,
      );

      const start = Date.now();
      const ctx = buildProjectContext(tmpDir);

      expect(Date.now() - start).toBeLessThan(2000);
      expect(ctx.goMod?.deps).toContainEqual(
        expect.objectContaining({ name: 'github.com/gin-gonic/gin', version: 'v1.9.1' }),
      );
    });

    it('excludes manifests inside node_modules, vendor, .git, .venv, dist, build', () => {
      writeFixtureFile(
        tmpDir,
        'node_modules/bad-pkg/package.json',
        JSON.stringify({ dependencies: { 'should-not-exist': '1.0.0' } }),
      );
      writeFixtureFile(
        tmpDir,
        'vendor/bad-vendor/composer.json',
        JSON.stringify({ require: { 'should/not-exist': '1.0.0' } }),
      );
      writeFixtureFile(tmpDir, '.venv/requirements.txt', 'bad-python-dep==1.0.0\n');
      writeFixtureFile(
        tmpDir,
        'dist/package.json',
        JSON.stringify({ dependencies: { 'dist-dep': '1.0.0' } }),
      );
      writeFixtureFile(
        tmpDir,
        'build/package.json',
        JSON.stringify({ dependencies: { 'build-dep': '1.0.0' } }),
      );

      const ctx = buildProjectContext(tmpDir);
      expect(ctx.allDependencies.map((d) => d.name)).not.toContain('should-not-exist');
      expect(ctx.allDependencies.map((d) => d.name)).not.toContain('should/not-exist');
      expect(ctx.allDependencies.map((d) => d.name)).not.toContain('bad-python-dep');
      expect(ctx.allDependencies.map((d) => d.name)).not.toContain('dist-dep');
      expect(ctx.allDependencies.map((d) => d.name)).not.toContain('build-dep');
      expect(ctx.packageJson).toBeUndefined();
      expect(ctx.composerJson).toBeUndefined();
    });

    it('ignores symlinked manifest files and symlinked directories to prevent traversal', () => {
      const outsideDir = createTmpDir('trace-ctx-outside-');
      try {
        writeFixtureFile(
          outsideDir,
          'package.json',
          JSON.stringify({ dependencies: { 'escaped-dep': '1.0.0' } }),
        );

        // Symlink a file
        const symlinkFile = path.join(tmpDir, 'package.json');
        try {
          fs.symlinkSync(path.join(outsideDir, 'package.json'), symlinkFile);
        } catch {
          /* platform support */
        }

        // Symlink a directory
        const symlinkDir = path.join(tmpDir, 'symlinked-subproject');
        try {
          fs.symlinkSync(outsideDir, symlinkDir, 'dir');
        } catch {
          /* platform support */
        }

        const ctx = buildProjectContext(tmpDir);
        expect(ctx.allDependencies.map((d) => d.name)).not.toContain('escaped-dep');
        expect(ctx.packageJson).toBeUndefined();
      } finally {
        removeTmpDir(outsideDir);
      }
    });
  });

  // ========== Plugin Detection in Monorepos ==========

  describe('framework plugins with monorepo project context', () => {
    it('activates LaravelPlugin, NuxtPlugin, VueFrameworkPlugin on monorepo context', async () => {
      const { LaravelPlugin } = await import(
        '../../src/indexer/plugins/integration/framework/laravel/index.js'
      );
      const { NuxtPlugin } = await import(
        '../../src/indexer/plugins/integration/framework/nuxt/index.js'
      );
      const { VueFrameworkPlugin } = await import(
        '../../src/indexer/plugins/integration/view/vue/index.js'
      );

      writeFixtureFile(
        tmpDir,
        'thewed-laravel/composer.json',
        JSON.stringify({
          require: { 'laravel/framework': '^11.0' },
        }),
      );
      writeFixtureFile(
        tmpDir,
        'thewed-front/package.json',
        JSON.stringify({
          dependencies: { nuxt: '^3.10.0', vue: '^3.4.0' },
        }),
      );

      const ctx = buildProjectContext(tmpDir);

      const laravel = new LaravelPlugin();
      expect(laravel.detect(ctx)).toBe(true);

      const nuxt = new NuxtPlugin();
      expect(nuxt.detect(ctx)).toBe(true);

      const vue = new VueFrameworkPlugin();
      expect(vue.detect(ctx)).toBe(true);
    });
  });

  // ========== get_project_map Diagnostics ==========

  describe('get_project_map diagnostics', () => {
    it('returns diagnostic warning when frameworks is empty but artifacts exist', async () => {
      const { getProjectMap } = await import('../../src/tools/project/project.js');
      const { PluginRegistry } = await import('../../src/plugin-api/registry.js');
      const { createTestStore } = await import('../test-utils.js');

      const store = createTestStore();
      const registry = new PluginRegistry();

      const fId = store.insertFile('routes/api.php', 'php', 'h1', 100);
      store.insertRoute({ method: 'GET', uri: '/api/users', handler: 'UserController@index' }, fId);

      // Empty project context -> no frameworks detected
      const ctx = buildProjectContext(tmpDir);
      const result = getProjectMap(store, registry, false, ctx);

      expect(result.frameworks).toEqual([]);
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics?.[0]).toContain('1 routes');
      expect(result.diagnostics?.[0]).toContain('no frameworks were detected');
    });

    it('omits diagnostics when frameworks are detected', async () => {
      const { getProjectMap } = await import('../../src/tools/project/project.js');
      const { PluginRegistry } = await import('../../src/plugin-api/registry.js');
      const { LaravelPlugin } = await import(
        '../../src/indexer/plugins/integration/framework/laravel/index.js'
      );
      const { createTestStore } = await import('../test-utils.js');

      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerFrameworkPlugin(new LaravelPlugin());

      writeFixtureFile(
        tmpDir,
        'composer.json',
        JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
      );
      const ctx = buildProjectContext(tmpDir);

      const fId = store.insertFile('routes/api.php', 'php', 'h1', 100);
      store.insertRoute({ method: 'GET', uri: '/api/users', handler: 'UserController@index' }, fId);

      const result = getProjectMap(store, registry, false, ctx);
      expect(result.frameworks).toContain('laravel');
      expect(result.diagnostics).toBeUndefined();
    });
  });
});
