/**
 * Rust cross-file import resolution E2E (TRA-565).
 *
 * Same gap TRA-449 closed for Go and TRA-483 for Java: the Rust plugin
 * extracted `use` specifiers into `metadata.module`, but no pipeline pass
 * consumed them, so a Rust repo indexed with zero import edges. These tests pin
 * the shapes a Rust module reference comes in — `mod` declaration, `crate::`,
 * `self::`, `super::`, a braced group, a workspace sibling crate — plus the
 * rule that a crates.io or std import resolves to nothing rather than to an
 * invented node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { RustLanguagePlugin } from '../../src/indexer/plugins/language/rust/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const APP = 'app/src';
const LIB = 'util-lib/src';

const FILES: Record<string, string> = {
  [`${APP}/main.rs`]: `mod store;
mod ids;

use std::collections::HashMap;
use serde::Serialize;
use crate::store::{Repo, /* commented out: ids, */ row::Row};
use util_lib::text::trim;

fn main() {
    let _: HashMap<String, Row> = HashMap::new();
    let _ = Repo::new();
    let _ = trim(ids::next());
}
`,
  [`${APP}/store/mod.rs`]: `pub mod row;

use self::row::Row;
use super::ids;

pub struct Repo {
    rows: Vec<Row>,
}

impl Repo {
    pub fn new() -> Self {
        Self { rows: vec![] }
    }
    pub fn id(&self) -> u32 {
        ids::next()
    }
}
`,
  [`${APP}/store/row.rs`]: `pub struct Row {
    pub id: u32,
}
`,
  [`${APP}/ids.rs`]: `pub fn next() -> u32 {
    0
}
`,
  [`${LIB}/lib.rs`]: `pub mod text;
`,
  [`${LIB}/text.rs`]: `pub fn trim(n: u32) -> u32 {
    n
}
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

describe('Rust import resolution E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-rust-imports-');
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new RustLanguagePlugin());

    const config: TraceMcpConfig = {
      root: fixtureDir,
      include: ['**/*.rs'],
      exclude: ['node_modules/**'],
      plugins: [],
    } as TraceMcpConfig;

    await new IndexingPipeline(store, registry, config, fixtureDir).indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('resolves a bodyless `mod` declaration to the module file', () => {
    const targets = importTargets(store, `${APP}/main.rs`);
    expect(targets).toContain(`${APP}/store/mod.rs`);
    expect(targets).toContain(`${APP}/ids.rs`);
  });

  it('resolves a braced `crate::` group to every module it names', () => {
    // `use crate::store::{Repo, row::Row}` — Repo is an item in store/mod.rs,
    // row is a module of its own.
    const targets = importTargets(store, `${APP}/main.rs`);
    expect(targets).toContain(`${APP}/store/mod.rs`);
    expect(targets).toContain(`${APP}/store/row.rs`);
  });

  it('resolves `self::` and `super::` against the file own module', () => {
    expect(importTargets(store, `${APP}/store/mod.rs`)).toEqual(
      new Set([`${APP}/store/row.rs`, `${APP}/ids.rs`]),
    );
  });

  it('resolves a workspace sibling crate through its hyphenated directory', () => {
    // `use util_lib::text::trim` — the crate lives in `util-lib/`.
    expect(importTargets(store, `${APP}/main.rs`)).toContain(`${LIB}/text.rs`);
  });

  it('skips std and crates.io imports rather than inventing targets', () => {
    // main.rs also names std::collections and serde; neither is in the repo, so
    // only the four first-party targets may appear.
    expect(importTargets(store, `${APP}/main.rs`)).toEqual(
      new Set([`${APP}/store/mod.rs`, `${APP}/store/row.rs`, `${APP}/ids.rs`, `${LIB}/text.rs`]),
    );
    // row.rs imports nothing at all.
    expect(importTargets(store, `${APP}/store/row.rs`).size).toBe(0);
  });
});
