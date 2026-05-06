/**
 * ReactTablePlugin — detects @tanstack/react-table (and sibling @tanstack/vue-table /
 * @tanstack/table-core) usage. Extracts column helpers, column accessor keys,
 * useReactTable() instantiations and the row-model plugins they wire in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { stripJsComments } from '../../_shared/strip-comments.js';

/** const columnHelper = createColumnHelper<User>() */
const COLUMN_HELPER_DECL_RE =
  /(?:const|let|var)\s+(\w+)\s*=\s*createColumnHelper\s*(?:<\s*([^>]+)\s*>)?\s*\(\s*\)/g;

/** columnHelper.accessor('email', ...) | columnHelper.accessor((row) => row.email, ...) | columnHelper.display(...) | columnHelper.group(...) */
const ACCESSOR_RE =
  /(\w+)\s*\.\s*(accessor|display|group)\s*\(\s*(?:['"`]([^'"`]+)['"`]|\(([^)]*)\)\s*=>\s*([^,)]+)|\{)/g;

/** Match the position of `useReactTable(` so the options body can be sliced with brace balancing. */
const USE_TABLE_HEAD_RE = /useReactTable\s*\(\s*\{/g;

/**
 * Slice the body of a `useReactTable({ ... })` call starting at the position
 * of the opening `{`. Returns the substring between matched braces, respecting
 * nested `{}` (e.g. `state: { sorting }`). Returns null if unbalanced.
 */
function sliceBalancedBraces(source: string, openBrace: number): string | null {
  if (source[openBrace] !== '{') return null;
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openBrace + 1, i);
    }
  }
  return null;
}

/** Row models commonly enabled in a useReactTable options block. */
const ROW_MODEL_HELPERS = [
  'getCoreRowModel',
  'getSortedRowModel',
  'getFilteredRowModel',
  'getPaginationRowModel',
  'getExpandedRowModel',
  'getGroupedRowModel',
  'getFacetedRowModel',
  'getFacetedUniqueValues',
  'getFacetedMinMaxValues',
] as const;

export interface ReactTableColumn {
  /** Helper variable name (e.g. 'columnHelper'). */
  helper: string;
  /** 'accessor' | 'display' | 'group'. */
  kind: string;
  /** Accessor key (e.g. 'email'). May be undefined for accessor-fn or display columns. */
  accessor?: string;
  /** Accessor as a JS expression (e.g. 'row.email'). */
  accessorFn?: string;
}

export interface ReactTableHelper {
  /** Variable name the helper was bound to. */
  variable: string;
  /** Generic type argument if present (e.g. 'User'). */
  rowType?: string;
}

export interface ReactTableInstance {
  /** Row model helpers wired in (getCoreRowModel, getSortedRowModel, ...). */
  rowModels: string[];
  /** Identifier used for the data prop, if directly named (e.g. data: users). */
  dataRef?: string;
  /** Identifier used for columns prop. */
  columnsRef?: string;
}

export interface ReactTableSummary {
  helpers: ReactTableHelper[];
  columns: ReactTableColumn[];
  tables: ReactTableInstance[];
}

function parseTableOptions(body: string): ReactTableInstance {
  const inst: ReactTableInstance = { rowModels: [] };
  for (const helper of ROW_MODEL_HELPERS) {
    if (new RegExp(`\\b${helper}\\b`).test(body)) inst.rowModels.push(helper);
  }
  const data = body.match(/(?:^|[\s,{])data\s*(?::\s*([A-Za-z_$][\w$.]*)|(?=,|\s*$))/m);
  if (data) inst.dataRef = data[1] ?? 'data';
  const cols = body.match(/(?:^|[\s,{])columns\s*(?::\s*([A-Za-z_$][\w$.]*)|(?=,|\s*$))/m);
  if (cols) inst.columnsRef = cols[1] ?? 'columns';
  return inst;
}

/** Extract react-table signals from a TS/JS source string. */
export function extractReactTableSummary(source: string): ReactTableSummary {
  // Strip JS comments so doc snippets like `// const t = useReactTable(...)`
  // don't surface as fake table instances.
  source = stripJsComments(source);

  const helpers: ReactTableHelper[] = [];
  const helperRe = new RegExp(COLUMN_HELPER_DECL_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = helperRe.exec(source)) !== null) {
    helpers.push({ variable: m[1], rowType: m[2]?.trim() });
  }

  const columns: ReactTableColumn[] = [];
  const helperNames = new Set(helpers.map((h) => h.variable));
  const accessorRe = new RegExp(ACCESSOR_RE.source, 'g');
  while ((m = accessorRe.exec(source)) !== null) {
    const variable = m[1];
    if (helpers.length > 0 && !helperNames.has(variable)) continue;
    columns.push({
      helper: variable,
      kind: m[2],
      accessor: m[3],
      accessorFn: m[5]?.trim(),
    });
  }

  const tables: ReactTableInstance[] = [];
  const tableHeadRe = new RegExp(USE_TABLE_HEAD_RE.source, 'g');
  while ((m = tableHeadRe.exec(source)) !== null) {
    // m[0] ends at the opening `{`; locate it and slice with brace balancing.
    const openBrace = m.index + m[0].length - 1;
    const body = sliceBalancedBraces(source, openBrace);
    if (body !== null) tables.push(parseTableOptions(body));
  }

  return { helpers, columns, tables };
}

export class ReactTablePlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'react-table',
    version: '1.0.0',
    priority: 35,
    category: 'view',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    const has = (deps: Record<string, string> | undefined) =>
      !!deps &&
      ('@tanstack/react-table' in deps ||
        '@tanstack/vue-table' in deps ||
        '@tanstack/table-core' in deps ||
        '@tanstack/solid-table' in deps ||
        '@tanstack/svelte-table' in deps ||
        // Legacy v7 (no @tanstack scope). Different API (`useTable`,
        // `useSortBy`) so we don't extract its columns, but we still flag it.
        'react-table' in deps);

    if (ctx.packageJson) {
      const merged = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if (has(merged)) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const merged = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return has(merged);
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'react_table_column',
          category: 'react-table',
          description:
            'react-table component with column definitions. Self-loop; metadata.columns[] lists every accessor/display/group column.',
        },
        {
          name: 'react_table_instance',
          category: 'react-table',
          description: 'useReactTable() invocation with row models',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    if (
      !/createColumnHelper|useReactTable|@tanstack\/(?:react|vue|solid|svelte|table-core)/.test(
        source,
      )
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    const summary = extractReactTableSummary(source);
    if (
      summary.helpers.length === 0 &&
      summary.columns.length === 0 &&
      summary.tables.length === 0
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      routes: [],
      frameworkRole: summary.tables.length > 0 ? 'react_table_view' : 'react_table_columns',
      metadata: { reactTable: summary },
    };

    for (const helper of summary.helpers) {
      result.routes!.push({
        method: 'TABLE_HELPER',
        uri: `react-table:${helper.variable}`,
        metadata: { rowType: helper.rowType },
      });
    }
    for (const col of summary.columns) {
      result.routes!.push({
        method: 'TABLE_COLUMN',
        uri: `react-table:${col.helper}.${col.accessor ?? col.accessorFn ?? '<fn>'}`,
        metadata: { kind: col.kind, accessorFn: col.accessorFn },
      });
    }
    for (let i = 0; i < summary.tables.length; i++) {
      const t = summary.tables[i];
      result.routes!.push({
        method: 'TABLE_INSTANCE',
        uri: `react-table:useReactTable#${i}`,
        metadata: t,
      });
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    for (const file of allFiles) {
      if (file.language !== 'typescript' && file.language !== 'javascript') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      if (!/createColumnHelper|useReactTable/.test(source)) continue;

      const summary = extractReactTableSummary(source);
      if (summary.tables.length === 0 && summary.columns.length === 0) continue;

      // Within-file edges only: link the file's first function/class symbol
      // (the component) to its column definitions.
      const symbols = ctx.getSymbolsByFile(file.id);
      const owner = symbols.find((s) => s.kind === 'function' || s.kind === 'class');
      if (!owner) continue;

      if (summary.tables.length > 0) {
        edges.push({
          sourceNodeType: 'symbol',
          sourceRefId: owner.id,
          targetNodeType: 'symbol',
          targetRefId: owner.id,
          edgeType: 'react_table_instance',
          resolution: 'ast_inferred',
          metadata: {
            count: summary.tables.length,
            rowModels: summary.tables.flatMap((t) => t.rowModels),
          },
        });
      }
      // Aggregate ALL columns into ONE self-loop. The edges table has
      // UNIQUE(source, target, edge_type), so per-column self-loops would
      // collapse and silently lose every column except the first.
      if (summary.columns.length > 0) {
        edges.push({
          sourceNodeType: 'symbol',
          sourceRefId: owner.id,
          targetNodeType: 'symbol',
          targetRefId: owner.id,
          edgeType: 'react_table_column',
          resolution: 'ast_inferred',
          metadata: {
            count: summary.columns.length,
            columns: summary.columns.map((col) => ({
              kind: col.kind,
              accessor: col.accessor,
              accessorFn: col.accessorFn,
              helper: col.helper,
            })),
          },
        });
      }
    }

    return ok(edges);
  }
}
