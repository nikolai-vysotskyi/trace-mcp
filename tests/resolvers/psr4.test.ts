import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Psr4Resolver } from '../../src/indexer/resolvers/psr4.js';

describe('PSR-4 resolver', () => {
  // ---------- forward resolution ----------

  it('resolves FQN to file path (basic)', () => {
    const resolver = new Psr4Resolver(new Map([['App\\', 'app/']]), '/project');
    expect(resolver.resolve('App\\Models\\User')).toBe('app/Models/User.php');
  });

  it('resolves FQN with nested namespace', () => {
    const resolver = new Psr4Resolver(new Map([['App\\', 'app/']]), '/project');
    expect(resolver.resolve('App\\Http\\Controllers\\Auth\\LoginController')).toBe(
      'app/Http/Controllers/Auth/LoginController.php',
    );
  });

  it('matches longest prefix first', () => {
    const resolver = new Psr4Resolver(
      new Map([
        ['App\\', 'app/'],
        ['App\\Models\\', 'src/models/'],
      ]),
      '/project',
    );
    // App\Models\User should match App\Models\ (longer), not App\
    expect(resolver.resolve('App\\Models\\User')).toBe('src/models/User.php');
    // App\Http\Controller should match App\
    expect(resolver.resolve('App\\Http\\Controller')).toBe('app/Http/Controller.php');
  });

  it('returns undefined for unresolvable FQN', () => {
    const resolver = new Psr4Resolver(new Map([['App\\', 'app/']]), '/project');
    expect(resolver.resolve('Vendor\\Package\\Foo')).toBeUndefined();
  });

  // ---------- reverse resolution ----------

  it('resolves file path to FQN', () => {
    const resolver = new Psr4Resolver(new Map([['App\\', 'app/']]), '/project');
    expect(resolver.resolveToFqn('app/Models/User.php')).toBe('App\\Models\\User');
  });

  it('resolves absolute file path to FQN (strips root)', () => {
    const resolver = new Psr4Resolver(new Map([['App\\', 'app/']]), '/project');
    expect(resolver.resolveToFqn('/project/app/Models/User.php')).toBe('App\\Models\\User');
  });

  it('returns undefined for non-PHP file', () => {
    const resolver = new Psr4Resolver(new Map([['App\\', 'app/']]), '/project');
    expect(resolver.resolveToFqn('app/Models/User.js')).toBeUndefined();
  });

  it('returns undefined for path outside any mapping', () => {
    const resolver = new Psr4Resolver(new Map([['App\\', 'app/']]), '/project');
    expect(resolver.resolveToFqn('vendor/other/Foo.php')).toBeUndefined();
  });

  // ---------- multiple prefixes ----------

  it('handles dev autoload alongside main autoload', () => {
    const resolver = new Psr4Resolver(
      new Map([
        ['App\\', 'app/'],
        ['Tests\\', 'tests/'],
      ]),
      '/project',
    );
    expect(resolver.resolve('Tests\\Feature\\UserTest')).toBe('tests/Feature/UserTest.php');
    expect(resolver.resolveToFqn('tests/Feature/UserTest.php')).toBe('Tests\\Feature\\UserTest');
  });

  // ---------- fromComposerJson ----------

  it('creates resolver from composer.json', () => {
    const dir = join(tmpdir(), 'psr4-test-' + Date.now());
    mkdirSync(dir, { recursive: true });

    const composerJson = {
      autoload: { 'psr-4': { 'App\\': 'app/' } },
      'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } },
    };
    const composerPath = join(dir, 'composer.json');
    writeFileSync(composerPath, JSON.stringify(composerJson));

    const resolver = Psr4Resolver.fromComposerJson(composerPath, dir);
    expect(resolver).toBeDefined();
    expect(resolver!.resolve('App\\Models\\User')).toBe('app/Models/User.php');
    expect(resolver!.resolve('Tests\\Unit\\ExampleTest')).toBe('tests/Unit/ExampleTest.php');

    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined for missing composer.json', () => {
    const resolver = Psr4Resolver.fromComposerJson('/nonexistent/composer.json', '/tmp');
    expect(resolver).toBeUndefined();
  });

  it('returns undefined for composer.json without psr-4', () => {
    const dir = join(tmpdir(), 'psr4-test-nopsr4-' + Date.now());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'composer.json'), JSON.stringify({ require: {} }));

    const resolver = Psr4Resolver.fromComposerJson(join(dir, 'composer.json'), dir);
    expect(resolver).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  // ---------- normalisation ----------

  it('normalises prefix without trailing backslash', () => {
    const resolver = new Psr4Resolver(new Map([['App', 'app']]), '/project');
    expect(resolver.resolve('App\\Models\\User')).toBe('app/Models/User.php');
  });
});
