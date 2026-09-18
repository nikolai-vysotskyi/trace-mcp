import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import picomatch from 'picomatch';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, TraceMcpConfigSchema } from '../../src/config.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('config', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
    delete process.env.TRACE_MCP_PRESET;
  });

  it('loads defaults when no config file exists', async () => {
    tmpDir = createTmpDir('trace-mcp-test-');
    const result = await loadConfig(tmpDir);

    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.root).toBe('.');
    expect(config.include.length).toBeGreaterThan(0);
    expect(config.exclude.length).toBeGreaterThan(0);
    expect(config.plugins).toEqual([]);
  });

  it('default include globs index a FastAPI/SQLModel `app/` Python tree (regression)', async () => {
    // Regression: `app/**` previously omitted `.py`, so FastAPI/Flask/Django
    // projects that keep all code under `app/` indexed nothing but stray test
    // files. The default config must discover the whole Python source tree, and
    // must NOT descend into virtualenvs / caches.
    tmpDir = createTmpDir('trace-mcp-fastapi-');
    const files = [
      'app/main.py',
      'app/models/user.py',
      'app/routers/users.py',
      'app/services/user_service.py',
      'tests/test_users.py',
      // flat / root-package layout (no app/ wrapper)
      'routers/orders.py',
      'mypkg/core.py',
      // junk that must be excluded
      '.venv/lib/python3.12/site-packages/fastapi/__init__.py',
      'node_modules/foo/index.py',
      '__pycache__/cached.py',
    ];
    for (const f of files) {
      const abs = path.join(tmpDir, f);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'x = 1\n');
    }

    const config = (await loadConfig(tmpDir))._unsafeUnwrap();
    const matched = await fg(config.include, {
      cwd: tmpDir,
      ignore: config.exclude,
      dot: false,
      onlyFiles: true,
    });

    // Every real source file is discovered, regardless of layout.
    expect(matched).toContain('app/main.py');
    expect(matched).toContain('app/models/user.py');
    expect(matched).toContain('app/routers/users.py');
    expect(matched).toContain('app/services/user_service.py');
    expect(matched).toContain('routers/orders.py');
    expect(matched).toContain('mypkg/core.py');
    expect(matched).toContain('tests/test_users.py');

    // Virtualenv / cache / vendored dependency trees are excluded.
    expect(matched.some((m) => m.includes('.venv/'))).toBe(false);
    expect(matched.some((m) => m.includes('site-packages/'))).toBe(false);
    expect(matched.some((m) => m.includes('node_modules/'))).toBe(false);
    expect(matched.some((m) => m.includes('__pycache__/'))).toBe(false);
  });

  it('default include globs index a .NET solution with arbitrary project roots (#242)', async () => {
    // Regression: piranha.core keeps projects under core/, data/, identity/ —
    // none of the directory-rooted globs (src/, lib/, app/ ...) matched, so
    // get_outline returned NOT_FOUND for every .cs file. The global `**/*.cs`
    // include must discover them while skipping obj/ and bin/{Debug,Release}
    // build output.
    tmpDir = createTmpDir('trace-mcp-dotnet-');
    const files = [
      'core/Piranha/App.cs',
      'data/Piranha.Data.EF/Module.cs',
      'identity/Piranha.AspNetCore.Identity/Startup.cs',
      'test/Piranha.Tests/AppTests.cs',
      // build output that must be excluded
      'data/Piranha.Data.EF/obj/Debug/net8.0/Piranha.Data.EF.AssemblyInfo.cs',
      'core/Piranha/bin/Debug/net8.0/Generated.cs',
      'core/Piranha/bin/Release/net8.0/Generated.cs',
      // Rust bin convention must survive the bin/ exclusion
      'src/bin/main.rs',
    ];
    for (const f of files) {
      const abs = path.join(tmpDir, f);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '// x\n');
    }

    const config = (await loadConfig(tmpDir))._unsafeUnwrap();
    const matched = await fg(config.include, {
      cwd: tmpDir,
      ignore: config.exclude,
      dot: false,
      onlyFiles: true,
    });

    expect(matched).toContain('core/Piranha/App.cs');
    expect(matched).toContain('data/Piranha.Data.EF/Module.cs');
    expect(matched).toContain('identity/Piranha.AspNetCore.Identity/Startup.cs');
    expect(matched).toContain('test/Piranha.Tests/AppTests.cs');
    expect(matched).toContain('src/bin/main.rs');

    expect(matched.some((m) => m.includes('/obj/'))).toBe(false);
    expect(matched.some((m) => m.includes('/bin/Debug/'))).toBe(false);
    expect(matched.some((m) => m.includes('/bin/Release/'))).toBe(false);
  });

  it('default excludes skip run-artifact churn without touching real sources (TRA-1665)', async () => {
    // A watched dir a build/ML run keeps writing into overflows the OS event
    // queue → dropped events → a full-walk reconcile per drop. The defaults
    // must keep `.zig-cache/` and churn files (`*.tar.gz`, `*.bin`, `*.log`)
    // out of enumeration and the watcher, while real sources still index.
    tmpDir = createTmpDir('trace-mcp-artifacts-');
    const files = [
      'src/main.zig',
      'src/main.ts',
      // Zig build cache: generated .zig must not be enumerated.
      'work/.zig-cache/o/abc123/build.zig',
      // Run outputs with indexed-unrelated extensions.
      'work/run.log',
      'work/model.bin',
      'work/data.tar.gz',
      // Rust `src/bin/*.rs` convention must survive the `*.bin` exclusion.
      'src/bin/tool.rs',
    ];
    for (const f of files) {
      const abs = path.join(tmpDir, f);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '// x\n');
    }

    const config = (await loadConfig(tmpDir))._unsafeUnwrap();
    for (const p of ['**/.zig-cache/**', '**/*.tar.gz', '**/*.bin', '**/*.log']) {
      expect(config.exclude).toContain(p);
    }
    const matched = await fg(config.include, {
      cwd: tmpDir,
      ignore: config.exclude,
      dot: false,
      onlyFiles: true,
    });
    expect(matched).toContain('src/main.zig');
    expect(matched).toContain('src/main.ts');
    expect(matched).toContain('src/bin/tool.rs');
    expect(matched.some((m) => m.includes('.zig-cache/'))).toBe(false);

    // The file-level patterns gate the watcher (same picomatch call it uses),
    // even though fast-glob would never enumerate these extensions anyway.
    const isExcluded = picomatch(config.exclude, { dot: true });
    expect(isExcluded('work/run.log')).toBe(true);
    expect(isExcluded('work/model.bin')).toBe(true);
    expect(isExcluded('work/data.tar.gz')).toBe(true);
    expect(isExcluded('work/archive.tgz')).toBe(true);
    expect(isExcluded('src/main.ts')).toBe(false);
    expect(isExcluded('src/bin/tool.rs')).toBe(false);
  });

  it('normalizes a user .zig-cache exclude to the deep form (TRA-1665)', async () => {
    tmpDir = createTmpDir('trace-mcp-test-');
    fs.writeFileSync(
      path.join(tmpDir, '.trace-mcp.json'),
      JSON.stringify({ exclude: ['.zig-cache/**'] }),
    );

    const config = (await loadConfig(tmpDir))._unsafeUnwrap();
    expect(config.exclude).toContain('**/.zig-cache/**');
  });

  it('loads .trace-mcp.json config file', async () => {
    tmpDir = createTmpDir('trace-mcp-test-');
    const configFile = path.join(tmpDir, '.trace-mcp.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        root: './src',
        include: ['src/**/*.ts'],
        exclude: ['dist/**'],
      }),
    );

    const result = await loadConfig(tmpDir);
    expect(result.isOk()).toBe(true);

    const config = result._unsafeUnwrap();
    expect(config.root).toBe('./src');
    expect(config.include).toEqual(['src/**/*.ts']);
  });

  it('env vars override file config', async () => {
    tmpDir = createTmpDir('trace-mcp-test-');
    const configFile = path.join(tmpDir, '.trace-mcp.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        tools: { preset: 'core' },
      }),
    );

    process.env.TRACE_MCP_PRESET = 'full';

    const result = await loadConfig(tmpDir);
    expect(result.isOk()).toBe(true);

    const config = result._unsafeUnwrap();
    expect(config.tools.preset).toBe('full');
  });

  it('accepts the deprecated db.path key without acting on it (TRA-802)', () => {
    // The index location is not configurable — `getDbPath()` decides it. The
    // key stays parseable so old config files keep loading; nothing reads it.
    const result = TraceMcpConfigSchema.safeParse({ db: { path: 'legacy.db' } });

    expect(result.success).toBe(true);
  });

  it('Zod validation rejects invalid config', () => {
    const result = TraceMcpConfigSchema.safeParse({
      root: 123, // root should be string
    });

    expect(result.success).toBe(false);
  });

  it('Zod validation accepts valid partial config', () => {
    const result = TraceMcpConfigSchema.safeParse({
      root: '/my/project',
      frameworks: {
        laravel: {
          artisan: { enabled: false },
          graceful_degradation: true,
        },
      },
    });

    expect(result.success).toBe(true);
  });
});
