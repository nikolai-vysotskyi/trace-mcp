import { describe, expect, it } from 'vitest';
import { PolarsPlugin } from '../../../src/indexer/plugins/integration/framework/polars/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function makeContext(requirementsTxt: string): ProjectContext {
  return {
    rootPath: '/dummy',
    requirementsTxt,
    detectedVersions: [],
    allDependencies: [],
    configFiles: [],
  } as unknown as ProjectContext;
}

async function extract(code: string, filePath = 'etl.py', language = 'python') {
  const plugin = new PolarsPlugin();
  const res = await plugin.extractNodes(filePath, Buffer.from(code), language);
  if (!res.isOk()) throw new Error('extractNodes failed');
  return res.value;
}

describe('PolarsPlugin — Unit & Precision Tests', () => {
  const plugin = new PolarsPlugin();

  it('manifest metadata matches contract', () => {
    expect(plugin.manifest.name).toBe('polars');
    expect(plugin.manifest.category).toBe('framework');
    expect(plugin.manifest.version).toBe('1.0.0');
    expect(plugin.manifest.priority).toBe(35);
  });

  it('detects polars in project dependencies and ignores others', () => {
    expect(plugin.detect(makeContext('polars==1.29.0\npandas==2.2.0'))).toBe(true);
    expect(plugin.detect(makeContext('numpy>=1.24.0\nrequests>=2.28.0'))).toBe(false);
  });

  it('skips non-Python files', async () => {
    const res = await extract('import polars as pl\npl.DataFrame()', 'script.ts', 'typescript');
    expect(res.edges ?? []).toHaveLength(0);
    expect(res.symbols).toHaveLength(0);
  });

  it('skips Python files with no polars references (false positive guard)', async () => {
    const code = [
      'import math',
      '',
      'def compute(x: int) -> int:',
      '    return int(math.sqrt(x))',
    ].join('\n');
    const res = await extract(code);
    expect(res.edges ?? []).toHaveLength(0);
    expect(res.frameworkRole).toBeUndefined();
  });

  it('recognizes DataFrame-typed functions and constructors as pipeline stages', async () => {
    const code = [
      'import polars as pl',
      '',
      'def load_raw() -> pl.DataFrame:',
      '    return pl.DataFrame({"id": [1, 2, 3]})',
      '',
      'def clean_data(df: pl.DataFrame) -> pl.DataFrame:',
      '    return df',
      '',
      'def write_data(df: pl.DataFrame) -> None:',
      '    pass',
    ].join('\n');

    const res = await extract(code);
    expect(res.frameworkRole).toBe('polars_pipeline');
  });

  it('extracts literal column references and ignores dynamic expressions', async () => {
    const code = [
      'import polars as pl',
      '',
      'DYNAMIC_COLS = ["a", "b"]',
      '',
      'def transform(df: pl.DataFrame) -> pl.DataFrame:',
      '    # Literal columns',
      '    res = df.select([pl.col("bookingId"), pl.col("amount", "currency")])',
      '    # Dynamic column comprehension — must NOT guess or hallucinate',
      '    res = res.select([pl.col(c) for c in DYNAMIC_COLS])',
      '    return res',
    ].join('\n');

    const res = await extract(code);
    const colEdges = (res.edges ?? []).filter((e) => e.edgeType === 'polars_column_ref');
    const cols = colEdges.map((e) => e.metadata?.column);

    expect(cols).toContain('bookingId');
    expect(cols).toContain('amount');
    expect(cols).toContain('currency');
    // Ensure dynamic 'c' was NOT treated as literal column name
    expect(cols).not.toContain('c');
  });

  it('extracts .alias("literal") with origin column tracking', async () => {
    const code = [
      'import polars as pl',
      '',
      'def clean_columns(df: pl.DataFrame) -> pl.DataFrame:',
      '    return df.with_columns([',
      '        pl.col("bookingId").alias("booking_id"),',
      '        pl.col("totalAmount").alias("total_amount"),',
      '    ])',
    ].join('\n');

    const res = await extract(code);
    const aliasEdges = (res.edges ?? []).filter((e) => e.edgeType === 'polars_column_alias');
    expect(aliasEdges).toHaveLength(2);

    expect(aliasEdges[0].metadata).toEqual({
      from: 'bookingId',
      to: 'booking_id',
      operation: 'alias',
      line: 5,
    });
    expect(aliasEdges[1].metadata).toEqual({
      from: 'totalAmount',
      to: 'total_amount',
      operation: 'alias',
      line: 6,
    });
  });

  it('extracts dictionary .rename({...}) mappings and ignores dynamic mappings', async () => {
    const code = [
      'import polars as pl',
      '',
      'def rename_cols(df: pl.DataFrame) -> pl.DataFrame:',
      '    df = df.rename({"old_status": "status", "num_orders": "order_count"})',
      '    dynamic_map = {"a": "b"}',
      '    df = df.rename(dynamic_map)',
      '    return df',
    ].join('\n');

    const res = await extract(code);
    const renameEdges = (res.edges ?? []).filter(
      (e) => e.edgeType === 'polars_column_alias' && e.metadata?.operation === 'rename',
    );
    expect(renameEdges).toHaveLength(2);

    expect(renameEdges.map((e) => `${e.metadata?.from} -> ${e.metadata?.to}`)).toEqual([
      'old_status -> status',
      'num_orders -> order_count',
    ]);
  });

  it('extracts .join(..., on="literal") keys and how parameter', async () => {
    const code = [
      'import polars as pl',
      '',
      'def join_frames(df1: pl.DataFrame, df2: pl.DataFrame) -> pl.DataFrame:',
      '    joined = df1.join(df2, on="booking_uuid", how="left")',
      '    multi = df1.join(df2, left_on=["user_id", "dept_id"], right_on=["id", "department_id"], how="inner")',
      '    return joined',
    ].join('\n');

    const res = await extract(code);
    const joinEdges = (res.edges ?? []).filter((e) => e.edgeType === 'polars_join');
    expect(joinEdges).toHaveLength(2);

    expect(joinEdges[0].metadata).toMatchObject({
      other: 'df2',
      on: ['booking_uuid'],
      how: 'left',
      line: 4,
    });

    expect(joinEdges[1].metadata).toMatchObject({
      other: 'df2',
      left_on: ['user_id', 'dept_id'],
      right_on: ['id', 'department_id'],
      how: 'inner',
      line: 5,
    });
  });

  it('links map_elements(fn) and apply(fn) to local Python callables', async () => {
    const code = [
      'import polars as pl',
      '',
      'def safe_int(v):',
      '    try:',
      '        return int(v)',
      '    except Exception:',
      '        return 0',
      '',
      'def parse_date(v):',
      '    return str(v).strip()',
      '',
      'def transform(df: pl.DataFrame) -> pl.DataFrame:',
      '    return df.with_columns([',
      '        pl.col("val").map_elements(safe_int, return_dtype=pl.Int64),',
      '        pl.col("raw_date").apply(lambda x: parse_date(x)),',
      '    ])',
    ].join('\n');

    const res = await extract(code, 'pipeline.py');
    const udfEdges = (res.edges ?? []).filter((e) => e.edgeType === 'polars_udf');
    expect(udfEdges).toHaveLength(2);

    expect(udfEdges[0]).toMatchObject({
      edgeType: 'polars_udf',
      sourceSymbolId: 'pipeline.py::transform#function',
      targetSymbolId: 'pipeline.py::safe_int#function',
      metadata: {
        udf: 'safe_int',
        method: 'map_elements',
        line: 14,
      },
    });

    expect(udfEdges[1]).toMatchObject({
      edgeType: 'polars_udf',
      sourceSymbolId: 'pipeline.py::transform#function',
      targetSymbolId: 'pipeline.py::parse_date#function',
      metadata: {
        udf: 'parse_date',
        method: 'apply',
        line: 15,
      },
    });
  });

  it('traces dataframe-flow between sequential and chained pipeline stages', async () => {
    const code = [
      'import polars as pl',
      '',
      'def extract_raw() -> pl.DataFrame:',
      '    return pl.DataFrame({"x": [1, 2]})',
      '',
      'def clean_step(df: pl.DataFrame) -> pl.DataFrame:',
      '    return df',
      '',
      'def sink_step(df: pl.DataFrame) -> None:',
      '    pass',
      '',
      'def run_etl():',
      '    raw = extract_raw()',
      '    cleaned = clean_step(raw)',
      '    sink_step(cleaned)',
    ].join('\n');

    const res = await extract(code, 'etl.py');
    const flowEdges = (res.edges ?? []).filter((e) => e.edgeType === 'polars_dataframe_flow');
    expect(flowEdges).toHaveLength(2);

    // clean_step consumes raw produced by extract_raw
    expect(flowEdges[0]).toMatchObject({
      sourceSymbolId: 'etl.py::clean_step#function',
      targetSymbolId: 'etl.py::extract_raw#function',
      metadata: {
        stageFrom: 'extract_raw',
        stageTo: 'clean_step',
        variable: 'raw',
      },
    });

    // sink_step consumes cleaned produced by clean_step
    expect(flowEdges[1]).toMatchObject({
      sourceSymbolId: 'etl.py::sink_step#function',
      targetSymbolId: 'etl.py::clean_step#function',
      metadata: {
        stageFrom: 'clean_step',
        stageTo: 'sink_step',
        variable: 'cleaned',
      },
    });
  });
});
