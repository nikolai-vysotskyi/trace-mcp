/**
 * Ruby cross-file import resolution E2E.
 *
 * The Ruby plugin has always extracted `require`/`require_relative` into
 * `metadata.from`, but nothing consumed them — the same gap TRA-449 closed
 * for Go, TRA-483 for Java, TRA-565 for Rust and TRA-832 for C/C++.
 *
 * These tests pin the shapes a Ruby require comes in: `require_relative`
 * resolved to the requiring file's own directory (including a `../` that
 * climbs out of it), a load-path style `require` resolved by suffix against
 * the repo's own files, a stdlib/gem require that correctly resolves to
 * nothing, and an ambiguous bare name left unresolved rather than guessed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { RubyLanguagePlugin } from '../../src/indexer/plugins/language/ruby/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const FILES: Record<string, string> = {
  'app/models/user.rb': `require_relative '../services/greeter'
require 'json'

class User
end
`,
  'app/services/greeter.rb': `class Greeter
end
`,
  'app/controllers/users_controller.rb': `require 'services/greeter'

class UsersController
end
`,
  'app/moduleA/common.rb': `A = 1
`,
  'app/moduleB/common.rb': `B = 2
`,
  'app/moduleC/user2.rb': `require 'common'

class User2
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

describe('Ruby import resolution E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-ruby-imports-');
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new RubyLanguagePlugin());

    const config: TraceMcpConfig = {
      root: fixtureDir,
      include: ['**/*.rb'],
      exclude: ['node_modules/**'],
      plugins: [],
    } as TraceMcpConfig;

    await new IndexingPipeline(store, registry, config, fixtureDir).indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('resolves require_relative to a file climbing out of its own directory', () => {
    expect(importTargets(store, 'app/models/user.rb')).toContain('app/services/greeter.rb');
  });

  it('resolves a load-path style require by suffix against the repo’s own files', () => {
    expect(importTargets(store, 'app/controllers/users_controller.rb')).toContain(
      'app/services/greeter.rb',
    );
  });

  it('does not invent a target for a stdlib/gem require', () => {
    const targets = importTargets(store, 'app/models/user.rb');
    expect(targets.size).toBe(1);
    expect(targets).not.toContain('json.rb');
  });

  it('leaves an ambiguous bare name unresolved rather than guessing', () => {
    expect(importTargets(store, 'app/moduleC/user2.rb').size).toBe(0);
  });
});
