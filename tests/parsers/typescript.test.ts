import { describe, expect, it } from 'vitest';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import type { RawSymbol } from '../../src/plugin-api/types.js';

async function parse(code: string, filePath = 'src/utils.ts') {
  const plugin = new TypeScriptLanguagePlugin();
  const result = await plugin.extractSymbols(filePath, Buffer.from(code, 'utf-8'));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

function findSymbol(symbols: RawSymbol[], name: string, kind?: string): RawSymbol {
  const found = symbols.find((s) => s.name === name && (!kind || s.kind === kind));
  if (!found) throw new Error(`Symbol "${name}" (kind=${kind}) not found`);
  return found;
}

// ---------- exported function ----------

describe('TypeScript plugin — exported function', () => {
  const code = `export function foo(x: number): string { return String(x); }`;

  it('extracts function symbol with exported=true', async () => {
    const result = await parse(code);
    const fn = findSymbol(result.symbols, 'foo', 'function');
    expect(fn.kind).toBe('function');
    expect(fn.metadata?.exported).toBe(true);
    expect(fn.signature).toContain('export');
    expect(fn.signature).toContain('foo');
  });
});

// ---------- exported class ----------

describe('TypeScript plugin — exported class', () => {
  const code = `export class MyClass extends Base {
  doStuff(): void {}
}`;

  it('extracts class symbol with signature', async () => {
    const result = await parse(code);
    const cls = findSymbol(result.symbols, 'MyClass', 'class');
    expect(cls.kind).toBe('class');
    expect(cls.metadata?.exported).toBe(true);
    expect(cls.signature).toContain('MyClass');
    expect(cls.signature).toContain('extends Base');
  });
});

// ---------- exported const ----------

describe('TypeScript plugin — exported const', () => {
  const code = `export const value = 42;`;

  it('extracts variable symbol', async () => {
    const result = await parse(code);
    const v = findSymbol(result.symbols, 'value', 'variable');
    expect(v.kind).toBe('variable');
    expect(v.metadata?.exported).toBe(true);
  });
});

// ---------- exported type ----------

describe('TypeScript plugin — exported type', () => {
  const code = `export type MyType = { name: string; age: number };`;

  it('extracts type symbol', async () => {
    const result = await parse(code);
    const t = findSymbol(result.symbols, 'MyType', 'type');
    expect(t.kind).toBe('type');
    expect(t.metadata?.exported).toBe(true);
    expect(t.signature).toContain('MyType');
  });
});

// ---------- exported interface ----------

describe('TypeScript plugin — exported interface', () => {
  const code = `export interface MyInterface {
  name: string;
  greet(): void;
}`;

  it('extracts interface symbol', async () => {
    const result = await parse(code);
    const iface = findSymbol(result.symbols, 'MyInterface', 'interface');
    expect(iface.kind).toBe('interface');
    expect(iface.metadata?.exported).toBe(true);
    expect(iface.signature).toContain('MyInterface');
  });
});

// ---------- exported enum ----------

describe('TypeScript plugin — exported enum', () => {
  const code = `export enum Status { Active, Inactive }`;

  it('extracts enum symbol', async () => {
    const result = await parse(code);
    const e = findSymbol(result.symbols, 'Status', 'enum');
    expect(e.kind).toBe('enum');
    expect(e.metadata?.exported).toBe(true);
  });
});

// ---------- class methods ----------

describe('TypeScript plugin — class methods', () => {
  const code = `export class Service {
  async fetchData(url: string): Promise<string> { return ''; }
  process(): void {}
}`;

  it('extracts methods from class', async () => {
    const result = await parse(code);
    const fetch = findSymbol(result.symbols, 'fetchData', 'method');
    expect(fetch.kind).toBe('method');
    expect(fetch.parentSymbolId).toContain('Service');
    expect(fetch.metadata?.async).toBe(true);

    const proc = findSymbol(result.symbols, 'process', 'method');
    expect(proc.kind).toBe('method');
    expect(proc.metadata?.async).toBe(false);
  });
});

// ---------- TSX parsing ----------

describe('TypeScript plugin — TSX file', () => {
  const code = `import React from 'react';
export function App() {
  return <div>Hello</div>;
}`;

  it('parses TSX without error', async () => {
    const result = await parse(code, 'src/App.tsx');
    expect(result.status).toBe('ok');
    const fn = findSymbol(result.symbols, 'App', 'function');
    expect(fn.kind).toBe('function');
  });
});

// ---------- import edges ----------

describe('TypeScript plugin — import extraction', () => {
  const code = `import { foo, bar } from './utils';
import * as path from 'path';
import DefaultExport from './default';

export const x = 1;`;

  it('extracts import edges with specifiers', async () => {
    const result = await parse(code);
    expect(result.edges).toBeDefined();
    expect(result.edges!.length).toBe(3);

    const utilsEdge = result.edges!.find((e) => (e.metadata as any).from === './utils');
    expect(utilsEdge).toBeDefined();
    expect(utilsEdge!.edgeType).toBe('imports');
    expect((utilsEdge!.metadata as any).specifiers).toContain('foo');
    expect((utilsEdge!.metadata as any).specifiers).toContain('bar');

    const pathEdge = result.edges!.find((e) => (e.metadata as any).from === 'path');
    expect(pathEdge).toBeDefined();
    expect((pathEdge!.metadata as any).specifiers).toContain('* as path');
  });
});

// ---------- default exports ----------

describe('TypeScript plugin — default export', () => {
  const code = `export default function main() { return 42; }`;

  it('marks function as default', async () => {
    const result = await parse(code);
    const fn = findSymbol(result.symbols, 'main', 'function');
    expect(fn.metadata?.default).toBe(true);
    expect(fn.metadata?.exported).toBe(true);
  });
});

// ---------- broken syntax ----------

describe('TypeScript plugin — broken syntax', () => {
  const code = `export function valid(): void {}

export function broken(
`;

  it('returns status=partial and extracts valid symbols', async () => {
    const result = await parse(code);
    expect(result.status).toBe('partial');
    expect(result.warnings).toBeDefined();

    const valid = result.symbols.find((s) => s.name === 'valid');
    expect(valid).toBeDefined();
  });
});

// ---------- non-exported symbols ----------

describe('TypeScript plugin — non-exported declarations', () => {
  const code = `function helper() {}
export function exported() {}`;

  it('extracts non-exported functions with exported=false', async () => {
    const result = await parse(code);
    const helper = findSymbol(result.symbols, 'helper', 'function');
    expect(helper.metadata?.exported).toBe(false);

    const exp = findSymbol(result.symbols, 'exported', 'function');
    expect(exp.metadata?.exported).toBe(true);
  });
});

// ---------- async function ----------

describe('TypeScript plugin — async function', () => {
  const code = `export async function fetchAll(): Promise<void> {}`;

  it('extracts async metadata', async () => {
    const result = await parse(code);
    const fn = findSymbol(result.symbols, 'fetchAll', 'function');
    expect(fn.metadata?.async).toBe(true);
  });
});

// ---------- symbol IDs ----------

describe('TypeScript plugin — symbol ID format', () => {
  const code = `export class Foo { bar(): void {} }`;

  it('uses path::name#kind format', async () => {
    const result = await parse(code, 'src/foo.ts');
    const cls = findSymbol(result.symbols, 'Foo', 'class');
    expect(cls.symbolId).toBe('src/foo.ts::Foo#class');

    const method = findSymbol(result.symbols, 'bar', 'method');
    expect(method.symbolId).toBe('src/foo.ts::Foo::bar#method');
  });
});

// ---------- decorators ----------

describe('TypeScript plugin — decorator extraction', () => {
  it('extracts class decorators', async () => {
    const code = `@Injectable()
export class MyService {
  handle(): void {}
}`;
    const result = await parse(code);
    const cls = findSymbol(result.symbols, 'MyService', 'class');
    expect(cls.metadata?.decorators).toContain('Injectable');
  });

  it('extracts method decorators', async () => {
    const code = `export class Controller {
  @Get('/users')
  getUsers(): void {}

  @Post('/users')
  createUser(): void {}
}`;
    const result = await parse(code);
    const getMethod = findSymbol(result.symbols, 'getUsers', 'method');
    expect(getMethod.metadata?.decorators).toContain('Get');

    const postMethod = findSymbol(result.symbols, 'createUser', 'method');
    expect(postMethod.metadata?.decorators).toContain('Post');
  });

  it('extracts multiple decorators on a class', async () => {
    const code = `@Controller('/api')
@UseGuards(AuthGuard)
export class ApiController {
  handle(): void {}
}`;
    const result = await parse(code);
    const cls = findSymbol(result.symbols, 'ApiController', 'class');
    expect(cls.metadata?.decorators).toBeDefined();
    expect(cls.metadata?.decorators).toContain('Controller');
    expect(cls.metadata?.decorators).toContain('UseGuards');
  });

  it('omits decorators field when no decorators present', async () => {
    const code = `export class PlainClass { run(): void {} }`;
    const result = await parse(code);
    const cls = findSymbol(result.symbols, 'PlainClass', 'class');
    expect(cls.metadata?.decorators).toBeUndefined();
  });
});
