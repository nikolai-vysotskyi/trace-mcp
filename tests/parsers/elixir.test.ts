import { describe, expect, it } from 'vitest';
import { ElixirLanguagePlugin } from '../../src/indexer/plugins/language/elixir/index.js';

describe('ElixirLanguagePlugin', () => {
  const plugin = new ElixirLanguagePlugin();

  async function parse(source: string, filename = 'lib/sample.ex') {
    const res = await plugin.extractSymbols(filename, Buffer.from(source));
    expect(res.isOk()).toBe(true);
    return res._unsafeUnwrap();
  }

  it('extracts defmodule and functions', async () => {
    const code = `
defmodule MyApp.Accounts do
  def list_users do
    []
  end

  defp validate_user(user) do
    user
  end
end
`;
    const res = await parse(code);
    expect(res.symbols.some((s) => s.name === 'MyApp.Accounts' && s.kind === 'class')).toBe(true);
    expect(res.symbols.some((s) => s.name === 'list_users' && s.kind === 'function')).toBe(true);
    expect(
      res.symbols.some(
        (s) => s.name === 'validate_user' && s.kind === 'function' && s.metadata?.private === true,
      ),
    ).toBe(true);
  });

  it('extracts defprotocol and defimpl', async () => {
    const code = `
defprotocol MyApp.Describable do
  def describe(data)
end

defimpl MyApp.Describable, for: Integer do
  def describe(int), do: "Integer: #{int}"
end
`;
    const res = await parse(code);
    expect(res.symbols.some((s) => s.name === 'MyApp.Describable' && s.kind === 'interface')).toBe(
      true,
    );
    expect(res.symbols.some((s) => s.name === 'MyApp.Describable' && s.kind === 'class')).toBe(
      true,
    );
  });

  it('extracts single alias, use, import, require import edges', async () => {
    const code = `
defmodule MyApp.Web do
  alias MyApp.Accounts
  import MyApp.Helpers, only: [format_date: 1]
  use GenServer
  require Logger
end
`;
    const res = await parse(code);
    const edges = res.edges ?? [];
    const importEdges = edges.filter((e) => e.edgeType === 'imports');

    expect(importEdges).toContainEqual({
      edgeType: 'imports',
      metadata: { module: 'MyApp.Accounts', kind: 'alias' },
    });
    expect(importEdges).toContainEqual({
      edgeType: 'imports',
      metadata: { module: 'MyApp.Helpers', kind: 'import' },
    });
    expect(importEdges).toContainEqual({
      edgeType: 'imports',
      metadata: { module: 'GenServer', kind: 'use' },
    });
    expect(importEdges).toContainEqual({
      edgeType: 'imports',
      metadata: { module: 'Logger', kind: 'require' },
    });
  });

  it('expands multi-alias syntax into individual import edges', async () => {
    const code = `
defmodule MyApp.Router do
  alias MyApp.Controllers.{UserController, PostController, CommentController}
  alias MyApp.Repo.{User, Post}
end
`;
    const res = await parse(code);
    const edges = res.edges ?? [];
    const importModules = edges
      .filter((e) => e.edgeType === 'imports')
      .map((e) => (e.metadata as Record<string, unknown>)?.module);

    expect(importModules).toContain('MyApp.Controllers.UserController');
    expect(importModules).toContain('MyApp.Controllers.PostController');
    expect(importModules).toContain('MyApp.Controllers.CommentController');
    expect(importModules).toContain('MyApp.Repo.User');
    expect(importModules).toContain('MyApp.Repo.Post');
    expect(importModules.length).toBe(5);
  });

  it('ignores comments inside multi-alias tuple syntax', async () => {
    const code = `
defmodule MyApp.Router do
  alias MyApp.Controllers.{
    # Primary controllers
    UserController,
    # Secondary
    PostController
  }
end
`;
    const res = await parse(code);
    const edges = res.edges ?? [];
    const importModules = edges
      .filter((e) => e.edgeType === 'imports')
      .map((e) => (e.metadata as Record<string, unknown>)?.module);

    expect(importModules).toEqual([
      'MyApp.Controllers.UserController',
      'MyApp.Controllers.PostController',
    ]);
  });

  it('extracts nested modules and updates moduleCtx for symbol FQNs', async () => {
    const code = `
defmodule Outer do
  defmodule Inner do
    def inner_fn do
      :ok
    end
  end
end
`;
    const res = await parse(code);
    expect(res.symbols.some((s) => s.fqn === 'Outer' && s.kind === 'class')).toBe(true);
    expect(res.symbols.some((s) => s.fqn === 'Outer.Inner' && s.kind === 'class')).toBe(true);
    expect(res.symbols.some((s) => s.name === 'inner_fn' && s.kind === 'function')).toBe(true);
  });
});
