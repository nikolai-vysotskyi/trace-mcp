/**
 * PyMongoPlugin — Framework plugin for PyMongo (Python MongoDB driver).
 *
 * Extracts:
 * - Literal collection names through:
 *     - db["name"]
 *     - db.get_collection("name")
 *     - client["db"]["name"]
 *     - Local wrapper helpers (e.g. get_collection("name") or get_mongo_collection("name"))
 * - Function → collection edges classified as:
 *     - pymongo_reads: find, find_one, aggregate, count_documents, distinct
 *     - pymongo_writes: insert_*, update_*, replace_one, delete_*, bulk_write, find_one_and_*
 *
 * Uses tree-sitter-python for AST-based extraction.
 * Does not store connection URIs or credentials in metadata or index.
 */

import { ok, type TraceMcpResult } from '../../../../../errors.js';
import { getParser, type TSNode } from '../../../../../parser/tree-sitter.js';
import type {
  EdgeTypeDeclaration,
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  RawSymbol,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { hasAnyPythonDep } from '../../_shared/python-deps.js';
import { findEnclosingSymbol } from '../../_shared/regex-edges.js';

const PACKAGES = ['pymongo'] as const;

const READ_METHODS = new Set(['find', 'find_one', 'aggregate', 'count_documents', 'distinct']);

export function classifyMongoOp(method: string): 'read' | 'write' | null {
  if (method.startsWith('find_one_and_')) return 'write';
  if (
    method.startsWith('insert_') ||
    method.startsWith('update_') ||
    method.startsWith('delete_')
  ) {
    return 'write';
  }
  if (method === 'replace_one' || method === 'bulk_write') return 'write';
  if (READ_METHODS.has(method)) return 'read';
  return null;
}

export function getLiteralString(node: TSNode): string | null {
  if (node.type !== 'string') return null;
  for (const child of node.namedChildren) {
    if (child.type === 'interpolation') return null;
  }
  const text = node.text;
  const unquoted = text.replace(/^[brufBRUF]*['"]{1,3}/, '').replace(/['"]{1,3}$/, '');
  if (!unquoted || unquoted.includes('{') || unquoted.includes('\n')) return null;
  return unquoted;
}

export interface ExtractedMongoOp {
  collection: string;
  op: 'read' | 'write';
  method: string;
  line: number;
}

export interface PyMongoParseResult {
  collections: Set<string>;
  operations: ExtractedMongoOp[];
  isClient: boolean;
  hasPymongo: boolean;
}

/**
 * Identify local wrapper helpers in the AST.
 * A wrapper helper is a function that returns a collection expression parameterized by one of its arguments,
 * or functions commonly named `get_collection` / `get_mongo_collection`.
 */
function findWrapperHelperNames(rootNode: TSNode): Set<string> {
  const helpers = new Set<string>(['get_collection', 'get_mongo_collection']);

  function inspectNode(node: TSNode): void {
    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      const paramsNode = node.childForFieldName('parameters');
      if (nameNode && paramsNode) {
        const params: string[] = [];
        for (const child of paramsNode.namedChildren) {
          if (child.type === 'identifier') {
            const p = child.text;
            if (p !== 'self' && p !== 'cls') params.push(p);
          } else if (child.type === 'typed_parameter' || child.type === 'default_parameter') {
            const p = child.namedChildren[0]?.text;
            if (p && p !== 'self' && p !== 'cls') params.push(p);
          }
        }

        const bodyNode = node.childForFieldName('body');
        if (bodyNode && params.length > 0) {
          const targetParam = params[0];
          let returnsParamCollection = false;

          function scanReturn(n: TSNode): void {
            if (n.type === 'return_statement') {
              const expr = n.namedChildren[0];
              if (expr) {
                if (expr.type === 'subscript') {
                  const slice = expr.childForFieldName('subscript');
                  if (slice && slice.text === targetParam) {
                    returnsParamCollection = true;
                  }
                } else if (expr.type === 'call') {
                  const fn = expr.childForFieldName('function');
                  const args = expr.childForFieldName('arguments');
                  const firstArg = args?.namedChildren[0];
                  if (
                    fn &&
                    (fn.text.endsWith('.get_collection') ||
                      fn.text.endsWith('.get_mongo_collection')) &&
                    firstArg?.text === targetParam
                  ) {
                    returnsParamCollection = true;
                  }
                }
              }
            }
            for (const child of n.namedChildren) {
              scanReturn(child);
            }
          }

          scanReturn(bodyNode);
          if (returnsParamCollection) {
            helpers.add(nameNode.text);
          }
        }
      }
    }
    for (const child of node.namedChildren) {
      inspectNode(child);
    }
  }

  inspectNode(rootNode);
  return helpers;
}

/**
 * Given an AST expression node, attempt to extract a literal MongoDB collection name.
 */
function extractCollectionFromExpr(node: TSNode, wrapperHelpers: Set<string>): string | null {
  if (node.type === 'subscript') {
    const subscript = node.childForFieldName('subscript');
    if (!subscript) return null;
    const collName = getLiteralString(subscript);
    if (!collName) return null;

    const value = node.childForFieldName('value');
    if (!value) return null;

    // Pattern 1: db["name"] or database["name"] or _mongo_db["name"]
    if (value.type === 'identifier') {
      const v = value.text;
      if (
        v === 'db' ||
        v === 'database' ||
        v === 'mongo_db' ||
        v === '_mongo_db' ||
        v.endsWith('_db') ||
        v.includes('mongo')
      ) {
        return collName;
      }
    }

    // Pattern 2: client["db"]["name"]
    if (value.type === 'subscript') {
      const innerSub = value.childForFieldName('subscript');
      if (innerSub && getLiteralString(innerSub)) {
        return collName;
      }
    }

    // Pattern 3: self._mongo_db["name"], cls._mongo_db["name"], client.analytics["name"]
    if (value.type === 'attribute') {
      return collName;
    }
  }

  if (node.type === 'call') {
    const fn = node.childForFieldName('function');
    const args = node.childForFieldName('arguments');
    if (!fn || !args) return null;

    const firstArg = args.namedChildren[0];
    if (!firstArg) return null;
    const collName = getLiteralString(firstArg);
    if (!collName) return null;

    // db.get_collection("name")
    if (fn.type === 'attribute') {
      const attr = fn.childForFieldName('attribute')?.text;
      if (attr === 'get_collection' || attr === 'get_mongo_collection') {
        return collName;
      }
      if (wrapperHelpers.has(attr ?? '')) {
        return collName;
      }
    }

    // get_collection("name") or wrapper helper call
    if (fn.type === 'identifier' && wrapperHelpers.has(fn.text)) {
      return collName;
    }
  }

  return null;
}

/**
 * Parse a Python source string into collection names and operations.
 */
export async function parsePyMongoSource(source: string): Promise<PyMongoParseResult> {
  const collections = new Set<string>();
  const operations: ExtractedMongoOp[] = [];

  const hasPymongo =
    /^\s*(?:import\s+pymongo|from\s+pymongo\b)/m.test(source) ||
    /\bMongoClient\b/.test(source) ||
    /\bget_mongo_collection\b/.test(source);

  const isClient = /\bMongoClient\s*\(/.test(source);

  const parser = await getParser('python');
  const tree = parser.parse(source);
  const rootNode = tree.rootNode;

  const wrapperHelpers = findWrapperHelperNames(rootNode);

  // Traverse the AST scope by scope (functions / methods / module) to track variable bindings.
  function analyzeScope(scopeNode: TSNode): void {
    const varBindings = new Map<string, string>();

    function visit(node: TSNode): void {
      // Don't recurse into nested function definitions; they get their own scope
      if (node !== scopeNode && node.type === 'function_definition') {
        analyzeScope(node);
        return;
      }

      // Check for assignments: col = db["orders"], col = get_collection("reports")
      if (node.type === 'assignment') {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left && right && left.type === 'identifier') {
          const coll = extractCollectionFromExpr(right, wrapperHelpers);
          if (coll) {
            varBindings.set(left.text, coll);
            collections.add(coll);
          } else {
            varBindings.delete(left.text);
          }
        }
      }

      // Check for calls
      if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        if (fn && fn.type === 'attribute') {
          const method = fn.childForFieldName('attribute')?.text;
          const obj = fn.childForFieldName('object');

          if (method && obj) {
            const op = classifyMongoOp(method);
            if (op) {
              let coll: string | null = null;
              if (obj.type === 'identifier') {
                coll = varBindings.get(obj.text) ?? null;
              } else {
                coll = extractCollectionFromExpr(obj, wrapperHelpers);
              }

              if (coll) {
                collections.add(coll);
                operations.push({
                  collection: coll,
                  op,
                  method,
                  line: node.startPosition.row + 1,
                });
              }
            }
          }
        }
      }

      for (const child of node.namedChildren) {
        visit(child);
      }
    }

    visit(scopeNode);
  }

  analyzeScope(rootNode);

  return {
    collections,
    operations,
    isClient,
    hasPymongo,
  };
}

export class PyMongoPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'pymongo',
    version: '1.0.0',
    priority: 30,
    category: 'orm',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasAnyPythonDep(ctx, PACKAGES);
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'pymongo_reads',
          category: 'pymongo',
          description: 'Function reads from a MongoDB collection via pymongo',
        },
        {
          name: 'pymongo_writes',
          category: 'pymongo',
          description: 'Function writes to a MongoDB collection via pymongo',
        },
      ] satisfies EdgeTypeDeclaration[],
    };
  }

  async extractNodes(
    _filePath: string,
    content: Buffer | string,
    language: string,
  ): Promise<TraceMcpResult<FileParseResult>> {
    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = typeof content === 'string' ? content : content.toString('utf-8');
    const parsed = await parsePyMongoSource(source);

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
    };

    if (parsed.isClient) {
      result.frameworkRole = 'pymongo_client';
    } else if (parsed.hasPymongo || parsed.collections.size > 0) {
      result.frameworkRole = 'pymongo_usage';
    }

    for (const coll of parsed.collections) {
      const sym: RawSymbol = {
        symbolId: `collection:${coll}`,
        name: coll,
        kind: 'variable',
        fqn: `collection:${coll}`,
        signature: `collection ${coll}`,
        byteStart: 0,
        byteEnd: 0,
        metadata: {
          collection: coll,
          type: 'mongodb_collection',
        },
      };
      result.symbols.push(sym);
    }

    return ok(result);
  }

  async resolveEdges(ctx: ResolveContext): Promise<TraceMcpResult<RawEdge[]>> {
    const edges: RawEdge[] = [];
    const seenEdges = new Set<string>();

    for (const file of ctx.getAllFiles()) {
      if (file.language !== 'python') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;

      const parsed = await parsePyMongoSource(source);
      if (parsed.operations.length === 0) continue;

      const symbols = ctx.getSymbolsByFile(file.id);

      for (const op of parsed.operations) {
        const encl = findEnclosingSymbol(symbols, op.line);
        const edgeType = op.op === 'read' ? 'pymongo_reads' : 'pymongo_writes';
        const targetSymbolId = `collection:${op.collection}`;
        const sourceRefId = encl ? encl.id : file.id;
        const sourceNodeType = encl ? 'symbol' : 'file';
        const sourceSymbolId = encl ? encl.symbolId : undefined;

        // Dedup identical edges from same source to same collection
        const key = `${sourceNodeType}:${sourceRefId}:${targetSymbolId}:${edgeType}:${op.method}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);

        edges.push({
          edgeType,
          sourceNodeType,
          sourceRefId,
          sourceSymbolId,
          targetSymbolId,
          metadata: {
            op: op.op,
            method: op.method,
            collection: op.collection,
            line: op.line,
            file: file.path,
          },
          resolution: 'ast_resolved',
        });
      }
    }

    return ok(edges);
  }
}
