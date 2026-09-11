import { describe, expect, it } from 'vitest';
import { LuaLanguagePlugin } from '../../src/indexer/plugins/language/lua/index.js';
import {
  moduleToPathSegments,
  luaCandidatePaths,
} from '../../src/indexer/edge-resolvers/lua-imports.js';

describe('LuaLanguagePlugin', () => {
  const plugin = new LuaLanguagePlugin();

  async function parse(source: string, filename = 'src/sample.lua') {
    const res = await plugin.extractSymbols(filename, Buffer.from(source));
    expect(res.isOk()).toBe(true);
    return res._unsafeUnwrap();
  }

  it('extracts global and local functions', async () => {
    const code = `
function calculate_sum(a, b)
  return a + b
end

local function helper(x)
  return x * 2
end
`;
    const res = await parse(code);
    expect(res.symbols.some((s) => s.name === 'calculate_sum' && s.kind === 'function')).toBe(true);
    expect(res.symbols.some((s) => s.name === 'helper' && s.kind === 'function')).toBe(true);
  });

  it('extracts module methods with dot and colon syntax', async () => {
    const code = `
local M = {}
function M.new()
  return {}
end
function M:process(data)
  return data
end
return M
`;
    const res = await parse(code);
    expect(res.symbols.some((s) => s.name === 'new' && s.kind === 'method')).toBe(true);
    expect(res.symbols.some((s) => s.name === 'process' && s.kind === 'method')).toBe(true);
  });

  it('extracts require edges in various syntax formats', async () => {
    const code = `
-- Standard with parens and double quotes
local a = require("module.a")
-- Standard with single quotes
local b = require('module.b')
-- No parens with double quotes
local c = require "module.c"
-- No parens with single quotes
local d = require 'module.d'
-- Whitespace inside parens
local e = require( "module.e" )
-- String without space after require
local f = require"module.f"
-- Long brackets string
local g = require [[module.g]]
-- Optional dependency wrapped in pcall
local ok, h = pcall(require, "optional_mod")
-- Commented out requires should be ignored!
-- local ignored1 = require("ignored.one")
--[[
local ignored2 = require "ignored.two"
]]
`;
    const res = await parse(code);
    const requiredModules = res.edges
      ?.filter((e) => e.edgeType === 'imports')
      .map((e) => (e.metadata as any)?.module);

    expect(requiredModules).toContain('module.a');
    expect(requiredModules).toContain('module.b');
    expect(requiredModules).toContain('module.c');
    expect(requiredModules).toContain('module.d');
    expect(requiredModules).toContain('module.e');
    expect(requiredModules).toContain('module.f');
    expect(requiredModules).toContain('module.g');
    expect(requiredModules).toContain('optional_mod');

    expect(requiredModules).not.toContain('ignored.one');
    expect(requiredModules).not.toContain('ignored.two');
  });
});

describe('moduleToPathSegments & luaCandidatePaths', () => {
  it('converts module specifiers to path segments', () => {
    expect(moduleToPathSegments('foo')).toBe('foo');
    expect(moduleToPathSegments('foo.bar')).toBe('foo/bar');
    expect(moduleToPathSegments('foo.bar.baz')).toBe('foo/bar/baz');
    expect(moduleToPathSegments('foo/bar')).toBe('foo/bar');
    expect(moduleToPathSegments('foo.bar.lua')).toBe('foo/bar');
    expect(moduleToPathSegments('foo.bar.luau')).toBe('foo/bar');
    expect(moduleToPathSegments('./helper')).toBe('./helper');
    expect(moduleToPathSegments('../parent.helper')).toBe('../parent/helper');
    expect(moduleToPathSegments('.local')).toBe('./local');
    expect(moduleToPathSegments('..sibling')).toBe('../sibling');
  });

  it('generates candidate filenames for Lua modules', () => {
    const candidates = luaCandidatePaths('foo/bar');
    expect(candidates).toEqual([
      'foo/bar.lua',
      'foo/bar/init.lua',
      'foo/bar.luau',
      'foo/bar/init.luau',
    ]);
  });
});
