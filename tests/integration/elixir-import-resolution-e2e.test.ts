/**
 * Elixir cross-file import resolution E2E (TRA-1227).
 *
 * Verifies the full indexing pipeline chain for Elixir:
 * - ElixirLanguagePlugin extracts symbols and imports edges (alias, use, import, require)
 * - Multi-alias `alias Prefix.{A, B}` expands to separate target modules
 * - resolveElixirImportEdges maps module specifiers to target file nodes in the SQLite graph
 * - Production files never resolve to test files
 * - External standard library / third-party modules are filtered without creating bogus edges
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { ElixirLanguagePlugin } from '../../src/indexer/plugins/language/elixir/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const FILES: Record<string, string> = {
  'mix.exs': `defmodule MyApp.MixProject do
  use Mix.Project

  def project do
    [app: :my_app, version: "0.1.0"]
  end
end
`,
  'lib/my_app/accounts.ex': `defmodule MyApp.Accounts do
  alias MyApp.Repo.User

  def get_user(id) do
    User.find(id)
  end
end
`,
  'lib/my_app/repo/user.ex': `defmodule MyApp.Repo.User do
  def find(id), do: id
end
`,
  'lib/my_app/repo/post.ex': `defmodule MyApp.Repo.Post do
  def list, do: []
end
`,
  'lib/my_app/helpers.ex': `defmodule MyApp.Helpers do
  def format_name(n), do: String.trim(n)
end
`,
  'lib/my_app/describable.ex': `defprotocol MyApp.Describable do
  def describe(data)
end
`,
  'lib/my_app/formatters.ex': `defmodule MyApp.Formatters do
  alias MyApp.Describable

  def format(item) do
    Describable.describe(item)
  end
end
`,
  'lib/my_app/web.ex': `defmodule MyApp.Web do
  # Multi-alias expansion with comments inside tuple
  alias MyApp.Repo.{
    # Primary model
    User,
    # Secondary model
    Post
  }
  # Single alias
  alias MyApp.Accounts
  # Import
  import MyApp.Helpers
  # Self alias (should be ignored, no self-loop)
  alias MyApp.Web
  # External dependencies / stdlib
  use GenServer
  require Logger

  def start_link do
    Logger.info("Starting")
  end
end
`,
  'test/my_app/accounts_test.exs': `defmodule MyApp.AccountsTest do
  use ExUnit.Case
  alias MyApp.Accounts
  alias MyApp.Repo.User

  test "get_user" do
    assert Accounts.get_user(1) == 1
  end
end
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

describe('Elixir import resolution E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-elixir-imports-');
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new ElixirLanguagePlugin());

    const config: TraceMcpConfig = {
      root: fixtureDir,
      include: ['**/*.ex', '**/*.exs'],
      exclude: ['_build/**', 'deps/**'],
      plugins: [],
    } as TraceMcpConfig;

    await new IndexingPipeline(store, registry, config, fixtureDir).indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('resolves single alias to target module file', () => {
    const targets = importTargets(store, 'lib/my_app/accounts.ex');
    expect(targets).toContain('lib/my_app/repo/user.ex');
  });

  it('resolves multi-alias to all targeted module files', () => {
    const targets = importTargets(store, 'lib/my_app/web.ex');
    expect(targets).toContain('lib/my_app/repo/user.ex');
    expect(targets).toContain('lib/my_app/repo/post.ex');
    expect(targets).toContain('lib/my_app/accounts.ex');
  });

  it('resolves import directives to the module file', () => {
    const targets = importTargets(store, 'lib/my_app/web.ex');
    expect(targets).toContain('lib/my_app/helpers.ex');
  });

  it('resolves protocol references to the protocol declaration file', () => {
    const targets = importTargets(store, 'lib/my_app/formatters.ex');
    expect(targets).toContain('lib/my_app/describable.ex');
  });

  it('does not create self-loop edges', () => {
    const targets = importTargets(store, 'lib/my_app/web.ex');
    expect(targets).not.toContain('lib/my_app/web.ex');
  });

  it('never points production code imports at test files', () => {
    for (const file of [
      'lib/my_app/accounts.ex',
      'lib/my_app/web.ex',
      'lib/my_app/formatters.ex',
    ]) {
      const targets = importTargets(store, file);
      for (const t of targets) {
        expect(t.endsWith('_test.exs')).toBe(false);
      }
    }
  });

  it('resolves imports in test files to production code', () => {
    const targets = importTargets(store, 'test/my_app/accounts_test.exs');
    expect(targets).toContain('lib/my_app/accounts.ex');
    expect(targets).toContain('lib/my_app/repo/user.ex');
  });

  it('skips external stdlib and third-party modules without inventing targets', () => {
    const targets = importTargets(store, 'lib/my_app/web.ex');
    // Targets should only include files in the fixture (user, post, accounts, helpers)
    for (const t of targets) {
      expect(FILES[t]).toBeDefined();
    }
  });
});
