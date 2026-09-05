/**
 * Builds a ProjectContext by scanning manifest/config files in the given root directory
 * and subdirectories 1-2 levels deep (monorepos / multi-app directories).
 *
 * Detects: package.json, composer.json, pyproject.toml, requirements.txt,
 * go.mod, Cargo.toml, Gemfile, pom.xml, build.gradle(.kts),
 * .nvmrc, .node-version, .python-version, .ruby-version, .tool-versions
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DetectedVersion, ParsedDependency, ProjectContext } from '../plugin-api/types.js';
import { validatePath } from '../utils/security.js';

const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  'target',
  'bin',
  'obj',
  'coverage',
  '.turbo',
  '.cache',
  '.pytest_cache',
  '__pycache__',
  '.idea',
  '.vscode',
  '.svn',
  '.hg',
  '.tox',
  '.venv',
  'venv',
  'env',
  '.env',
  'nova-components',
]);

const NPM_TOOL_RUNTIMES: Record<string, string> = {
  typescript: 'typescript',
  sass: 'sass',
  'node-sass': 'sass',
  less: 'less',
  stylus: 'stylus',
  tailwindcss: 'tailwindcss',
  postcss: 'postcss',
  autoprefixer: 'autoprefixer',
  webpack: 'webpack',
  vite: 'vite',
  esbuild: 'esbuild',
  tsup: 'tsup',
  rollup: 'rollup',
  'babel-core': 'babel',
  '@babel/core': 'babel',
  eslint: 'eslint',
  prettier: 'prettier',
  jest: 'jest',
  vitest: 'vitest',
  mocha: 'mocha',
  react: 'react',
  'react-dom': 'react',
  vue: 'vue',
  svelte: 'svelte',
  next: 'nextjs',
  nuxt: 'nuxt',
  '@angular/core': 'angular',
  express: 'express',
  fastify: 'fastify',
  hono: 'hono',
  prisma: 'prisma',
  '@prisma/client': 'prisma',
  'drizzle-orm': 'drizzle',
  electron: 'electron',
  'react-native': 'react-native',
};

const COMPOSER_TOOL_RUNTIMES: Record<string, string> = {
  'laravel/framework': 'laravel',
  'symfony/symfony': 'symfony',
  'symfony/framework-bundle': 'symfony',
  'filp/whoops': 'whoops',
  'phpunit/phpunit': 'phpunit',
  'pestphp/pest': 'pest',
  'nunomaduro/larastan': 'larastan',
  'phpstan/phpstan': 'phpstan',
  'laravel/sanctum': 'sanctum',
  'laravel/passport': 'passport',
  'inertiajs/inertia-laravel': 'inertia',
  'livewire/livewire': 'livewire',
  'filament/filament': 'filament',
  'spatie/laravel-permission': 'spatie-permission',
};

const CONFIG_FILE_NAMES = [
  'components.json', // shadcn/ui
  'nuxt.config.ts',
  'nuxt.config.js',
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'tailwind.config.ts',
  'tailwind.config.js',
  'tailwind.config.mjs',
  'postcss.config.js',
  'postcss.config.mjs',
  'postcss.config.cjs',
  'app.config.ts',
  'app.config.js', // Nuxt UI theme
  'tsconfig.json',
  'jsconfig.json',
  '.eslintrc.js',
  '.eslintrc.json',
  'eslint.config.js',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierrc.json',
  'prettier.config.js',
  'vitest.config.ts',
  'vitest.config.js',
  'jest.config.ts',
  'jest.config.js',
  'webpack.config.js',
  'webpack.config.ts',
  'turbo.json',
  'nx.json',
  '.env',
  '.env.local',
  '.env.production',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Dockerfile',
];

function findScanDirectories(rootPath: string): string[] {
  const normalizedRoot = path.resolve(rootPath);
  const dirs: string[] = [normalizedRoot];
  try {
    const level1 = fs.readdirSync(normalizedRoot, { withFileTypes: true });
    for (const e1 of level1) {
      if (!e1.isDirectory() || e1.name.startsWith('.') || SKIP_DIRS.has(e1.name)) continue;
      const check1 = validatePath(e1.name, normalizedRoot);
      if (check1.isErr()) continue;
      const d1 = path.join(normalizedRoot, e1.name);
      try {
        if (fs.lstatSync(d1).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      dirs.push(d1);
      try {
        const level2 = fs.readdirSync(d1, { withFileTypes: true });
        for (const e2 of level2) {
          if (!e2.isDirectory() || e2.name.startsWith('.') || SKIP_DIRS.has(e2.name)) continue;
          const rel2 = path.join(e1.name, e2.name);
          const check2 = validatePath(rel2, normalizedRoot);
          if (check2.isErr()) continue;
          const d2 = path.join(d1, e2.name);
          try {
            if (fs.lstatSync(d2).isSymbolicLink()) continue;
          } catch {
            continue;
          }
          dirs.push(d2);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return dirs;
}

export function buildProjectContext(rootPath: string): ProjectContext {
  const detectedVersions: DetectedVersion[] = [];
  const allDependencies: ParsedDependency[] = [];
  const configFiles: string[] = [];

  const addDependency = (dep: ParsedDependency) => {
    const exists = allDependencies.some(
      (d) => d.name === dep.name && d.dev === dep.dev && d.version === dep.version,
    );
    if (!exists) {
      allDependencies.push(dep);
    }
  };

  const addDetectedVersion = (ver: DetectedVersion) => {
    const exists = detectedVersions.some(
      (v) => v.runtime === ver.runtime && v.version === ver.version && v.source === ver.source,
    );
    if (!exists) {
      detectedVersions.push(ver);
    }
  };

  // One readdir per scanned directory, instead of an lstat+open per candidate
  // filename. ~60 manifest/config names are probed per directory and a monorepo
  // scan visits hundreds of directories, so the misses — not the hits — were the
  // cost: 245 ms of blocking syscalls per pipeline run on this repo (TRA-922).
  const dirEntries = new Map<string, Set<string>>();
  const plainFilesIn = (dir: string): Set<string> => {
    let names = dirEntries.get(dir);
    if (names) return names;
    names = new Set<string>();
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        // Symlinks stay excluded, same as the previous per-file lstat check.
        if (e.isFile()) names.add(e.name);
      }
    } catch {
      /* unreadable dir → no candidates */
    }
    dirEntries.set(dir, names);
    return names;
  };

  const readFile = (dir: string, file: string): string | undefined => {
    try {
      if (!plainFilesIn(dir).has(file)) return undefined;
      const fullPath = path.resolve(dir, file);
      const relToRoot = path.relative(rootPath, fullPath);
      const check = validatePath(relToRoot, rootPath);
      if (check.isErr()) return undefined;
      return fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return undefined;
    }
  };

  const scanDirs = findScanDirectories(rootPath);

  let packageJson: Record<string, unknown> | undefined;
  let composerJson: Record<string, unknown> | undefined;
  let pyprojectToml: Record<string, unknown> | undefined;
  let requirementsTxt: string[] | undefined;
  let goMod: ProjectContext['goMod'];
  let cargoToml: ProjectContext['cargoToml'];
  let gemfile: ProjectContext['gemfile'];
  let pomXml: ProjectContext['pomXml'];
  let buildGradle: ProjectContext['buildGradle'];

  for (const dir of scanDirs) {
    const isRoot = dir === rootPath;
    const relDir = path.relative(rootPath, dir).replace(/\\/g, '/');
    const getRelPath = (file: string) => (relDir ? `${relDir}/${file}` : file);

    // ========== package.json ==========
    const pkgRaw = readFile(dir, 'package.json');
    if (pkgRaw) {
      try {
        const parsed = JSON.parse(pkgRaw) as Record<string, unknown>;
        if (isRoot) {
          packageJson = { ...parsed };
        } else if (!packageJson) {
          packageJson = {
            dependencies: {},
            devDependencies: {},
            peerDependencies: {},
          };
        }

        const pkgDeps = (packageJson.dependencies ?? {}) as Record<string, string>;
        const pkgDevDeps = (packageJson.devDependencies ?? {}) as Record<string, string>;
        const pkgPeerDeps = (packageJson.peerDependencies ?? {}) as Record<string, string>;
        packageJson.dependencies = pkgDeps;
        packageJson.devDependencies = pkgDevDeps;
        packageJson.peerDependencies = pkgPeerDeps;

        // Extract engines
        const engines = parsed.engines as Record<string, string> | undefined;
        if (engines) {
          if (engines.node) {
            addDetectedVersion({
              runtime: 'node',
              version: engines.node,
              source: `${getRelPath('package.json')}#engines.node`,
            });
          }
          if (engines.npm) {
            addDetectedVersion({
              runtime: 'npm',
              version: engines.npm,
              source: `${getRelPath('package.json')}#engines.npm`,
            });
          }
          if (isRoot && !packageJson.engines) {
            packageJson.engines = engines;
          }
        }

        // Extract deps
        const allPkgDeps: Record<string, string> = {};
        for (const [section, dev] of [
          ['dependencies', false],
          ['devDependencies', true],
          ['peerDependencies', false],
        ] as const) {
          const deps = parsed[section] as Record<string, string> | undefined;
          if (deps) {
            const targetMap =
              section === 'dependencies'
                ? pkgDeps
                : section === 'devDependencies'
                  ? pkgDevDeps
                  : pkgPeerDeps;
            for (const [name, version] of Object.entries(deps)) {
              addDependency({ name, version, dev: dev || undefined });
              allPkgDeps[name] = version;
              if (targetMap[name] === undefined) {
                targetMap[name] = version;
              }
            }
          }
        }

        // Extract notable tool/runtime versions as detectedVersions
        for (const [pkg, runtime] of Object.entries(NPM_TOOL_RUNTIMES)) {
          const ver = allPkgDeps[pkg];
          if (ver) {
            addDetectedVersion({
              runtime,
              version: ver,
              source: `${getRelPath('package.json')}#${pkg}`,
            });
          }
        }
      } catch {
        /* malformed JSON */
      }
    }

    // ========== .nvmrc / .node-version ==========
    for (const file of ['.nvmrc', '.node-version']) {
      const content = readFile(dir, file)?.trim();
      if (content) {
        const ver = content.replace(/^v/i, '');
        addDetectedVersion({ runtime: 'node', version: ver, source: getRelPath(file) });
        break; // prefer .nvmrc over .node-version within this directory
      }
    }

    // ========== composer.json ==========
    const composerRaw = readFile(dir, 'composer.json');
    if (composerRaw) {
      try {
        const parsed = JSON.parse(composerRaw) as Record<string, unknown>;
        if (isRoot) {
          composerJson = { ...parsed };
        } else if (!composerJson) {
          composerJson = {
            require: {},
            'require-dev': {},
          };
        }

        const compReq = (composerJson.require ?? {}) as Record<string, string>;
        const compReqDev = (composerJson['require-dev'] ?? {}) as Record<string, string>;
        composerJson.require = compReq;
        composerJson['require-dev'] = compReqDev;

        const require_ = parsed.require as Record<string, string> | undefined;
        const requireDev = parsed['require-dev'] as Record<string, string> | undefined;

        if (require_?.php) {
          addDetectedVersion({
            runtime: 'php',
            version: require_.php,
            source: `${getRelPath('composer.json')}#require.php`,
          });
        }

        const allComposerDeps: Record<string, string> = {};
        for (const [section, dev, targetMap] of [
          [require_, false, compReq],
          [requireDev, true, compReqDev],
        ] as const) {
          if (section) {
            for (const [name, version] of Object.entries(section)) {
              if (name === 'php') continue;
              addDependency({ name, version, dev: dev || undefined });
              allComposerDeps[name] = version;
              if (targetMap[name] === undefined) {
                targetMap[name] = version;
              }
            }
          }
        }

        for (const [pkg, runtime] of Object.entries(COMPOSER_TOOL_RUNTIMES)) {
          const ver = allComposerDeps[pkg];
          if (ver) {
            addDetectedVersion({
              runtime,
              version: ver,
              source: `${getRelPath('composer.json')}#${pkg}`,
            });
          }
        }
      } catch {
        /* malformed JSON */
      }
    }

    // ========== pyproject.toml ==========
    const tomlRaw = readFile(dir, 'pyproject.toml');
    if (tomlRaw) {
      const deps: string[] = [];
      const parsedDeps: ParsedDependency[] = [];
      const depBlockRe = /\[(?:project|tool\.poetry)\.?dependencies\]([^[]*)/g;
      let m: RegExpExecArray | null;
      while ((m = depBlockRe.exec(tomlRaw)) !== null) {
        const block = m[1];
        for (const line of block.split('\n')) {
          const pkg = line.match(/^\s*([a-zA-Z0-9_-]+)\s*=\s*["']?([^"'\n]*)/);
          if (pkg) {
            deps.push(pkg[1].toLowerCase());
            parsedDeps.push({ name: pkg[1].toLowerCase(), version: pkg[2]?.trim() || undefined });
          }
        }
      }
      const inlineDeps = tomlRaw.match(/dependencies\s*=\s*\[([^\]]*)\]/);
      if (inlineDeps) {
        const items = inlineDeps[1].matchAll(/["']([a-zA-Z0-9_-]+)([^"']*)["']/g);
        for (const item of items) {
          deps.push(item[1].toLowerCase());
          parsedDeps.push({ name: item[1].toLowerCase(), version: item[2]?.trim() || undefined });
        }
      }
      const pyReq = tomlRaw.match(/requires-python\s*=\s*["']([^"']+)["']/);
      if (pyReq) {
        addDetectedVersion({
          runtime: 'python',
          version: pyReq[1],
          source: `${getRelPath('pyproject.toml')}#requires-python`,
        });
      }
      for (const d of parsedDeps) {
        addDependency(d);
      }
      if (!pyprojectToml) {
        pyprojectToml = { _parsedDeps: deps, _raw: tomlRaw } as Record<string, unknown>;
      } else {
        const existing = (pyprojectToml._parsedDeps as string[]) ?? [];
        for (const d of deps) {
          if (!existing.includes(d)) existing.push(d);
        }
        pyprojectToml._parsedDeps = existing;
      }
    }

    // ========== .python-version ==========
    const pyVer = readFile(dir, '.python-version')?.trim();
    if (pyVer) {
      addDetectedVersion({
        runtime: 'python',
        version: pyVer,
        source: getRelPath('.python-version'),
      });
    }

    // ========== requirements.txt ==========
    const reqRaw = readFile(dir, 'requirements.txt');
    if (reqRaw) {
      const lines = reqRaw
        .split('\n')
        .map((l) => l.replace(/#.*/, '').trim())
        .filter((l) => l && !l.startsWith('-'));
      const parsedReqNames = lines.map((l) =>
        l
          .split(/[>=<![;]/)[0]
          .trim()
          .toLowerCase(),
      );
      if (!requirementsTxt) {
        requirementsTxt = [...parsedReqNames];
      } else {
        for (const name of parsedReqNames) {
          if (!requirementsTxt.includes(name)) requirementsTxt.push(name);
        }
      }
      for (const l of lines) {
        const parts = l.match(/^([a-zA-Z0-9_.-]+)\s*(.*)/);
        if (parts) {
          addDependency({ name: parts[1].toLowerCase(), version: parts[2] || undefined });
        }
      }
    }

    // ========== go.mod ==========
    const goModRaw = readFile(dir, 'go.mod');
    if (goModRaw) {
      const modMatch = goModRaw.match(/^module\s+(.+)/m);
      const goVerMatch = goModRaw.match(/^go\s+([\d.]+)/m);
      const goDeps: ParsedDependency[] = [];
      const reqBlock = goModRaw.match(/require\s*\(([\s\S]*?)\)/);
      if (reqBlock) {
        for (const line of reqBlock[1].split('\n')) {
          // Each path segment excludes '/' as well as whitespace: with `[^\s]+`
          // inside the repeated group the same "a/b/c" is matchable in 2^n ways,
          // which is exponential backtracking on a crafted go.mod (js/redos).
          const dep = line.match(/^\s*([^\s/]+(?:\/[^\s/]+)*)\s+(v[\d.]+\S*)/);
          if (dep) goDeps.push({ name: dep[1], version: dep[2] });
        }
      }
      const singleReqs = goModRaw.matchAll(/^require\s+([^\s(]+)\s+(v[\d.]+\S*)/gm);
      for (const sr of singleReqs) goDeps.push({ name: sr[1], version: sr[2] });
      if (goVerMatch) {
        addDetectedVersion({ runtime: 'go', version: goVerMatch[1], source: getRelPath('go.mod') });
      }
      for (const d of goDeps) {
        addDependency(d);
      }
      if (!goMod) {
        goMod = { module: modMatch?.[1] ?? '', goVersion: goVerMatch?.[1], deps: goDeps };
      } else {
        for (const d of goDeps) {
          if (!goMod.deps.some((existing) => existing.name === d.name)) {
            goMod.deps.push(d);
          }
        }
      }
    }

    // ========== Cargo.toml ==========
    const cargoRaw = readFile(dir, 'Cargo.toml');
    if (cargoRaw) {
      const cargoDeps: ParsedDependency[] = [];
      for (const [sectionName, dev] of [
        ['dependencies', false],
        ['dev-dependencies', true],
      ] as const) {
        const sectionRe = new RegExp(`\\[${sectionName}\\]([^\\[]*)`, 'g');
        let sm: RegExpExecArray | null;
        while ((sm = sectionRe.exec(cargoRaw)) !== null) {
          for (const line of sm[1].split('\n')) {
            const dep = line.match(
              /^\s*([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]+)"|.*version\s*=\s*"([^"]+)")/,
            );
            if (dep) {
              cargoDeps.push({ name: dep[1], version: dep[2] ?? dep[3], dev: dev || undefined });
            }
          }
        }
      }
      const editionMatch = cargoRaw.match(/edition\s*=\s*"(\d{4})"/);
      if (editionMatch) {
        addDetectedVersion({
          runtime: 'rust',
          version: `edition-${editionMatch[1]}`,
          source: `${getRelPath('Cargo.toml')}#edition`,
        });
      }
      const rustVersionMatch = cargoRaw.match(/rust-version\s*=\s*"([^"]+)"/);
      if (rustVersionMatch) {
        addDetectedVersion({
          runtime: 'rust',
          version: rustVersionMatch[1],
          source: `${getRelPath('Cargo.toml')}#rust-version`,
        });
      }
      const pkgSection = cargoRaw.match(/\[package\]([\s\S]*?)(?:\[|$)/);
      let pkgMeta: Record<string, unknown> | undefined;
      if (pkgSection) {
        const nameMatch = pkgSection[1].match(/name\s*=\s*"([^"]+)"/);
        const verMatch = pkgSection[1].match(/version\s*=\s*"([^"]+)"/);
        pkgMeta = { name: nameMatch?.[1], version: verMatch?.[1] };
      }
      for (const d of cargoDeps) {
        addDependency(d);
      }
      if (!cargoToml) {
        cargoToml = { package: pkgMeta, deps: cargoDeps };
      } else {
        for (const d of cargoDeps) {
          if (!cargoToml.deps.some((existing) => existing.name === d.name)) {
            cargoToml.deps.push(d);
          }
        }
      }
    }

    // ========== Gemfile ==========
    const gemfileRaw = readFile(dir, 'Gemfile');
    if (gemfileRaw) {
      const gemDeps: ParsedDependency[] = [];
      const gemLines = gemfileRaw.matchAll(
        /^\s*gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?/gm,
      );
      for (const gl of gemLines) {
        gemDeps.push({ name: gl[1], version: gl[2] || undefined });
      }
      for (const d of gemDeps) {
        addDependency(d);
      }
      if (!gemfile) {
        gemfile = { deps: gemDeps };
      } else {
        for (const d of gemDeps) {
          if (!gemfile.deps.some((existing) => existing.name === d.name)) {
            gemfile.deps.push(d);
          }
        }
      }
    }

    // ========== .ruby-version ==========
    const rubyVer = readFile(dir, '.ruby-version')?.trim();
    if (rubyVer) {
      addDetectedVersion({
        runtime: 'ruby',
        version: rubyVer.replace(/^ruby-/, ''),
        source: getRelPath('.ruby-version'),
      });
    }

    // ========== pom.xml (lightweight) ==========
    const pomRaw = readFile(dir, 'pom.xml');
    if (pomRaw) {
      const pomDeps: ParsedDependency[] = [];
      const depMatches = pomRaw.matchAll(
        /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g,
      );
      for (const dm of depMatches) {
        pomDeps.push({ name: `${dm[1]}:${dm[2]}`, version: dm[3] || undefined });
      }
      const groupId = pomRaw.match(/<project[^>]*>[\s\S]*?<groupId>([^<]+)<\/groupId>/)?.[1];
      const artifactId = pomRaw.match(
        /<project[^>]*>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/,
      )?.[1];
      const pomVersion = pomRaw.match(/<project[^>]*>[\s\S]*?<version>([^<]+)<\/version>/)?.[1];
      const javaSource =
        pomRaw.match(/<maven\.compiler\.source>([^<]+)<\/maven\.compiler\.source>/)?.[1] ??
        pomRaw.match(/<java\.version>([^<]+)<\/java\.version>/)?.[1] ??
        pomRaw.match(/<release>([^<]+)<\/release>/)?.[1];
      if (javaSource) {
        addDetectedVersion({ runtime: 'java', version: javaSource, source: getRelPath('pom.xml') });
      }
      for (const d of pomDeps) {
        addDependency(d);
      }
      if (!pomXml) {
        pomXml = { groupId, artifactId, version: pomVersion, deps: pomDeps };
      } else {
        for (const d of pomDeps) {
          if (!pomXml.deps.some((existing) => existing.name === d.name)) {
            pomXml.deps.push(d);
          }
        }
      }
    }

    // ========== build.gradle / build.gradle.kts ==========
    const gradleRaw = readFile(dir, 'build.gradle') ?? readFile(dir, 'build.gradle.kts');
    if (gradleRaw) {
      const gradleDeps: ParsedDependency[] = [];
      const depLines = gradleRaw.matchAll(
        /(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*[("']([^)'"]+)[)'"]/g,
      );
      for (const dl of depLines) {
        const parts = dl[1].split(':');
        if (parts.length >= 2) {
          gradleDeps.push({ name: `${parts[0]}:${parts[1]}`, version: parts[2] || undefined });
        }
      }
      const javaSrcCompat =
        gradleRaw.match(/sourceCompatibility\s*=\s*['"]?([^'"\s\n]+)/)?.[1] ??
        gradleRaw.match(/JavaVersion\.VERSION_(\d+)/)?.[1];
      const gradleFileName = readFile(dir, 'build.gradle') ? 'build.gradle' : 'build.gradle.kts';
      if (javaSrcCompat) {
        addDetectedVersion({
          runtime: 'java',
          version: javaSrcCompat,
          source: getRelPath(gradleFileName),
        });
      }
      for (const d of gradleDeps) {
        addDependency(d);
      }
      if (!buildGradle) {
        buildGradle = { deps: gradleDeps };
      } else {
        for (const d of gradleDeps) {
          if (!buildGradle.deps.some((existing) => existing.name === d.name)) {
            buildGradle.deps.push(d);
          }
        }
      }
    }

    // ========== .tool-versions (asdf) ==========
    const toolVersions = readFile(dir, '.tool-versions');
    if (toolVersions) {
      for (const line of toolVersions.split('\n')) {
        const parts = line.trim().match(/^(\S+)\s+(\S+)/);
        if (parts) {
          const runtimeMap: Record<string, string> = {
            nodejs: 'node',
            python: 'python',
            ruby: 'ruby',
            golang: 'go',
            java: 'java',
            rust: 'rust',
          };
          const rt = runtimeMap[parts[1]] ?? parts[1];
          addDetectedVersion({
            runtime: rt,
            version: parts[2],
            source: getRelPath('.tool-versions'),
          });
        }
      }
    }

    // ========== Config files scan ==========
    const present = plainFilesIn(dir);
    for (const name of CONFIG_FILE_NAMES) {
      if (!present.has(name)) continue;
      const fullPath = path.resolve(dir, name);
      const relToRoot = path.relative(rootPath, fullPath);
      if (validatePath(relToRoot, rootPath).isErr()) continue;
      configFiles.push(getRelPath(name));
    }
  }

  // Scan .github/workflows for CI/CD files
  try {
    const ghWorkflowDir = path.resolve(rootPath, '.github/workflows');
    const check = validatePath('.github/workflows', rootPath);
    if (check.isOk()) {
      try {
        if (!fs.lstatSync(ghWorkflowDir).isSymbolicLink()) {
          const entries = fs.readdirSync(ghWorkflowDir);
          for (const entry of entries) {
            if (entry.endsWith('.yml') || entry.endsWith('.yaml')) {
              const rel = `.github/workflows/${entry}`;
              if (validatePath(rel, rootPath).isOk()) {
                configFiles.push(rel);
              }
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* no .github/workflows */
  }

  return {
    rootPath,
    packageJson,
    composerJson,
    pyprojectToml,
    requirementsTxt,
    goMod,
    cargoToml,
    gemfile,
    pomXml,
    buildGradle,
    detectedVersions,
    allDependencies,
    configFiles,
  };
}
