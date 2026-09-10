/**
 * Lua cross-file import resolution E2E (TRA-1332).
 *
 * Verifies the full indexing pipeline chain for Lua:
 * - LuaLanguagePlugin extracts symbols and require import edges
 * - resolveLuaImportEdges maps require specifiers to target file nodes in the SQLite graph
 * - Module paths with dots resolve to both foo/bar.lua and foo/bar/init.lua
 * - Relative requires (./helper) resolve relative to the importing file's directory
 * - .luau files are supported alongside .lua
 * - Production files never resolve to test files in spec/ or test/
 * - External standard library (math, table) and third-party rocks (lanes, busted) are filtered
 * - Self-requires do not create self-loop edges
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { LuaLanguagePlugin } from '../../src/indexer/plugins/language/lua/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const FILES: Record<string, string> = {
  'src/app.lua': `
local config = require("config")
local router = require("routes.router")
local utils = require("utils")
local parser = require("parser")
local lanes_ok, lanes = pcall(require, "lanes")
local math = require("math")
local self = require("app")

function run()
  config.load()
end
`,
  'src/config.lua': `
local M = {}
function M.load() return true end
return M
`,
  'src/routes/router/init.lua': `
local handler = require("routes.handler")
local helper = require("./helper")
local M = {}
function M.route() return true end
return M
`,
  'src/routes/router/helper.lua': `
local M = {}
return M
`,
  'src/routes/handler.lua': `
local M = {}
return M
`,
  'src/utils.lua': `
local M = {}
return M
`,
  'src/parser.luau': `
local M = {}
return M
`,
  'spec/app_spec.lua': `
local app = require("app")
local config = require("config")
local busted = require("busted")
`,
  'spec/config.lua': `
-- duplicate config.lua in spec
local M = {}
return M
`,
};

function importTargets(store: Store, sourcePath: string): Set<string> {
  const file = store.getFile(sourcePath);
  if (!file) return new Set();
  const nodeId = store.getNodeId('file', file.id);
  if (nodeId == null) return new Set();
  const targets = new Set<string>();
  for (const edge of store.getOutgoingEdges(nodeId)) {
    if (edge.edge_type_name !== 'imports') continue;
    const ref = store.getNodeRef(edge.target_node_id);
    if (ref?.nodeType === 'file') targets.add(store.getFileById(ref.refId)?.path ?? '');
  }
  return targets;
}

describe('Lua import resolution E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-lua-imports-');
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new LuaLanguagePlugin());

    const config: TraceMcpConfig = {
      root: fixtureDir,
      include: ['**/*.lua', '**/*.luau'],
      exclude: ['.git/**'],
      plugins: [],
    } as TraceMcpConfig;

    await new IndexingPipeline(store, registry, config, fixtureDir).indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('resolves exact module name to source file', () => {
    const targets = importTargets(store, 'src/app.lua');
    expect(targets).toContain('src/config.lua');
    expect(targets).toContain('src/utils.lua');
  });

  it('resolves module name to directory init.lua', () => {
    const targets = importTargets(store, 'src/app.lua');
    expect(targets).toContain('src/routes/router/init.lua');
  });

  it('resolves .luau dialect files', () => {
    const targets = importTargets(store, 'src/app.lua');
    expect(targets).toContain('src/parser.luau');
  });

  it('resolves sub-module require in subdirectories', () => {
    const targets = importTargets(store, 'src/routes/router/init.lua');
    expect(targets).toContain('src/routes/handler.lua');
  });

  it('resolves relative ./ import to file in same directory', () => {
    const targets = importTargets(store, 'src/routes/router/init.lua');
    expect(targets).toContain('src/routes/router/helper.lua');
  });

  it('does not create self-loop edges', () => {
    const targets = importTargets(store, 'src/app.lua');
    expect(targets).not.toContain('src/app.lua');
  });

  it('never points production code imports at test files in spec/', () => {
    const targets = importTargets(store, 'src/app.lua');
    expect(targets).toContain('src/config.lua');
    expect(targets).not.toContain('spec/config.lua');
  });

  it('resolves imports in spec files to production code', () => {
    const targets = importTargets(store, 'spec/app_spec.lua');
    expect(targets).toContain('src/app.lua');
    expect(targets).toContain('src/config.lua');
  });

  it('skips external stdlib and third-party rocks without inventing targets', () => {
    const targets = importTargets(store, 'src/app.lua');
    for (const t of targets) {
      expect(FILES[t]).toBeDefined();
    }
  });
});
