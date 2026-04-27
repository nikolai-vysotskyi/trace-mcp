/**
 * Builds a ProjectContext by scanning manifest/config files in the given root directory.
 *
 * Detects: package.json, composer.json, pyproject.toml, requirements.txt,
 * go.mod, Cargo.toml, Gemfile, pom.xml, build.gradle(.kts),
 * .nvmrc, .node-version, .python-version, .ruby-version, .tool-versions
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectContext, DetectedVersion, ParsedDependency } from '../plugin-api/types.js';

export function buildProjectContext(rootPath: string): ProjectContext {
  const detectedVersions: DetectedVersion[] = [];
  const allDependencies: ParsedDependency[] = [];

  // --- Helper: read file safely ---
  const readFile = (rel: string): string | undefined => {
    try {
      return fs.readFileSync(path.resolve(rootPath, rel), 'utf-8');
    } catch {
      return undefined;
    }
  };

  // ========== package.json ==========
  let packageJson: Record<string, unknown> | undefined;
  const pkgRaw = readFile('package.json');
  if (pkgRaw) {
    try {
      packageJson = JSON.parse(pkgRaw) as Record<string, unknown>;
      // Extract engines
      const engines = packageJson.engines as Record<string, string> | undefined;
      if (engines) {
        if (engines.node)
          detectedVersions.push({
            runtime: 'node',
            version: engines.node,
            source: 'package.json#engines.node',
          });
        if (engines.npm)
          detectedVersions.push({
            runtime: 'npm',
            version: engines.npm,
            source: 'package.json#engines.npm',
          });
      }
      // Extract deps
      const allPkgDeps: Record<string, string> = {};
      for (const [section, dev] of [
        ['dependencies', false],
        ['devDependencies', true],
        ['peerDependencies', false],
      ] as const) {
        const deps = packageJson[section] as Record<string, string> | undefined;
        if (deps) {
          for (const [name, version] of Object.entries(deps)) {
            allDependencies.push({ name, version, dev: dev || undefined });
            allPkgDeps[name] = version;
          }
        }
      }
      // Extract notable tool/runtime versions as detectedVersions
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
      for (const [pkg, runtime] of Object.entries(NPM_TOOL_RUNTIMES)) {
        const ver = allPkgDeps[pkg];
        if (ver) {
          detectedVersions.push({ runtime, version: ver, source: `package.json#${pkg}` });
        }
      }
    } catch {
      /* malformed JSON */
    }
  }

  // ========== .nvmrc / .node-version ==========
  for (const file of ['.nvmrc', '.node-version']) {
    const content = readFile(file)?.trim();
    if (content) {
      const ver = content.replace(/^v/i, '');
      detectedVersions.push({ runtime: 'node', version: ver, source: file });
      break; // prefer .nvmrc over .node-version
    }
  }

  // ========== composer.json ==========
  let composerJson: Record<string, unknown> | undefined;
  const composerRaw = readFile('composer.json');
  if (composerRaw) {
    try {
      composerJson = JSON.parse(composerRaw) as Record<string, unknown>;
      const require_ = composerJson.require as Record<string, string> | undefined;
      const requireDev = composerJson['require-dev'] as Record<string, string> | undefined;
      if (require_?.['php'])
        detectedVersions.push({
          runtime: 'php',
          version: require_['php'],
          source: 'composer.json#require.php',
        });
      const allComposerDeps: Record<string, string> = {};
      for (const [section, dev] of [
        [require_, false],
        [requireDev, true],
      ] as const) {
        if (section) {
          for (const [name, version] of Object.entries(section)) {
            if (name === 'php') continue;
            allDependencies.push({ name, version, dev: dev || undefined });
            allComposerDeps[name] = version;
          }
        }
      }
      // Notable PHP ecosystem tool versions
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
      for (const [pkg, runtime] of Object.entries(COMPOSER_TOOL_RUNTIMES)) {
        const ver = allComposerDeps[pkg];
        if (ver) {
          detectedVersions.push({ runtime, version: ver, source: `composer.json#${pkg}` });
        }
      }
    } catch {
      /* malformed JSON */
    }
  }

  // ========== pyproject.toml ==========
  let pyprojectToml: Record<string, unknown> | undefined;
  const tomlRaw = readFile('pyproject.toml');
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
    // Inline dependencies array: dependencies = ["fastapi>=0.100", ...]
    const inlineDeps = tomlRaw.match(/dependencies\s*=\s*\[([^\]]*)\]/);
    if (inlineDeps) {
      const items = inlineDeps[1].matchAll(/["']([a-zA-Z0-9_-]+)([^"']*)["']/g);
      for (const item of items) {
        deps.push(item[1].toLowerCase());
        parsedDeps.push({ name: item[1].toLowerCase(), version: item[2]?.trim() || undefined });
      }
    }
    // Python version requirement
    const pyReq = tomlRaw.match(/requires-python\s*=\s*["']([^"']+)["']/);
    if (pyReq)
      detectedVersions.push({
        runtime: 'python',
        version: pyReq[1],
        source: 'pyproject.toml#requires-python',
      });
    allDependencies.push(...parsedDeps);
    pyprojectToml = { _parsedDeps: deps, _raw: tomlRaw } as Record<string, unknown>;
  }

  // ========== .python-version ==========
  const pyVer = readFile('.python-version')?.trim();
  if (pyVer)
    detectedVersions.push({ runtime: 'python', version: pyVer, source: '.python-version' });

  // ========== requirements.txt ==========
  let requirementsTxt: string[] | undefined;
  const reqRaw = readFile('requirements.txt');
  if (reqRaw) {
    const lines = reqRaw
      .split('\n')
      .map((l) => l.replace(/#.*/, '').trim())
      .filter((l) => l && !l.startsWith('-'));
    requirementsTxt = lines.map((l) =>
      l
        .split(/[>=<!\[;]/)[0]
        .trim()
        .toLowerCase(),
    );
    for (const l of lines) {
      const parts = l.match(/^([a-zA-Z0-9_.-]+)\s*(.*)/);
      if (parts)
        allDependencies.push({ name: parts[1].toLowerCase(), version: parts[2] || undefined });
    }
  }

  // ========== go.mod ==========
  let goMod: ProjectContext['goMod'];
  const goModRaw = readFile('go.mod');
  if (goModRaw) {
    const modMatch = goModRaw.match(/^module\s+(.+)/m);
    const goVerMatch = goModRaw.match(/^go\s+([\d.]+)/m);
    const goDeps: ParsedDependency[] = [];
    const reqBlock = goModRaw.match(/require\s*\(([\s\S]*?)\)/);
    if (reqBlock) {
      for (const line of reqBlock[1].split('\n')) {
        const dep = line.match(/^\s*([^\s/]+(?:\/[^\s]+)*)\s+(v[\d.]+\S*)/);
        if (dep) goDeps.push({ name: dep[1], version: dep[2] });
      }
    }
    const singleReqs = goModRaw.matchAll(/^require\s+([^\s(]+)\s+(v[\d.]+\S*)/gm);
    for (const sr of singleReqs) goDeps.push({ name: sr[1], version: sr[2] });
    if (goVerMatch)
      detectedVersions.push({ runtime: 'go', version: goVerMatch[1], source: 'go.mod' });
    goMod = { module: modMatch?.[1] ?? '', goVersion: goVerMatch?.[1], deps: goDeps };
    allDependencies.push(...goDeps);
  }

  // ========== Cargo.toml ==========
  let cargoToml: ProjectContext['cargoToml'];
  const cargoRaw = readFile('Cargo.toml');
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
          if (dep)
            cargoDeps.push({ name: dep[1], version: dep[2] ?? dep[3], dev: dev || undefined });
        }
      }
    }
    const editionMatch = cargoRaw.match(/edition\s*=\s*"(\d{4})"/);
    if (editionMatch)
      detectedVersions.push({
        runtime: 'rust',
        version: `edition-${editionMatch[1]}`,
        source: 'Cargo.toml#edition',
      });
    const rustVersionMatch = cargoRaw.match(/rust-version\s*=\s*"([^"]+)"/);
    if (rustVersionMatch)
      detectedVersions.push({
        runtime: 'rust',
        version: rustVersionMatch[1],
        source: 'Cargo.toml#rust-version',
      });
    const pkgSection = cargoRaw.match(/\[package\]([\s\S]*?)(?:\[|$)/);
    let pkgMeta: Record<string, unknown> | undefined;
    if (pkgSection) {
      const nameMatch = pkgSection[1].match(/name\s*=\s*"([^"]+)"/);
      const verMatch = pkgSection[1].match(/version\s*=\s*"([^"]+)"/);
      pkgMeta = { name: nameMatch?.[1], version: verMatch?.[1] };
    }
    cargoToml = { package: pkgMeta, deps: cargoDeps };
    allDependencies.push(...cargoDeps);
  }

  // ========== Gemfile ==========
  let gemfile: ProjectContext['gemfile'];
  const gemfileRaw = readFile('Gemfile');
  if (gemfileRaw) {
    const gemDeps: ParsedDependency[] = [];
    const gemLines = gemfileRaw.matchAll(
      /^\s*gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?/gm,
    );
    for (const gl of gemLines) {
      gemDeps.push({ name: gl[1], version: gl[2] || undefined });
    }
    gemfile = { deps: gemDeps };
    allDependencies.push(...gemDeps);
  }

  // ========== .ruby-version ==========
  const rubyVer = readFile('.ruby-version')?.trim();
  if (rubyVer)
    detectedVersions.push({
      runtime: 'ruby',
      version: rubyVer.replace(/^ruby-/, ''),
      source: '.ruby-version',
    });

  // ========== pom.xml (lightweight) ==========
  let pomXml: ProjectContext['pomXml'];
  const pomRaw = readFile('pom.xml');
  if (pomRaw) {
    const pomDeps: ParsedDependency[] = [];
    const depMatches = pomRaw.matchAll(
      /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g,
    );
    for (const dm of depMatches) {
      pomDeps.push({ name: `${dm[1]}:${dm[2]}`, version: dm[3] || undefined });
    }
    const groupId = pomRaw.match(/<project[^>]*>[\s\S]*?<groupId>([^<]+)<\/groupId>/)?.[1];
    const artifactId = pomRaw.match(/<project[^>]*>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/)?.[1];
    const pomVersion = pomRaw.match(/<project[^>]*>[\s\S]*?<version>([^<]+)<\/version>/)?.[1];
    const javaSource =
      pomRaw.match(/<maven\.compiler\.source>([^<]+)<\/maven\.compiler\.source>/)?.[1] ??
      pomRaw.match(/<java\.version>([^<]+)<\/java\.version>/)?.[1] ??
      pomRaw.match(/<release>([^<]+)<\/release>/)?.[1];
    if (javaSource)
      detectedVersions.push({ runtime: 'java', version: javaSource, source: 'pom.xml' });
    pomXml = { groupId, artifactId, version: pomVersion, deps: pomDeps };
    allDependencies.push(...pomDeps);
  }

  // ========== build.gradle / build.gradle.kts ==========
  let buildGradle: ProjectContext['buildGradle'];
  const gradleRaw = readFile('build.gradle') ?? readFile('build.gradle.kts');
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
    if (javaSrcCompat)
      detectedVersions.push({ runtime: 'java', version: javaSrcCompat, source: 'build.gradle' });
    buildGradle = { deps: gradleDeps };
    allDependencies.push(...gradleDeps);
  }

  // ========== .tool-versions (asdf) ==========
  const toolVersions = readFile('.tool-versions');
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
        detectedVersions.push({ runtime: rt, version: parts[2], source: '.tool-versions' });
      }
    }
  }

  // ========== Config files scan ==========
  const configFiles: string[] = [];
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
  for (const name of CONFIG_FILE_NAMES) {
    try {
      fs.accessSync(path.resolve(rootPath, name));
      configFiles.push(name);
    } catch {
      /* not found */
    }
  }

  // Scan .github/workflows for CI/CD files
  try {
    const ghWorkflowDir = path.resolve(rootPath, '.github/workflows');
    const entries = fs.readdirSync(ghWorkflowDir);
    for (const entry of entries) {
      if (entry.endsWith('.yml') || entry.endsWith('.yaml')) {
        configFiles.push(`.github/workflows/${entry}`);
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
