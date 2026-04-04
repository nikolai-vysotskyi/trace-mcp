import { describe, it, expect } from 'vitest';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import type { RawSymbol } from '../../src/plugin-api/types.js';

function parse(code: string, filePath = 'app/Models/User.php') {
  const plugin = new PhpLanguagePlugin();
  const result = plugin.extractSymbols(filePath, Buffer.from(code, 'utf-8'));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

function findSymbol(symbols: RawSymbol[], name: string, kind?: string): RawSymbol {
  const found = symbols.find((s) => s.name === name && (!kind || s.kind === kind));
  if (!found) throw new Error(`Symbol "${name}" (kind=${kind}) not found`);
  return found;
}

// ---------- basic class ----------

const basicClassPhp = `<?php
namespace App\\Models;

class User extends Model implements Authenticatable
{
    private string $name;

    public function getEmail(): string
    {
        return $this->email;
    }
}`;

describe('PHP language plugin', () => {
  it('extracts class with namespace and FQN', () => {
    const result = parse(basicClassPhp);
    expect(result.status).toBe('ok');
    expect(result.language).toBe('php');

    const cls = findSymbol(result.symbols, 'User', 'class');
    expect(cls.fqn).toBe('App\\Models\\User');
    expect(cls.symbolId).toBe('app/Models/User.php::User#class');
    expect(cls.signature).toContain('class User extends Model');
  });

  it('extracts method with parent reference', () => {
    const result = parse(basicClassPhp);
    const method = findSymbol(result.symbols, 'getEmail', 'method');
    expect(method.fqn).toBe('App\\Models\\User::getEmail');
    expect(method.parentSymbolId).toBe('app/Models/User.php::User#class');
    expect(method.signature).toContain('public function getEmail(): string');
  });

  it('extracts property', () => {
    const result = parse(basicClassPhp);
    const prop = findSymbol(result.symbols, 'name', 'property');
    expect(prop.fqn).toBe('App\\Models\\User::name');
    expect(prop.parentSymbolId).toBe('app/Models/User.php::User#class');
    expect(prop.metadata?.visibility).toBe('private');
  });

  // ---------- all symbol kinds ----------

  it('extracts interface', () => {
    const code = `<?php
namespace App\\Contracts;

interface Authenticatable
{
    public function getAuthId(): string;
}`;
    const result = parse(code, 'app/Contracts/Authenticatable.php');
    const iface = findSymbol(result.symbols, 'Authenticatable', 'interface');
    expect(iface.fqn).toBe('App\\Contracts\\Authenticatable');

    const method = findSymbol(result.symbols, 'getAuthId', 'method');
    expect(method.parentSymbolId).toBe('app/Contracts/Authenticatable.php::Authenticatable#interface');
  });

  it('extracts trait with methods', () => {
    const code = `<?php
namespace App\\Traits;

trait HasRoles
{
    public function getRoles(): array
    {
        return [];
    }
}`;
    const result = parse(code, 'app/Traits/HasRoles.php');
    const trait = findSymbol(result.symbols, 'HasRoles', 'trait');
    expect(trait.fqn).toBe('App\\Traits\\HasRoles');

    const method = findSymbol(result.symbols, 'getRoles', 'method');
    expect(method.parentSymbolId).toBe('app/Traits/HasRoles.php::HasRoles#trait');
  });

  it('extracts enum with cases', () => {
    const code = `<?php
namespace App\\Enums;

enum Status: string
{
    case Active = 'active';
    case Inactive = 'inactive';
}`;
    const result = parse(code, 'app/Enums/Status.php');
    const enumSym = findSymbol(result.symbols, 'Status', 'enum');
    expect(enumSym.fqn).toBe('App\\Enums\\Status');

    const active = findSymbol(result.symbols, 'Active', 'enum_case');
    expect(active.parentSymbolId).toBe('app/Enums/Status.php::Status#enum');
    expect(active.fqn).toBe('App\\Enums\\Status::Active');
  });

  it('extracts top-level function', () => {
    const code = `<?php
namespace App\\Helpers;

function formatDate(string $date): string
{
    return $date;
}`;
    const result = parse(code, 'app/Helpers/functions.php');
    const fn = findSymbol(result.symbols, 'formatDate', 'function');
    expect(fn.fqn).toBe('App\\Helpers\\formatDate');
    expect(fn.signature).toContain('function formatDate(string $date): string');
  });

  it('extracts class constant', () => {
    const code = `<?php
namespace App\\Models;

class User
{
    const STATUS_ACTIVE = 'active';
}`;
    const result = parse(code, 'app/Models/User.php');
    const constant = findSymbol(result.symbols, 'STATUS_ACTIVE', 'constant');
    expect(constant.fqn).toBe('App\\Models\\User::STATUS_ACTIVE');
    expect(constant.parentSymbolId).toBe('app/Models/User.php::User#class');
  });

  // ---------- PHP 8.x features ----------

  it('extracts attributes in metadata', () => {
    const code = `<?php
namespace App\\Http\\Controllers;

#[Controller]
class UserController
{
    #[Route('/api/users')]
    #[Middleware('auth')]
    public function index(): void {}
}`;
    const result = parse(code, 'app/Http/Controllers/UserController.php');
    const cls = findSymbol(result.symbols, 'UserController', 'class');
    expect(cls.metadata?.attributes).toEqual(['Controller']);

    const method = findSymbol(result.symbols, 'index', 'method');
    expect(method.metadata?.attributes).toContain('Route');
    expect(method.metadata?.attributes).toContain('Middleware');
  });

  it('extracts readonly property', () => {
    const code = `<?php
class Config
{
    public readonly string $name;
}`;
    const result = parse(code, 'src/Config.php');
    const prop = findSymbol(result.symbols, 'name', 'property');
    expect(prop.metadata?.readonly).toBe(true);
    expect(prop.metadata?.visibility).toBe('public');
  });

  it('extracts constructor-promoted properties', () => {
    const code = `<?php
namespace App\\Models;

class User
{
    public function __construct(
        private string $id,
        public readonly string $role = 'user'
    ) {}
}`;
    const result = parse(code, 'app/Models/User.php');

    const idProp = findSymbol(result.symbols, 'id', 'property');
    expect(idProp.metadata?.promoted).toBe(true);
    expect(idProp.metadata?.visibility).toBe('private');
    expect(idProp.parentSymbolId).toBe('app/Models/User.php::User#class');

    const roleProp = findSymbol(result.symbols, 'role', 'property');
    expect(roleProp.metadata?.promoted).toBe(true);
    expect(roleProp.metadata?.readonly).toBe(true);
    expect(roleProp.metadata?.visibility).toBe('public');
  });

  // ---------- partial parse recovery ----------

  it('recovers partial results from broken PHP', () => {
    const code = `<?php
namespace App\\Models;

class User
{
    public function valid(): void {}

    public function broken(
}`;
    const plugin = new PhpLanguagePlugin();
    const result = plugin.extractSymbols('app/Models/User.php', Buffer.from(code, 'utf-8'));
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.status).toBe('partial');
    expect(parsed.warnings).toBeDefined();
    // Should still extract valid symbols
    expect(parsed.symbols.length).toBeGreaterThanOrEqual(1);
    const cls = parsed.symbols.find((s) => s.name === 'User' && s.kind === 'class');
    expect(cls).toBeDefined();
  });

  // ---------- edge cases ----------

  it('handles file without namespace', () => {
    const code = `<?php
function helper(): void {}
class Util {}`;
    const result = parse(code, 'helpers.php');
    const fn = findSymbol(result.symbols, 'helper', 'function');
    expect(fn.fqn).toBe('helper');
    const cls = findSymbol(result.symbols, 'Util', 'class');
    expect(cls.fqn).toBe('Util');
  });

  it('handles empty file', () => {
    const result = parse('<?php', 'empty.php');
    expect(result.status).toBe('ok');
    expect(result.symbols).toHaveLength(0);
  });

  it('line numbers are 1-based', () => {
    const code = `<?php
namespace App;

class Foo
{
    public function bar(): void {}
}`;
    const result = parse(code, 'app/Foo.php');
    const cls = findSymbol(result.symbols, 'Foo', 'class');
    expect(cls.lineStart).toBe(4);
    const method = findSymbol(result.symbols, 'bar', 'method');
    expect(method.lineStart).toBe(6);
  });
});
