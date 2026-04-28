import { describe, expect, it } from 'vitest';
import {
  extractCallSites,
  extractClassHeritage,
  extractInterfaceExtends,
  extractUseStatements,
} from '../../src/indexer/plugins/language/php/helpers.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { getParser } from '../../src/parser/tree-sitter.js';
import type { RawSymbol } from '../../src/plugin-api/types.js';

async function parse(code: string, filePath = 'app/Models/User.php') {
  const plugin = new PhpLanguagePlugin();
  const result = await plugin.extractSymbols(filePath, Buffer.from(code, 'utf-8'));
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
  it('extracts class with namespace and FQN', async () => {
    const result = await parse(basicClassPhp);
    expect(result.status).toBe('ok');
    expect(result.language).toBe('php');

    const cls = findSymbol(result.symbols, 'User', 'class');
    expect(cls.fqn).toBe('App\\Models\\User');
    expect(cls.symbolId).toBe('app/Models/User.php::User#class');
    expect(cls.signature).toContain('class User extends Model');
  });

  it('extracts method with parent reference', async () => {
    const result = await parse(basicClassPhp);
    const method = findSymbol(result.symbols, 'getEmail', 'method');
    expect(method.fqn).toBe('App\\Models\\User::getEmail');
    expect(method.parentSymbolId).toBe('app/Models/User.php::User#class');
    expect(method.signature).toContain('public function getEmail(): string');
  });

  it('extracts property', async () => {
    const result = await parse(basicClassPhp);
    const prop = findSymbol(result.symbols, 'name', 'property');
    expect(prop.fqn).toBe('App\\Models\\User::name');
    expect(prop.parentSymbolId).toBe('app/Models/User.php::User#class');
    expect(prop.metadata?.visibility).toBe('private');
  });

  // ---------- all symbol kinds ----------

  it('extracts interface', async () => {
    const code = `<?php
namespace App\\Contracts;

interface Authenticatable
{
    public function getAuthId(): string;
}`;
    const result = await parse(code, 'app/Contracts/Authenticatable.php');
    const iface = findSymbol(result.symbols, 'Authenticatable', 'interface');
    expect(iface.fqn).toBe('App\\Contracts\\Authenticatable');

    const method = findSymbol(result.symbols, 'getAuthId', 'method');
    expect(method.parentSymbolId).toBe(
      'app/Contracts/Authenticatable.php::Authenticatable#interface',
    );
  });

  it('extracts trait with methods', async () => {
    const code = `<?php
namespace App\\Traits;

trait HasRoles
{
    public function getRoles(): array
    {
        return [];
    }
}`;
    const result = await parse(code, 'app/Traits/HasRoles.php');
    const trait = findSymbol(result.symbols, 'HasRoles', 'trait');
    expect(trait.fqn).toBe('App\\Traits\\HasRoles');

    const method = findSymbol(result.symbols, 'getRoles', 'method');
    expect(method.parentSymbolId).toBe('app/Traits/HasRoles.php::HasRoles#trait');
  });

  it('extracts enum with cases', async () => {
    const code = `<?php
namespace App\\Enums;

enum Status: string
{
    case Active = 'active';
    case Inactive = 'inactive';
}`;
    const result = await parse(code, 'app/Enums/Status.php');
    const enumSym = findSymbol(result.symbols, 'Status', 'enum');
    expect(enumSym.fqn).toBe('App\\Enums\\Status');

    const active = findSymbol(result.symbols, 'Active', 'enum_case');
    expect(active.parentSymbolId).toBe('app/Enums/Status.php::Status#enum');
    expect(active.fqn).toBe('App\\Enums\\Status::Active');
  });

  it('extracts top-level function', async () => {
    const code = `<?php
namespace App\\Helpers;

function formatDate(string $date): string
{
    return $date;
}`;
    const result = await parse(code, 'app/Helpers/functions.php');
    const fn = findSymbol(result.symbols, 'formatDate', 'function');
    expect(fn.fqn).toBe('App\\Helpers\\formatDate');
    expect(fn.signature).toContain('function formatDate(string $date): string');
  });

  it('extracts class constant', async () => {
    const code = `<?php
namespace App\\Models;

class User
{
    const STATUS_ACTIVE = 'active';
}`;
    const result = await parse(code, 'app/Models/User.php');
    const constant = findSymbol(result.symbols, 'STATUS_ACTIVE', 'constant');
    expect(constant.fqn).toBe('App\\Models\\User::STATUS_ACTIVE');
    expect(constant.parentSymbolId).toBe('app/Models/User.php::User#class');
  });

  // ---------- PHP 8.x features ----------

  it('extracts attributes in metadata', async () => {
    const code = `<?php
namespace App\\Http\\Controllers;

#[Controller]
class UserController
{
    #[Route('/api/users')]
    #[Middleware('auth')]
    public function index(): void {}
}`;
    const result = await parse(code, 'app/Http/Controllers/UserController.php');
    const cls = findSymbol(result.symbols, 'UserController', 'class');
    expect(cls.metadata?.attributes).toEqual(['Controller']);

    const method = findSymbol(result.symbols, 'index', 'method');
    expect(method.metadata?.attributes).toContain('Route');
    expect(method.metadata?.attributes).toContain('Middleware');
  });

  it('extracts readonly property', async () => {
    const code = `<?php
class Config
{
    public readonly string $name;
}`;
    const result = await parse(code, 'src/Config.php');
    const prop = findSymbol(result.symbols, 'name', 'property');
    expect(prop.metadata?.readonly).toBe(true);
    expect(prop.metadata?.visibility).toBe('public');
  });

  it('extracts constructor-promoted properties', async () => {
    const code = `<?php
namespace App\\Models;

class User
{
    public function __construct(
        private string $id,
        public readonly string $role = 'user'
    ) {}
}`;
    const result = await parse(code, 'app/Models/User.php');

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

  it('recovers partial results from broken PHP', async () => {
    const code = `<?php
namespace App\\Models;

class User
{
    public function valid(): void {}

    public function broken(
}`;
    const plugin = new PhpLanguagePlugin();
    const result = await plugin.extractSymbols('app/Models/User.php', Buffer.from(code, 'utf-8'));
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

  it('handles file without namespace', async () => {
    const code = `<?php
function helper(): void {}
class Util {}`;
    const result = await parse(code, 'helpers.php');
    const fn = findSymbol(result.symbols, 'helper', 'function');
    expect(fn.fqn).toBe('helper');
    const cls = findSymbol(result.symbols, 'Util', 'class');
    expect(cls.fqn).toBe('Util');
  });

  it('handles empty file', async () => {
    const result = await parse('<?php', 'empty.php');
    expect(result.status).toBe('ok');
    expect(result.symbols).toHaveLength(0);
  });

  it('line numbers are 1-based', async () => {
    const code = `<?php
namespace App;

class Foo
{
    public function bar(): void {}
}`;
    const result = await parse(code, 'app/Foo.php');
    const cls = findSymbol(result.symbols, 'Foo', 'class');
    expect(cls.lineStart).toBe(4);
    const method = findSymbol(result.symbols, 'bar', 'method');
    expect(method.lineStart).toBe(6);
  });

  // ---------- use statement extraction ----------

  it('extracts simple use statements as import edges', async () => {
    const code = `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use App\\Contracts\\Searchable;

class User extends Model {}`;
    const result = await parse(code);
    expect(result.edges).toBeDefined();
    expect(result.edges!.length).toBe(2);

    const modelEdge = result.edges!.find(
      (e) => (e.metadata as any).from === 'Illuminate\\Database\\Eloquent\\Model',
    );
    expect(modelEdge).toBeDefined();
    expect(modelEdge!.edgeType).toBe('php_imports');
    expect((modelEdge!.metadata as any).specifiers).toEqual(['Model']);

    const searchableEdge = result.edges!.find(
      (e) => (e.metadata as any).from === 'App\\Contracts\\Searchable',
    );
    expect(searchableEdge).toBeDefined();
    expect((searchableEdge!.metadata as any).specifiers).toEqual(['Searchable']);
  });

  it('extracts aliased use statements', async () => {
    const code = `<?php
namespace App;

use App\\Traits\\HasUuid as UuidTrait;

class User {}`;
    const result = await parse(code);
    expect(result.edges).toBeDefined();
    expect(result.edges!.length).toBe(1);
    expect((result.edges![0].metadata as any).from).toBe('App\\Traits\\HasUuid');
    expect((result.edges![0].metadata as any).specifiers).toEqual(['UuidTrait']);
  });

  it('extracts grouped use statements', async () => {
    const code = `<?php
namespace App;

use App\\Contracts\\{Searchable, Filterable};

class User {}`;
    const result = await parse(code);
    expect(result.edges).toBeDefined();
    expect(result.edges!.length).toBe(2);

    const fqns = result.edges!.map((e) => (e.metadata as any).from).sort();
    expect(fqns).toEqual(['App\\Contracts\\Filterable', 'App\\Contracts\\Searchable']);
  });

  it('returns no edges for file without use statements', async () => {
    const code = `<?php
function helper(): void {}`;
    const result = await parse(code, 'helpers.php');
    expect(result.edges).toBeUndefined();
  });
});

// ---------- extractUseStatements unit tests ----------

describe('extractUseStatements', () => {
  async function parseAst(code: string) {
    const parser = await getParser('php');
    return parser.parse(code).rootNode;
  }

  it('extracts simple use', async () => {
    const root = await parseAst(`<?php
use App\\Models\\User;
`);
    const uses = extractUseStatements(root);
    expect(uses).toEqual([{ fqn: 'App\\Models\\User' }]);
  });

  it('extracts use with alias', async () => {
    const root = await parseAst(`<?php
use App\\Traits\\HasUuid as UuidTrait;
`);
    const uses = extractUseStatements(root);
    expect(uses).toEqual([{ fqn: 'App\\Traits\\HasUuid', alias: 'UuidTrait' }]);
  });

  it('extracts grouped use', async () => {
    const root = await parseAst(`<?php
use App\\Contracts\\{Searchable, Filterable};
`);
    const uses = extractUseStatements(root);
    expect(uses).toHaveLength(2);
    expect(uses.map((u) => u.fqn).sort()).toEqual([
      'App\\Contracts\\Filterable',
      'App\\Contracts\\Searchable',
    ]);
  });

  it('extracts use inside namespace block', async () => {
    const root = await parseAst(`<?php
namespace App\\Models {
    use Illuminate\\Database\\Eloquent\\Model;
    class User extends Model {}
}
`);
    const uses = extractUseStatements(root);
    expect(uses).toEqual([{ fqn: 'Illuminate\\Database\\Eloquent\\Model' }]);
  });

  it('returns empty for file without use', async () => {
    const root = await parseAst(`<?php
class Foo {}
`);
    const uses = extractUseStatements(root);
    expect(uses).toEqual([]);
  });

  it('handles multiple use statements', async () => {
    const root = await parseAst(`<?php
namespace App;
use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Http\\Request;
use App\\Traits\\{HasUuid, SoftDeletes};
`);
    const uses = extractUseStatements(root);
    expect(uses).toHaveLength(4);
    expect(uses.map((u) => u.fqn).sort()).toEqual([
      'App\\Traits\\HasUuid',
      'App\\Traits\\SoftDeletes',
      'Illuminate\\Database\\Eloquent\\Model',
      'Illuminate\\Http\\Request',
    ]);
  });
});

// ---------- class heritage extraction ----------

describe('extractClassHeritage', () => {
  async function parseClass(code: string) {
    const parser = await getParser('php');
    const root = parser.parse(code).rootNode;
    function find(n: any): any {
      if (n.type === 'class_declaration') return n;
      for (const c of n.namedChildren) {
        const r = find(c);
        if (r) return r;
      }
      return null;
    }
    return find(root);
  }

  it('extracts extends', async () => {
    const node = await parseClass('<?php class User extends Model {}');
    expect(extractClassHeritage(node)).toEqual({
      extends: ['Model'],
      implements: [],
      usesTraits: [],
    });
  });

  it('extracts implements (multiple)', async () => {
    const node = await parseClass('<?php class User implements Auth, Serializable {}');
    expect(extractClassHeritage(node)).toEqual({
      extends: [],
      implements: ['Auth', 'Serializable'],
      usesTraits: [],
    });
  });

  it('extracts trait usage', async () => {
    const node = await parseClass('<?php class User { use HasRoles, CanLogin; }');
    expect(extractClassHeritage(node)).toEqual({
      extends: [],
      implements: [],
      usesTraits: ['HasRoles', 'CanLogin'],
    });
  });

  it('extracts all heritage combined', async () => {
    const node = await parseClass(`<?php
class User extends Model implements Authenticatable, Serializable {
  use HasRoles, Notifiable;
}
`);
    const h = extractClassHeritage(node);
    expect(h.extends).toEqual(['Model']);
    expect(h.implements).toEqual(['Authenticatable', 'Serializable']);
    expect(h.usesTraits).toEqual(['HasRoles', 'Notifiable']);
  });

  it('extracts interface extends (multi-inheritance)', async () => {
    const parser = await getParser('php');
    const root = parser.parse('<?php interface Foo extends Bar, Baz {}').rootNode;
    const iface = root.namedChildren.find((c: any) => c.type === 'interface_declaration');
    expect(extractInterfaceExtends(iface!)).toEqual(['Bar', 'Baz']);
  });
});

// ---------- call site extraction ----------

describe('extractCallSites', () => {
  async function parseBody(code: string) {
    const parser = await getParser('php');
    const root = parser.parse(code).rootNode;
    function find(n: any): any {
      if (n.type === 'compound_statement') return n;
      for (const c of n.namedChildren) {
        const r = find(c);
        if (r) return r;
      }
      return null;
    }
    return find(root);
  }

  it('extracts $this->method() calls', async () => {
    const body = await parseBody(`<?php function f() { $this->validate($x); $this->save(); }`);
    const calls = extractCallSites(body);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ type: 'this', callee: 'validate' });
    expect(calls[1]).toMatchObject({ type: 'this', callee: 'save' });
  });

  it('extracts $obj->method() calls as member', async () => {
    const body = await parseBody(`<?php function f() { $user->save(); }`);
    const calls = extractCallSites(body);
    expect(calls[0]).toMatchObject({ type: 'member', callee: 'save', receiver: 'user' });
  });

  it('extracts Class::method() static calls', async () => {
    const body = await parseBody(
      `<?php function f() { User::query()->get(); App\\Util::helper(); }`,
    );
    const calls = extractCallSites(body);
    const statics = calls.filter((c) => c.type === 'static');
    expect(statics).toHaveLength(2);
    expect(statics[0]).toMatchObject({ callee: 'query', classRef: 'User' });
    expect(statics[1]).toMatchObject({ callee: 'helper', classRef: 'App\\Util' });
  });

  it('extracts self::/parent:: calls', async () => {
    const body = await parseBody(`<?php function f() { self::sm(); parent::pm(); }`);
    const calls = extractCallSites(body);
    expect(calls[0]).toMatchObject({ type: 'self', callee: 'sm' });
    expect(calls[1]).toMatchObject({ type: 'parent', callee: 'pm' });
  });

  it('extracts new Class() as instantiation', async () => {
    const body = await parseBody(`<?php function f() { $u = new User(['n']); new App\\Model(); }`);
    const calls = extractCallSites(body);
    const news = calls.filter((c) => c.type === 'new');
    expect(news).toHaveLength(2);
    expect(news[0]).toMatchObject({ callee: '__construct', classRef: 'User' });
    expect(news[1]).toMatchObject({ callee: '__construct', classRef: 'App\\Model' });
  });

  it('extracts bare function calls', async () => {
    const body = await parseBody(`<?php function f() { helperFn($x); array_map('cb', $xs); }`);
    const calls = extractCallSites(body);
    const fns = calls.filter((c) => c.type === 'function');
    expect(fns).toHaveLength(2);
    expect(fns[0]).toMatchObject({ callee: 'helperFn' });
    expect(fns[1]).toMatchObject({ callee: 'array_map' });
  });

  it('captures line numbers', async () => {
    const body = await parseBody(`<?php
function f() {
  $this->a();

  $this->b();
}
`);
    const calls = extractCallSites(body);
    expect(calls[0].line).toBe(3);
    expect(calls[1].line).toBe(5);
  });

  it('extracts $this->prop property access', async () => {
    const body = await parseBody(`<?php function f() { echo $this->name; $this->email = 'x'; }`);
    const refs = extractCallSites(body);
    const props = refs.filter((r) => r.type === 'this_prop');
    expect(props).toHaveLength(2);
    expect(props.map((p) => p.callee).sort()).toEqual(['email', 'name']);
  });

  it('extracts $obj->prop as member_prop', async () => {
    const body = await parseBody(`<?php function f() { echo $user->name; }`);
    const refs = extractCallSites(body);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'member_prop', callee: 'name', receiver: 'user' });
  });

  it('extracts Class::CONST class constant access', async () => {
    const body = await parseBody(
      `<?php function f() { echo User::STATUS_ACTIVE; echo App\\Config::DEFAULT; }`,
    );
    const refs = extractCallSites(body);
    const consts = refs.filter((r) => r.type === 'class_const');
    expect(consts).toHaveLength(2);
    expect(consts[0]).toMatchObject({ callee: 'STATUS_ACTIVE', classRef: 'User' });
    expect(consts[1]).toMatchObject({ callee: 'DEFAULT', classRef: 'App\\Config' });
  });

  it('extracts self::CONST as relative_const', async () => {
    const body = await parseBody(`<?php function f() { echo self::FOO; }`);
    const refs = extractCallSites(body);
    expect(refs[0]).toMatchObject({ type: 'relative_const', callee: 'FOO' });
  });

  it('extracts enum case access as class_const', async () => {
    // PHP treats enum cases as class constants in the AST.
    // Resolver decides whether the target class is an enum and picks enum_case.
    const body = await parseBody(`<?php function f() { return Status::Active; }`);
    const refs = extractCallSites(body);
    expect(refs[0]).toMatchObject({ type: 'class_const', callee: 'Active', classRef: 'Status' });
  });

  it('extracts Class::class magic constant as class_ref (not constant)', async () => {
    const body = await parseBody(`<?php function f() { return User::class; }`);
    const refs = extractCallSites(body);
    expect(refs[0]).toMatchObject({ type: 'class_ref', callee: 'class', classRef: 'User' });
  });

  it('extracts Class::$static static property access', async () => {
    const body = await parseBody(
      `<?php function f() { echo self::$static_prop; echo User::$tableName; }`,
    );
    const refs = extractCallSites(body);
    const rel = refs.filter((r) => r.type === 'relative_static_prop');
    const st = refs.filter((r) => r.type === 'static_prop');
    expect(rel).toHaveLength(1);
    expect(rel[0].callee).toBe('static_prop');
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ callee: 'tableName', classRef: 'User' });
  });

  it('does not duplicate prop access for $this->method() call', async () => {
    // $this->save() is a call — should NOT also produce a this_prop for "save".
    const body = await parseBody(`<?php function f() { $this->save(); }`);
    const refs = extractCallSites(body);
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('this');
    expect(refs[0].callee).toBe('save');
  });

  it('captures inner prop access for chained $this->foo->bar()', async () => {
    // $this->foo->bar() — we can't statically type $this->foo, so the ->bar()
    // call is a dynamic dispatch we skip. But the inner ->foo access is captured.
    const body = await parseBody(`<?php function f() { $this->service->save(); }`);
    const refs = extractCallSites(body);
    const prop = refs.find((r) => r.type === 'this_prop' && r.callee === 'service');
    expect(prop).toBeDefined();
  });
});

// ---------- method symbol emits callSites metadata ----------

describe('PHP plugin emits callSites and heritage', () => {
  it('methods have callSites in metadata', async () => {
    const code = `<?php
namespace App;
class Service extends Base {
  public function process() {
    $this->validate();
    User::query();
    new Request();
  }
}`;
    const plugin = new PhpLanguagePlugin();
    const result = await plugin.extractSymbols('app/Service.php', Buffer.from(code));
    const parsed = result._unsafeUnwrap();
    const method = parsed.symbols.find((s) => s.name === 'process' && s.kind === 'method');
    expect(method).toBeDefined();
    const sites = (method!.metadata as any)?.callSites;
    expect(sites).toBeDefined();
    expect(sites).toHaveLength(3);
    expect(sites.map((s: any) => s.type).sort()).toEqual(['new', 'static', 'this']);
  });

  it('class has extends/implements/traits in metadata', async () => {
    const code = `<?php
class User extends Model implements Authenticatable {
  use HasRoles;
}`;
    const plugin = new PhpLanguagePlugin();
    const result = await plugin.extractSymbols('app/User.php', Buffer.from(code));
    const parsed = result._unsafeUnwrap();
    const cls = parsed.symbols.find((s) => s.name === 'User' && s.kind === 'class');
    expect(cls).toBeDefined();
    expect((cls!.metadata as any).extends).toEqual(['Model']);
    expect((cls!.metadata as any).implements).toEqual(['Authenticatable']);
    expect((cls!.metadata as any).usesTraits).toEqual(['HasRoles']);
  });
});
