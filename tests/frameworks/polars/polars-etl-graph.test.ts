import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { IndexingPipeline } from '../../../src/indexer/pipeline.js';
import { PolarsPlugin } from '../../../src/indexer/plugins/integration/framework/polars/index.js';
import { PythonLanguagePlugin } from '../../../src/indexer/plugins/language/python/index.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import { graphQuery } from '../../../src/tools/analysis/graph-query.js';
import { getChangeImpact } from '../../../src/tools/analysis/impact.js';
import { getCallGraph } from '../../../src/tools/framework/call-graph.js';
import { findReferences } from '../../../src/tools/framework/references.js';
import { createTestStore, createTmpDir, removeTmpDir, writeFixtureFile } from '../../test-utils.js';

describe('Polars ETL Pipeline & Graph Tools Integration (GH #1470)', () => {
  let store: Store;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = createTmpDir('trace-mcp-polars-etl-');

    writeFixtureFile(
      tmpDir,
      'pyproject.toml',
      ['[project]', 'name = "analytics-etl"', 'dependencies = [', '    "polars>=1.0.0",', ']'].join(
        '\n',
      ),
    );

    writeFixtureFile(
      tmpDir,
      'utils.py',
      ['def normalize_currency(val: str) -> str:', '    return val.strip().upper()'].join('\n'),
    );

    writeFixtureFile(
      tmpDir,
      'etl_pipeline.py',
      [
        'import polars as pl',
        'from utils import normalize_currency',
        '',
        'def safe_int(val):',
        '    try:',
        '        return int(val)',
        '    except Exception:',
        '        return 0',
        '',
        'def load_raw_activity() -> pl.DataFrame:',
        '    return pl.DataFrame({',
        '        "booking_id": ["1", "2"],',
        '        "amount": ["100", "200"],',
        '        "currency": ["usd", "eur"],',
        '        "old_status": ["confirmed", "pending"],',
        '        "user_id": [10, 20]',
        '    })',
        '',
        'def clean_activity(df: pl.DataFrame) -> pl.DataFrame:',
        '    df = df.with_columns([',
        '        pl.col("booking_id").alias("booking_uuid"),',
        '        pl.col("amount").map_elements(safe_int, return_dtype=pl.Int64),',
        '        pl.col("currency").map_elements(normalize_currency),',
        '    ])',
        '    df = df.rename({"old_status": "status"})',
        '    return df',
        '',
        'def join_metadata(df: pl.DataFrame) -> pl.DataFrame:',
        '    users = pl.DataFrame({"user_id": [10, 20], "username": ["alice", "bob"]})',
        '    return df.join(users, on="user_id", how="left")',
        '',
        'def write_sink(df: pl.DataFrame) -> None:',
        '    df.write_parquet("output.parquet")',
        '',
        'def run_pipeline():',
        '    raw = load_raw_activity()',
        '    cleaned = clean_activity(raw)',
        '    joined = join_metadata(cleaned)',
        '    write_sink(joined)',
      ].join('\n'),
    );

    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());
    registry.registerFrameworkPlugin(new PolarsPlugin());

    const config = {
      root: tmpDir,
      include: ['**/*.py'],
      exclude: [],
      plugins: [],
    } as never;

    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);
  });

  afterAll(() => removeTmpDir(tmpDir));

  it('persists polars edge types in the database', () => {
    const edgeTypes = (
      store.db
        .prepare(
          `SELECT DISTINCT et.name FROM edges e JOIN edge_types et ON e.edge_type_id = et.id`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(edgeTypes).toContain('polars_udf');
    expect(edgeTypes).toContain('polars_dataframe_flow');
    expect(edgeTypes).toContain('polars_column_ref');
    expect(edgeTypes).toContain('polars_column_alias');
    expect(edgeTypes).toContain('polars_join');
  });

  it('resolves map_elements(safe_int) local UDF edge to the function symbol', () => {
    const rows = store.db
      .prepare(`
        SELECT s1.name AS caller, s2.name AS callee, et.name AS edge_type
        FROM edges e
        JOIN nodes n1 ON e.source_node_id = n1.id
        JOIN nodes n2 ON e.target_node_id = n2.id
        JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
        JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
        JOIN edge_types et ON e.edge_type_id = et.id
        WHERE et.name = 'polars_udf'
      `)
      .all() as Array<{ caller: string; callee: string; edge_type: string }>;

    expect(rows).toContainEqual({
      caller: 'clean_activity',
      callee: 'safe_int',
      edge_type: 'polars_udf',
    });
  });

  it('resolves cross-file map_elements(normalize_currency) to utils.py function', () => {
    const rows = store.db
      .prepare(`
        SELECT s1.name AS caller, s2.name AS callee, et.name AS edge_type
        FROM edges e
        JOIN nodes n1 ON e.source_node_id = n1.id
        JOIN nodes n2 ON e.target_node_id = n2.id
        JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
        JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
        JOIN edge_types et ON e.edge_type_id = et.id
        WHERE et.name = 'polars_udf'
      `)
      .all() as Array<{ caller: string; callee: string; edge_type: string }>;

    expect(rows).toContainEqual({
      caller: 'clean_activity',
      callee: 'normalize_currency',
      edge_type: 'polars_udf',
    });
  });

  it('links pipeline stages in order via polars_dataframe_flow', () => {
    const rows = store.db
      .prepare(`
        SELECT s1.name AS consumer, s2.name AS producer
        FROM edges e
        JOIN nodes n1 ON e.source_node_id = n1.id
        JOIN nodes n2 ON e.target_node_id = n2.id
        JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
        JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
        JOIN edge_types et ON e.edge_type_id = et.id
        WHERE et.name = 'polars_dataframe_flow'
      `)
      .all() as Array<{ consumer: string; producer: string }>;

    expect(rows).toContainEqual({
      consumer: 'clean_activity',
      producer: 'load_raw_activity',
    });
    expect(rows).toContainEqual({
      consumer: 'join_metadata',
      producer: 'clean_activity',
    });
    expect(rows).toContainEqual({
      consumer: 'write_sink',
      producer: 'join_metadata',
    });
  });

  it('find_usages finds UDF call from Polars transform', () => {
    const safeIntSym = store.getSymbolBySymbolId('etl_pipeline.py::safe_int#function');
    expect(safeIntSym).toBeDefined();

    const usagesRes = findReferences(store, { symbolId: safeIntSym!.symbol_id });
    expect(usagesRes.isOk()).toBe(true);

    const usages = usagesRes._unsafeUnwrap();
    expect(usages.total).toBeGreaterThanOrEqual(1);
    expect(usages.references.some((r) => r.symbol?.name === 'clean_activity')).toBe(true);
  });

  it('find_usages finds cross-file UDF call from utils.py', () => {
    const normSym = store.getSymbolBySymbolId('utils.py::normalize_currency#function');
    expect(normSym).toBeDefined();

    const usagesRes = findReferences(store, { symbolId: normSym!.symbol_id });
    expect(usagesRes.isOk()).toBe(true);

    const usages = usagesRes._unsafeUnwrap();
    expect(usages.total).toBeGreaterThanOrEqual(1);
    expect(usages.references.some((r) => r.symbol?.name === 'clean_activity')).toBe(true);
  });

  it('get_change_impact surfaces clean_activity when safe_int changes', () => {
    const safeIntSym = store.getSymbolBySymbolId('etl_pipeline.py::safe_int#function');
    const impactRes = getChangeImpact(store, { symbolId: safeIntSym!.symbol_id }, 3);
    expect(impactRes.isOk()).toBe(true);

    const impact = impactRes._unsafeUnwrap();
    const dependentSymbols = impact.dependents.flatMap((d) =>
      (d.symbols ?? []).map((s) => s.symbolName),
    );
    expect(dependentSymbols).toContain('clean_activity');
  });

  it('get_call_graph traverses polars_udf and dataframe flow bidirectionally', () => {
    const cleanSym = store.getSymbolBySymbolId('etl_pipeline.py::clean_activity#function');
    const cgRes = getCallGraph(store, { symbolId: cleanSym!.symbol_id }, 2);
    expect(cgRes.isOk()).toBe(true);

    const cg = cgRes._unsafeUnwrap();
    // clean_activity calls safe_int and normalize_currency via polars_udf
    const calleeNames = (cg.root.calls ?? []).map((c) => c.name);
    expect(calleeNames).toContain('safe_int');
    expect(calleeNames).toContain('normalize_currency');

    // clean_activity is called by join_metadata via dataframe flow
    const callerNames = (cg.root.called_by ?? []).map((c) => c.name);
    expect(callerNames).toContain('join_metadata');
  });

  it('graph_query traverses polars_udf edges', () => {
    const res = graphQuery(store, 'callers of safe_int', { depth: 2 });
    expect(res.isOk()).toBe(true);
    const graph = res._unsafeUnwrap();
    expect(graph.nodes.some((n) => n.name === 'clean_activity')).toBe(true);
  });
});
