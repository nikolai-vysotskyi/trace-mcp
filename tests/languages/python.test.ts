import { beforeAll, describe, expect, it } from 'vitest';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python/index.js';

const plugin = new PythonLanguagePlugin();

async function extract(code: string, filePath = 'mypackage/module.py') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(code));
  if (!result.isOk()) {
    throw new Error(`Python extractSymbols failed: ${JSON.stringify(result._unsafeUnwrapErr())}`);
  }
  return result._unsafeUnwrap();
}

describe('PythonLanguagePlugin', () => {
  beforeAll(async () => {
    const probe = await plugin.extractSymbols('probe.py', Buffer.from('x = 1\n'));
    expect(
      probe.isOk(),
      `Python parser init failed: ${JSON.stringify(probe.isErr() ? probe._unsafeUnwrapErr() : '')}`,
    ).toBe(true);
  });

  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('python-language');
    expect(plugin.supportedExtensions).toContain('.py');
    expect(plugin.supportedExtensions).toContain('.pyi');
  });

  // ─── P0.1: py_inherits edges ────────────────────────────────

  describe('py_inherits edges', () => {
    it('emits inheritance edges from class bases', async () => {
      const result = await extract(`
class Animal:
    pass

class Dog(Animal):
    pass
      `);
      const edges = result.edges?.filter((e) => e.edgeType === 'py_inherits') ?? [];
      expect(edges.length).toBe(1);
      expect(edges[0].metadata?.base).toBe('Animal');
      expect(edges[0].sourceSymbolId).toContain('Dog#class');
    });

    it('emits multiple inheritance edges', async () => {
      const result = await extract(`
class Mixin1:
    pass

class Mixin2:
    pass

class Combined(Mixin1, Mixin2):
    pass
      `);
      const edges = result.edges?.filter((e) => e.edgeType === 'py_inherits') ?? [];
      expect(edges.length).toBe(2);
      const baseNames = edges.map((e) => e.metadata?.base);
      expect(baseNames).toContain('Mixin1');
      expect(baseNames).toContain('Mixin2');
    });

    it('handles dotted base classes', async () => {
      const result = await extract(`
import abc

class MyABC(abc.ABC):
    pass
      `);
      const edges = result.edges?.filter((e) => e.edgeType === 'py_inherits') ?? [];
      expect(edges.length).toBe(1);
      expect(edges[0].metadata?.base).toBe('abc.ABC');
    });
  });

  // ─── P0.2: py_reexports ─────────────────────────────────────

  describe('__init__.py re-exports', () => {
    it('detects re-export edges in __init__.py', async () => {
      const result = await extract(
        `from .models import User, Post\nfrom .utils import helper\n`,
        'mypackage/__init__.py',
      );
      const reexports = result.edges?.filter((e) => e.edgeType === 'py_reexports') ?? [];
      expect(reexports.length).toBe(2);
      const specs0 = reexports[0].metadata?.specifiers as string[];
      expect(specs0).toContain('User');
      expect(specs0).toContain('Post');
    });

    it('does not emit re-exports for non-__init__ files', async () => {
      const result = await extract(`from .models import User\n`, 'mypackage/views.py');
      const reexports = result.edges?.filter((e) => e.edgeType === 'py_reexports') ?? [];
      expect(reexports.length).toBe(0);
    });

    it('detects wildcard re-exports', async () => {
      const result = await extract(`from .models import *\n`, 'mypackage/__init__.py');
      const reexports = result.edges?.filter((e) => e.edgeType === 'py_reexports') ?? [];
      expect(reexports.length).toBe(1);
      expect(reexports[0].metadata?.specifiers as string[]).toContain('*');
    });

    it('sets isPackageInit metadata', async () => {
      const result = await extract(`x = 1\n`, 'mypackage/__init__.py');
      expect(result.metadata?.isPackageInit).toBe(true);
    });
  });

  // ─── P0.3: __all__ extraction ───────────────────────────────

  describe('__all__ extraction', () => {
    it('extracts __all__ list', async () => {
      const result = await extract(`
__all__ = ["Foo", "Bar", "baz"]

class Foo:
    pass
      `);
      expect(result.metadata?.__all__).toEqual(['Foo', 'Bar', 'baz']);
    });

    it('extracts __all__ tuple', async () => {
      const result = await extract(`
__all__ = ('A', 'B')
      `);
      expect(result.metadata?.__all__).toEqual(['A', 'B']);
    });

    it('does not create a variable symbol for __all__', async () => {
      const result = await extract(`
__all__ = ["Foo"]
      `);
      const allSym = result.symbols.find((s) => s.name === '__all__');
      expect(allSym).toBeUndefined();
    });
  });

  // ─── P0.4: Visibility metadata ──────────────────────────────

  describe('visibility metadata', () => {
    it('detects private functions (_prefix)', async () => {
      const result = await extract(`
def _private_helper():
    pass
      `);
      const fn = result.symbols.find((s) => s.name === '_private_helper');
      expect(fn?.metadata?.visibility).toBe('private');
    });

    it('detects mangled names (__prefix)', async () => {
      const result = await extract(`
class Foo:
    def __secret(self):
        pass
      `);
      const method = result.symbols.find((s) => s.name === '__secret');
      expect(method?.metadata?.visibility).toBe('mangled');
    });

    it('detects dunder names (__xxx__)', async () => {
      const result = await extract(`
class Foo:
    def __repr__(self):
        return "Foo"
      `);
      const method = result.symbols.find((s) => s.name === '__repr__');
      expect(method?.metadata?.visibility).toBe('dunder');
    });

    it('public names have no visibility key', async () => {
      const result = await extract(`
def public_func():
    pass
      `);
      const fn = result.symbols.find((s) => s.name === 'public_func');
      expect(fn?.metadata?.visibility).toBeUndefined();
    });

    it('detects visibility on module variables', async () => {
      const result = await extract(`
_internal_cache = {}
PUBLIC_CONST = 42
      `);
      const priv = result.symbols.find((s) => s.name === '_internal_cache');
      expect(priv?.metadata?.visibility).toBe('private');
      const pub = result.symbols.find((s) => s.name === 'PUBLIC_CONST');
      expect(pub?.metadata?.visibility).toBeUndefined();
    });
  });

  // ─── P0.5: Docstrings ──────────────────────────────────────

  describe('docstrings', () => {
    it('extracts function docstring', async () => {
      const result = await extract(`
def greet(name):
    """Greet someone by name."""
    print(f"Hello, {name}")
      `);
      const fn = result.symbols.find((s) => s.name === 'greet');
      expect(fn?.metadata?.docstring).toBe('Greet someone by name.');
    });

    it('extracts class docstring', async () => {
      const result = await extract(`
class MyService:
    """A service that does important things."""

    def run(self):
        pass
      `);
      const cls = result.symbols.find((s) => s.name === 'MyService' && s.kind === 'class');
      expect(cls?.metadata?.docstring).toBe('A service that does important things.');
    });

    it('extracts multi-line docstring (first paragraph)', async () => {
      const result = await extract(`
def process(data):
    """Process the given data.

    This function takes raw data and transforms it
    into the desired format.

    Args:
        data: The raw data to process.
    """
    pass
      `);
      const fn = result.symbols.find((s) => s.name === 'process');
      expect(fn?.metadata?.docstring).toBe('Process the given data.');
    });

    it('extracts module docstring', async () => {
      const result = await extract(`"""Module-level docstring."""

def foo():
    pass
      `);
      expect(result.metadata?.docstring).toBe('Module-level docstring.');
    });

    it('extracts method docstrings', async () => {
      const result = await extract(`
class Foo:
    def bar(self):
        """Do bar stuff."""
        pass
      `);
      const method = result.symbols.find((s) => s.name === 'bar' && s.kind === 'method');
      expect(method?.metadata?.docstring).toBe('Do bar stuff.');
    });
  });

  // ─── P1.1: py_param_type + py_return_type edges ─────────────

  describe('type annotation edges', () => {
    it('extracts parameter type annotations', async () => {
      const result = await extract(`
def greet(name: str, age: int) -> None:
    pass
      `);
      const paramEdges = result.edges?.filter((e) => e.edgeType === 'py_param_type') ?? [];
      expect(paramEdges.length).toBe(2);
      const types = paramEdges.map((e) => ({ param: e.metadata?.param, type: e.metadata?.type }));
      expect(types).toContainEqual({ param: 'name', type: 'str' });
      expect(types).toContainEqual({ param: 'age', type: 'int' });
    });

    it('extracts return type annotation', async () => {
      const result = await extract(`
def greet(name: str) -> str:
    return f"Hello, {name}"
      `);
      const retEdges = result.edges?.filter((e) => e.edgeType === 'py_return_type') ?? [];
      expect(retEdges.length).toBe(1);
      expect(retEdges[0].metadata?.type).toBe('str');
    });

    it('handles complex type annotations', async () => {
      const result = await extract(`
def process(items: list[dict[str, int]]) -> Optional[str]:
    pass
      `);
      const paramEdges = result.edges?.filter((e) => e.edgeType === 'py_param_type') ?? [];
      expect(paramEdges.length).toBe(1);
      expect(paramEdges[0].metadata?.type).toBe('list[dict[str,int]]');
    });

    it('extracts method type annotations', async () => {
      const result = await extract(`
class Foo:
    def get_name(self) -> str:
        return "foo"
      `);
      const retEdges = result.edges?.filter((e) => e.edgeType === 'py_return_type') ?? [];
      expect(retEdges.length).toBe(1);
      expect(retEdges[0].sourceSymbolId).toContain('get_name#method');
    });
  });

  // ─── P1.2: py_uses_decorator edges ─────────────────────────

  describe('decorator edges', () => {
    it('emits decorator edges for functions', async () => {
      const result = await extract(`
import functools

@functools.lru_cache
def expensive():
    pass
      `);
      const decEdges = result.edges?.filter((e) => e.edgeType === 'py_uses_decorator') ?? [];
      expect(decEdges.length).toBe(1);
      expect(decEdges[0].metadata?.decorator).toBe('functools.lru_cache');
    });

    it('emits decorator edges for classes', async () => {
      const result = await extract(`
from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float
      `);
      const decEdges = result.edges?.filter((e) => e.edgeType === 'py_uses_decorator') ?? [];
      expect(decEdges.length).toBeGreaterThanOrEqual(1);
      expect(decEdges.some((e) => e.metadata?.decorator === 'dataclass')).toBe(true);
    });

    it('emits decorator edges for methods', async () => {
      const result = await extract(`
class Foo:
    @staticmethod
    def bar():
        pass
      `);
      const decEdges = result.edges?.filter((e) => e.edgeType === 'py_uses_decorator') ?? [];
      expect(decEdges.some((e) => e.metadata?.decorator === 'staticmethod')).toBe(true);
    });
  });

  // ─── P1.3: TYPE_CHECKING imports ───────────────────────────

  describe('TYPE_CHECKING imports', () => {
    it('detects imports inside TYPE_CHECKING block', async () => {
      const result = await extract(`
from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from myapp.models import User
    from myapp.services import AuthService

def greet(user):
    pass
      `);
      const tcImports =
        result.edges?.filter((e) => e.edgeType === 'py_imports' && e.metadata?.typeOnly === true) ??
        [];
      expect(tcImports.length).toBe(2);
      expect(tcImports[0].metadata?.from).toBe('myapp.models');
      expect(tcImports[1].metadata?.from).toBe('myapp.services');
    });
  });

  // ─── P1.4: Typing patterns ─────────────────────────────────

  describe('typing patterns', () => {
    it('detects NamedTuple', async () => {
      const result = await extract(`
from typing import NamedTuple

class Point(NamedTuple):
    x: float
    y: float
      `);
      const cls = result.symbols.find((s) => s.name === 'Point' && s.kind === 'class');
      expect(cls?.metadata?.namedTuple).toBe(true);
    });

    it('detects TypedDict', async () => {
      const result = await extract(`
from typing import TypedDict

class UserDict(TypedDict):
    name: str
    age: int
      `);
      const cls = result.symbols.find((s) => s.name === 'UserDict' && s.kind === 'class');
      expect(cls?.metadata?.typedDict).toBe(true);
    });

    it('detects Protocol', async () => {
      const result = await extract(`
from typing import Protocol

class Drawable(Protocol):
    def draw(self) -> None: ...
      `);
      const cls = result.symbols.find((s) => s.name === 'Drawable' && s.kind === 'class');
      expect(cls?.metadata?.protocol).toBe(true);
    });
  });

  // ─── P2.1: Nested classes and functions ─────────────────────

  describe('nested definitions', () => {
    it('extracts nested classes (Meta, Config)', async () => {
      const result = await extract(`
class MyModel:
    class Meta:
        db_table = "my_model"

    def save(self):
        pass
      `);
      const nested = result.symbols.find((s) => s.name === 'Meta' && s.kind === 'class');
      expect(nested).toBeDefined();
      expect(nested?.metadata?.nested).toBe(true);
      expect(nested?.parentSymbolId).toContain('MyModel#class');
    });

    it('extracts nested functions (closures)', async () => {
      const result = await extract(`
def outer():
    """Outer function."""
    def inner():
        pass
    return inner
      `);
      const inner = result.symbols.find((s) => s.name === 'inner' && s.kind === 'function');
      expect(inner).toBeDefined();
      expect(inner?.metadata?.nested).toBe(true);
      expect(inner?.parentSymbolId).toContain('outer#function');
    });
  });

  // ─── P2.2: __slots__ and metaclass ─────────────────────────

  describe('__slots__ and metaclass', () => {
    it('extracts __slots__', async () => {
      const result = await extract(`
class Point:
    __slots__ = ('x', 'y', 'z')

    def __init__(self, x, y, z):
        self.x = x
        self.y = y
        self.z = z
      `);
      const cls = result.symbols.find((s) => s.name === 'Point' && s.kind === 'class');
      expect(cls?.metadata?.slots).toEqual(['x', 'y', 'z']);
    });

    it('extracts metaclass', async () => {
      const result = await extract(`
class Singleton(metaclass=SingletonMeta):
    pass
      `);
      const cls = result.symbols.find((s) => s.name === 'Singleton' && s.kind === 'class');
      expect(cls?.metadata?.metaclass).toBe('SingletonMeta');
    });
  });

  // ─── P2.3: Property setter/deleter ─────────────────────────

  describe('property grouping', () => {
    it('detects @property setter and deleter', async () => {
      const result = await extract(`
class Foo:
    @property
    def name(self):
        return self._name

    @name.setter
    def name(self, value):
        self._name = value

    @name.deleter
    def name(self):
        del self._name
      `);
      const methods = result.symbols.filter((s) => s.name === 'name' && s.kind === 'method');
      expect(methods.length).toBe(3);

      const getter = methods.find((m) => m.metadata?.property === true);
      expect(getter).toBeDefined();

      const setter = methods.find((m) => m.metadata?.propertyAccessor === 'setter');
      expect(setter).toBeDefined();
      expect(setter?.metadata?.propertyName).toBe('name');

      const deleter = methods.find((m) => m.metadata?.propertyAccessor === 'deleter');
      expect(deleter).toBeDefined();
    });
  });

  // ─── P2.4: Conditional imports ─────────────────────────────

  describe('conditional imports', () => {
    it('detects try/except ImportError imports', async () => {
      const result = await extract(`
try:
    import ujson as json
except ImportError:
    import json
      `);
      const condImports =
        result.edges?.filter(
          (e) => e.edgeType === 'py_imports' && e.metadata?.conditional === true,
        ) ?? [];
      expect(condImports.length).toBeGreaterThanOrEqual(1);
      expect(condImports[0].metadata?.from).toBe('ujson');
    });

    it('detects ModuleNotFoundError guard', async () => {
      const result = await extract(`
try:
    from orjson import dumps
except ModuleNotFoundError:
    from json import dumps
      `);
      const condImports =
        result.edges?.filter(
          (e) => e.edgeType === 'py_imports' && e.metadata?.conditional === true,
        ) ?? [];
      expect(condImports.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Export semantics (metadata.exported) ───────────────────

  describe('export semantics', () => {
    it('marks all public top-level symbols as exported when __all__ is absent', async () => {
      const result = await extract(`
def greet(name):
    pass

class User:
    def __init__(self):
        pass

MAX_RETRIES = 3
_private_var = 42
      `);
      const greet = result.symbols.find((s) => s.name === 'greet' && s.kind === 'function');
      const user = result.symbols.find((s) => s.name === 'User' && s.kind === 'class');
      const maxRetries = result.symbols.find((s) => s.name === 'MAX_RETRIES');
      const privateVar = result.symbols.find((s) => s.name === '_private_var');
      const init = result.symbols.find((s) => s.name === '__init__' && s.kind === 'method');

      expect(greet?.metadata?.exported).toBe(true);
      expect(user?.metadata?.exported).toBe(true);
      expect(maxRetries?.metadata?.exported).toBe(true);
      expect(privateVar?.metadata?.exported).toBeUndefined();
      // Methods are child symbols — never directly exported
      expect(init?.metadata?.exported).toBeUndefined();
    });

    it('uses __all__ to restrict exports when present', async () => {
      const result = await extract(`
__all__ = ["User", "greet"]

def greet(name):
    pass

def _helper():
    pass

def not_exported():
    pass

class User:
    pass
      `);
      const greet = result.symbols.find((s) => s.name === 'greet' && s.kind === 'function');
      const user = result.symbols.find((s) => s.name === 'User' && s.kind === 'class');
      const helper = result.symbols.find((s) => s.name === '_helper');
      const notExported = result.symbols.find((s) => s.name === 'not_exported');

      expect(greet?.metadata?.exported).toBe(true);
      expect(user?.metadata?.exported).toBe(true);
      expect(helper?.metadata?.exported).toBeUndefined();
      // Public but NOT in __all__ → not exported
      expect(notExported?.metadata?.exported).toBeUndefined();
    });

    it('does not mark dunder names as exported without __all__', async () => {
      const result = await extract(`
__version__ = "1.0.0"

def public_fn():
    pass
      `);
      const version = result.symbols.find((s) => s.name === '__version__');
      const fn = result.symbols.find((s) => s.name === 'public_fn');

      // Dunder names are not "public" visibility
      expect(version?.metadata?.exported).toBeUndefined();
      expect(fn?.metadata?.exported).toBe(true);
    });

    it('marks dunder names as exported when listed in __all__', async () => {
      const result = await extract(`
__all__ = ["__version__"]

__version__ = "1.0.0"
      `);
      const version = result.symbols.find((s) => s.name === '__version__');
      expect(version?.metadata?.exported).toBe(true);
    });

    it('records __all__ in file metadata', async () => {
      const result = await extract(`
__all__ = ["Foo", "bar"]

class Foo:
    pass

def bar():
    pass
      `);
      expect(result.metadata?.__all__).toEqual(['Foo', 'bar']);
    });
  });

  // ─── Existing functionality still works ─────────────────────

  describe('existing extraction (regression)', () => {
    it('extracts basic function and class', async () => {
      const result = await extract(`
def greet(name):
    print(f"Hello, {name}")

class User:
    def __init__(self, name):
        self.name = name
      `);
      expect(result.symbols.find((s) => s.name === 'greet' && s.kind === 'function')).toBeDefined();
      expect(result.symbols.find((s) => s.name === 'User' && s.kind === 'class')).toBeDefined();
      expect(
        result.symbols.find((s) => s.name === '__init__' && s.kind === 'method'),
      ).toBeDefined();
      expect(result.symbols.find((s) => s.name === 'name' && s.kind === 'property')).toBeDefined();
    });

    it('extracts import edges', async () => {
      const result = await extract(`
import os
from pathlib import Path
from . import utils
      `);
      const imports = result.edges?.filter((e) => e.edgeType === 'py_imports') ?? [];
      expect(imports.length).toBe(3);
    });

    it('extracts dataclass detection', async () => {
      const result = await extract(`
from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float
      `);
      const cls = result.symbols.find((s) => s.name === 'Point' && s.kind === 'class');
      expect(cls?.metadata?.dataclass).toBe(true);
    });

    it('extracts constants and variables', async () => {
      const result = await extract(`
MAX_RETRIES = 3
default_timeout = 30
      `);
      expect(
        result.symbols.find((s) => s.name === 'MAX_RETRIES' && s.kind === 'constant'),
      ).toBeDefined();
      expect(
        result.symbols.find((s) => s.name === 'default_timeout' && s.kind === 'variable'),
      ).toBeDefined();
    });

    it('extracts async functions', async () => {
      const result = await extract(`
async def fetch_data(url: str) -> dict:
    pass
      `);
      const fn = result.symbols.find((s) => s.name === 'fetch_data');
      expect(fn?.metadata?.async).toBe(true);
    });

    it('extracts enum classes', async () => {
      const result = await extract(`
from enum import Enum

class Color(Enum):
    RED = 1
    GREEN = 2
    BLUE = 3
      `);
      const cls = result.symbols.find((s) => s.name === 'Color' && s.kind === 'class');
      expect(cls?.metadata?.enum).toBe(true);
    });

    it('extracts pydantic models', async () => {
      const result = await extract(`
from pydantic import BaseModel

class UserSchema(BaseModel):
    name: str
    email: str
      `);
      const cls = result.symbols.find((s) => s.name === 'UserSchema' && s.kind === 'class');
      expect(cls?.metadata?.pydantic).toBe(true);
    });

    it('handles .pyi stub files', async () => {
      const result = await extract(`def foo(x: int) -> str: ...\n`, 'mypackage/module.pyi');
      expect(result.language).toBe('python');
      expect(result.symbols.find((s) => s.name === 'foo')).toBeDefined();
    });
  });

  // ─── Call site extraction ─────────────────────────────────────

  describe('call site extraction', () => {
    it('extracts getattr with string literal', async () => {
      const result = await extract(`
def process(self):
    getattr(self, "handle_click")(event)
      `);
      const fn = result.symbols.find((s) => s.name === 'process');
      const sites = fn?.metadata?.callSites as { calleeName: string }[];
      expect(sites).toBeDefined();
      expect(sites.some((s) => s.calleeName === 'handle_click')).toBe(true);
    });

    it('extracts dict dispatch call sites', async () => {
      const result = await extract(`
def dispatch_action(action, data):
    handlers = {"create": handle_create, "delete": handle_delete}
    handlers[action](data)
      `);
      const fn = result.symbols.find((s) => s.name === 'dispatch_action');
      const sites = fn?.metadata?.callSites as { calleeName: string }[];
      expect(sites).toBeDefined();
      expect(sites.some((s) => s.calleeName === 'handle_create')).toBe(true);
      expect(sites.some((s) => s.calleeName === 'handle_delete')).toBe(true);
    });
  });
});
