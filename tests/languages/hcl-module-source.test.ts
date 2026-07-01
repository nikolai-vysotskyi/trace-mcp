/**
 * HCL/Terraform `module "x" { source = "..." }` → imports edge.
 *
 * The plugin extracts resource/module blocks as symbols and a module's
 * `source` as an `imports` edge. Regression guard: that edge must carry a
 * source symbol so it survives storeRawEdges (which skips any edge whose source
 * cannot be resolved to a node), and — for a local `./module` source — resolve
 * to the referenced module directory once indexed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { HclLanguagePlugin } from '../../src/indexer/plugins/language/hcl/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

describe('HCL module source edge (unit)', () => {
  it('attaches a source symbol to the module imports edge so it is persistable', () => {
    const plugin = new HclLanguagePlugin();
    const r = (
      plugin.extractSymbols(
        'main.tf',
        Buffer.from(`module "vpc" {\n  source = "./modules/vpc"\n}\n`),
      ) as any
    )._unsafeUnwrap();

    const edge = (r.edges ?? []).find(
      (e: any) => e.edgeType === 'imports' && e.metadata?.module === './modules/vpc',
    );
    expect(edge).toBeDefined();
    // Must have a source symbol id pointing at the module symbol, else
    // storeRawEdges drops it (src == null).
    expect(edge.sourceSymbolId).toBe('main.tf::vpc#namespace');
  });
});

describe('HCL module source edge (pipeline)', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(
      {
        'main.tf': `module "vpc" {\n  source = "./modules/vpc"\n}\n`,
        'modules/vpc/main.tf': `resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}\n`,
      },
      'trace-mcp-hcl-',
    );
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new HclLanguagePlugin());
    const config: TraceMcpConfig = {
      root: fixtureDir,
      include: ['**/*.tf'],
      exclude: ['node_modules/**'],
      db: { path: ':memory:' },
      plugins: [],
    } as TraceMcpConfig;
    await new IndexingPipeline(store, registry, config, fixtureDir).indexAll();
  });

  afterAll(() => removeTmpDir(fixtureDir));

  it('persists the module imports edge (no longer silently dropped)', () => {
    const imports = store.getEdgesByType('imports');
    expect(imports.length).toBeGreaterThan(0);
    // No self-loops.
    for (const e of imports) {
      expect(e.source_node_id).not.toBe(e.target_node_id);
    }
  });

  it('resolves the local module source to the referenced module directory', () => {
    const moduleSym = store.getSymbolBySymbolId('main.tf::vpc#namespace');
    expect(moduleSym).toBeDefined();
    const moduleNode = store.getNodeId('symbol', moduleSym!.id)!;
    const importsOut = store
      .getOutgoingEdges(moduleNode)
      .filter((e) => e.edge_type_name === 'imports');
    expect(importsOut.length).toBeGreaterThan(0);

    // Target must land inside modules/vpc.
    const reaches = importsOut.some((e) => {
      const ref = store.getNodeRef(e.target_node_id);
      if (!ref) return false;
      if (ref.nodeType === 'file') {
        return (store.getFileById(ref.refId)?.path ?? '').startsWith('modules/vpc/');
      }
      const sym = store.getSymbolById(ref.refId);
      return (
        sym?.file_id != null &&
        (store.getFileById(sym.file_id)?.path ?? '').startsWith('modules/vpc/')
      );
    });
    expect(reaches).toBe(true);
  });
});
