import { describe, it, expect } from 'vitest';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python.js';
import type { RawSymbol } from '../../src/plugin-api/types.js';

function parse(code: string, filePath = 'src/myapp/utils.py') {
  const plugin = new PythonLanguagePlugin();
  const result = plugin.extractSymbols(filePath, Buffer.from(code, 'utf-8'));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

function findSymbol(symbols: RawSymbol[], name: string, kind?: string): RawSymbol {
  const found = symbols.find((s) => s.name === name && (!kind || s.kind === kind));
  if (!found) throw new Error(`Symbol "${name}" (kind=${kind}) not found in: ${symbols.map(s => `${s.name}#${s.kind}`).join(', ')}`);
  return found;
}

// ---------- module-level function ----------

describe('Python plugin — function', () => {
  const code = `def parse_date(value: str) -> datetime:\n    return datetime.strptime(value, '%Y-%m-%d')`;

  it('extracts function symbol', () => {
    const result = parse(code);
    const fn = findSymbol(result.symbols, 'parse_date', 'function');
    expect(fn.kind).toBe('function');
    expect(fn.lineStart).toBe(1);
  });
});

// ---------- async function ----------

describe('Python plugin — async function', () => {
  const code = `async def fetch_data(url: str) -> dict:\n    pass`;

  it('extracts async function with metadata', () => {
    const result = parse(code);
    const fn = findSymbol(result.symbols, 'fetch_data', 'function');
    expect(fn.kind).toBe('function');
    expect(fn.metadata?.async).toBe(true);
  });
});

// ---------- class ----------

describe('Python plugin — class', () => {
  const code = `class User:\n    name: str\n    def save(self):\n        pass`;

  it('extracts class and method', () => {
    const result = parse(code);
    const cls = findSymbol(result.symbols, 'User', 'class');
    expect(cls.kind).toBe('class');
    const method = findSymbol(result.symbols, 'save', 'method');
    expect(method.kind).toBe('method');
    expect(method.parentSymbolId).toBe(cls.symbolId);
  });
});

// ---------- class with inheritance ----------

describe('Python plugin — class inheritance', () => {
  const code = `class UserView(ListView):\n    model = User\n    template_name = 'users/list.html'`;

  it('extracts class with base classes in metadata', () => {
    const result = parse(code);
    const cls = findSymbol(result.symbols, 'UserView', 'class');
    expect(cls.metadata?.bases).toContain('ListView');
  });
});

// ---------- dataclass ----------

describe('Python plugin — dataclass', () => {
  const code = `from dataclasses import dataclass\n\n@dataclass\nclass Point:\n    x: float\n    y: float`;

  it('detects dataclass decorator in metadata', () => {
    const result = parse(code);
    const cls = findSymbol(result.symbols, 'Point', 'class');
    expect(cls.metadata?.dataclass).toBe(true);
  });
});

// ---------- constant (ALL_CAPS) ----------

describe('Python plugin — constant', () => {
  const code = `MAX_RETRIES = 3\nDEFAULT_TIMEOUT = 30`;

  it('extracts ALL_CAPS assignments as constants', () => {
    const result = parse(code);
    const c = findSymbol(result.symbols, 'MAX_RETRIES', 'constant');
    expect(c.kind).toBe('constant');
  });
});

// ---------- typed variable ----------

describe('Python plugin — typed variable', () => {
  const code = `app_name: str = 'myapp'`;

  it('extracts typed assignment as variable', () => {
    const result = parse(code);
    const v = findSymbol(result.symbols, 'app_name', 'variable');
    expect(v.kind).toBe('variable');
  });
});

// ---------- imports ----------

describe('Python plugin — import edges', () => {
  const code = `import os\nfrom myapp.models import User, Order\nfrom . import utils`;

  it('extracts import edges', () => {
    const result = parse(code);
    expect(result.edges).toBeDefined();
    expect(result.edges!.length).toBeGreaterThanOrEqual(3);

    const osImport = result.edges!.find((e) => (e.metadata as any)?.from === 'os');
    expect(osImport).toBeDefined();
    expect(osImport!.edgeType).toBe('py_imports');

    const modelImport = result.edges!.find((e) => (e.metadata as any)?.from === 'myapp.models');
    expect(modelImport).toBeDefined();
    expect((modelImport!.metadata as any)?.specifiers).toContain('User');
    expect((modelImport!.metadata as any)?.specifiers).toContain('Order');
  });
});

// ---------- decorated function ----------

describe('Python plugin — decorated function', () => {
  const code = `@app.route('/users')\ndef list_users():\n    pass`;

  it('extracts function with decorator metadata', () => {
    const result = parse(code);
    const fn = findSymbol(result.symbols, 'list_users', 'function');
    expect(fn.metadata?.decorators).toBeDefined();
    expect(fn.metadata?.decorators).toContainEqual(expect.stringContaining('app.route'));
  });
});

// ---------- class with multiple methods ----------

describe('Python plugin — class methods', () => {
  const code = `class OrderService:\n    def create(self, data: dict) -> Order:\n        pass\n\n    async def process(self, order_id: int) -> None:\n        pass\n\n    @staticmethod\n    def validate(data: dict) -> bool:\n        pass`;

  it('extracts all methods', () => {
    const result = parse(code);
    const names = result.symbols.filter((s) => s.kind === 'method').map((s) => s.name);
    expect(names).toContain('create');
    expect(names).toContain('process');
    expect(names).toContain('validate');
  });
});

// ---------- partial parse recovery ----------

describe('Python plugin — error recovery', () => {
  const code = `def valid_func():\n    pass\n\ndef broken_func(\n    # missing closing paren`;

  it('extracts what it can, returns partial status', () => {
    const result = parse(code);
    expect(result.status).toBe('partial');
    const fn = result.symbols.find((s) => s.name === 'valid_func');
    expect(fn).toBeDefined();
  });
});
