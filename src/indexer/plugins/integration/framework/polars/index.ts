/**
 * PolarsPlugin — Framework plugin for Polars (Python).
 *
 * Implements the first precise slice of Polars plugin support (GH #1470):
 * - Detects `polars` in Python dependencies.
 * - Recognizes `import polars as pl`, `import polars`, `from polars import ...`.
 * - Identifies `pl.DataFrame(...)` constructions and DataFrame-typed functions
 *   (parameters or return types annotated with DataFrame / LazyFrame) as pipeline stages.
 * - Traces dataflow between stages (`polars_dataframe_flow`).
 * - Extracts direct literal column references: `pl.col("literal")` (`polars_column_ref`),
 *   `.alias("literal")` and `.rename({...})` (`polars_column_alias`),
 *   and `.join(..., on="literal")` (`polars_join`), preserving verifiable literals without guessing.
 * - Links `map_elements(fn)`, `map_batches(fn)`, and `apply(fn)` to local and imported Python
 *   callables (`polars_udf`), so functions appear in `get_call_graph`, `find_usages`,
 *   and `get_change_impact`.
 *
 * Uses tree-sitter-python for AST parsing.
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
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { hasPythonDep } from '../../_shared/python-deps.js';

// ============================================================
// Helpers
// ============================================================

function stripQuotes(s: string): string {
  let text = s.trim();
  text = text.replace(/^[fFbBrRuU]+/, '');
  if (text.startsWith('"""') || text.startsWith("'''")) {
    return text.slice(3, -3);
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    return text.slice(1, -1);
  }
  return text;
}

function getStringLiteral(node: TSNode): string | null {
  if (node.type === 'string') {
    return stripQuotes(node.text);
  }
  if (node.type === 'concatenated_string') {
    const parts: string[] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'string') {
        parts.push(stripQuotes(child.text));
      }
    }
    return parts.join('');
  }
  return null;
}

function getLiteralStringOrList(node: TSNode): string[] {
  const single = getStringLiteral(node);
  if (single !== null) {
    return [single];
  }
  if (node.type === 'list' || node.type === 'tuple') {
    const items: string[] = [];
    for (const child of node.namedChildren) {
      const val = getStringLiteral(child);
      if (val !== null) items.push(val);
    }
    return items;
  }
  return [];
}

/** Check if a type annotation mentions DataFrame or LazyFrame. */
function isDataFrameType(typeText: string): boolean {
  return /\b(?:DataFrame|LazyFrame)\b/.test(typeText);
}

/** Walk ancestors of a node to find enclosing function or class symbol ID. */
function getEnclosingSymbolId(node: TSNode, filePath: string): string {
  let curr: TSNode | null = node.parent;
  let funcName: string | null = null;
  let className: string | null = null;

  while (curr) {
    if (curr.type === 'function_definition') {
      const nameNode = curr.childForFieldName('name');
      if (nameNode && !funcName) {
        funcName = nameNode.text;
      }
    } else if (curr.type === 'class_definition') {
      const nameNode = curr.childForFieldName('name');
      if (nameNode && !className) {
        className = nameNode.text;
      }
    }
    curr = curr.parent;
  }

  if (funcName) {
    if (className) {
      return `${filePath}::${className}::${funcName}#method`;
    }
    return `${filePath}::${funcName}#function`;
  }
  if (className) {
    return `${filePath}::${className}#class`;
  }
  return filePath;
}

/** Walk up AST to find the nearest enclosing function name, if any. */
function getEnclosingFunctionName(node: TSNode): string | null {
  let curr: TSNode | null = node.parent;
  while (curr) {
    if (curr.type === 'function_definition') {
      return curr.childForFieldName('name')?.text ?? null;
    }
    curr = curr.parent;
  }
  return null;
}

/** Search expression AST for a col("literal") invocation. */
function findColInExpr(exprNode: TSNode | null): string | null {
  if (!exprNode) return null;
  if (exprNode.type === 'call') {
    const fn = exprNode.childForFieldName('function');
    if (fn) {
      const fnText = fn.text;
      if (fnText === 'col' || fnText.endsWith('.col')) {
        const args = exprNode.childForFieldName('arguments');
        if (args) {
          for (const arg of args.namedChildren) {
            const s = getStringLiteral(arg);
            if (s !== null) return s;
          }
        }
      }
    }
  }
  for (const child of exprNode.namedChildren) {
    const found = findColInExpr(child);
    if (found) return found;
  }
  return null;
}

// ============================================================
// Plugin Class
// ============================================================

export class PolarsPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'polars',
    version: '1.0.0',
    priority: 35,
    category: 'framework',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx, 'polars');
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'polars_dataframe_flow',
          category: 'polars',
          directed: true,
          description: 'Polars DataFrame transform pipeline flow between stages',
        },
        {
          name: 'polars_udf',
          category: 'polars',
          directed: true,
          description: 'Polars map_elements/apply UDF callable reference',
        },
        {
          name: 'polars_column_ref',
          category: 'polars',
          directed: true,
          description: 'Polars column literal reference (pl.col, select, drop)',
        },
        {
          name: 'polars_column_alias',
          category: 'polars',
          directed: true,
          description: 'Polars column alias or rename mapping (from -> to)',
        },
        {
          name: 'polars_join',
          category: 'polars',
          directed: true,
          description: 'Polars DataFrame join operation',
        },
      ] satisfies EdgeTypeDeclaration[],
    };
  }

  async extractNodes(
    filePath: string,
    content: Buffer | string,
    language: string,
  ): Promise<TraceMcpResult<FileParseResult>> {
    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = typeof content === 'string' ? content : content.toString('utf-8');

    // Quick filter: skip files that don't mention polars / pl. / DataFrame / LazyFrame
    if (
      !source.includes('polars') &&
      !source.includes('pl.') &&
      !source.includes('DataFrame') &&
      !source.includes('LazyFrame')
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      edges: [],
    };

    let tree: { rootNode: TSNode; delete: () => void };
    try {
      const parser = await getParser('python');
      tree = parser.parse(source);
    } catch {
      return ok({ status: 'ok', symbols: [] });
    }

    try {
      const root = tree.rootNode;

      // ── Step 1: Detect Polars Imports & Aliases ────────────────
      const polarsAliases = new Set<string>();
      let colImported = false;
      let dataFrameImported = false;
      let lazyFrameImported = false;
      let hasPolarsImport = false;
      const importedFromOtherModules = new Map<string, string>(); // importedSymbol -> moduleName

      const importNodes: TSNode[] = [];
      const functionNodes: TSNode[] = [];
      const callNodes: TSNode[] = [];
      const assignmentNodes: TSNode[] = [];

      const walk = (node: TSNode) => {
        if (node.type === 'import_statement' || node.type === 'import_from_statement') {
          importNodes.push(node);
        } else if (node.type === 'function_definition') {
          functionNodes.push(node);
        } else if (node.type === 'call') {
          callNodes.push(node);
        } else if (node.type === 'assignment') {
          assignmentNodes.push(node);
        }
        for (const child of node.namedChildren) {
          walk(child);
        }
      };
      walk(root);

      for (const imp of importNodes) {
        if (imp.type === 'import_statement') {
          // import polars / import polars as pl
          for (const child of imp.namedChildren) {
            if (child.type === 'dotted_name' && child.text === 'polars') {
              polarsAliases.add('polars');
              hasPolarsImport = true;
            } else if (child.type === 'as_pattern') {
              const nameNode = child.childForFieldName('name');
              const aliasNode = child.childForFieldName('alias');
              if (nameNode?.text === 'polars') {
                hasPolarsImport = true;
                polarsAliases.add(aliasNode ? aliasNode.text : 'polars');
              }
            }
          }
        } else if (imp.type === 'import_from_statement') {
          const modNode = imp.childForFieldName('module_name');
          const modName = modNode?.text ?? '';
          if (modName === 'polars' || modName.startsWith('polars.')) {
            hasPolarsImport = true;
            for (const child of imp.namedChildren) {
              if (child === modNode) continue;
              const name =
                child.type === 'as_pattern' ? child.childForFieldName('name')?.text : child.text;
              if (name === 'col') colImported = true;
              if (name === 'DataFrame') dataFrameImported = true;
              if (name === 'LazyFrame') lazyFrameImported = true;
            }
          } else if (modName) {
            // Track imports from other modules (e.g. from helpers import safe_int)
            for (const child of imp.namedChildren) {
              if (child === modNode) continue;
              const symName =
                child.type === 'as_pattern' ? child.childForFieldName('alias')?.text : child.text;
              if (symName) {
                importedFromOtherModules.set(symName, modName);
              }
            }
          }
        }
      }

      // Default common alias if referenced
      if (
        polarsAliases.size === 0 &&
        (source.includes('pl.') || source.includes('import polars as pl'))
      ) {
        polarsAliases.add('pl');
      }

      // ── Step 2: Identify Local Functions & DataFrame Pipeline Stages ──
      const localFunctions = new Set<string>();
      const stageFunctions = new Set<string>(); // function names identified as stages

      for (const fnNode of functionNodes) {
        const nameNode = fnNode.childForFieldName('name');
        if (!nameNode) continue;
        const fnName = nameNode.text;
        localFunctions.add(fnName);

        let isStage = false;

        // Check parameter type annotations
        const paramsNode = fnNode.childForFieldName('parameters');
        if (paramsNode) {
          for (const param of paramsNode.namedChildren) {
            if (param.type === 'typed_parameter' || param.type === 'typed_default_parameter') {
              const typeNode = param.childForFieldName('type');
              if (typeNode && isDataFrameType(typeNode.text)) {
                isStage = true;
                break;
              }
            }
          }
        }

        // Check return type annotation
        const retNode = fnNode.childForFieldName('return_type');
        if (retNode && isDataFrameType(retNode.text)) {
          isStage = true;
        }

        // Check if function body constructs a DataFrame (e.g. pl.DataFrame(...))
        if (!isStage) {
          const body = fnNode.childForFieldName('body');
          if (body) {
            const hasDfConstruction = (n: TSNode): boolean => {
              if (n.type === 'call') {
                const callFn = n.childForFieldName('function');
                if (callFn) {
                  const t = callFn.text;
                  if (
                    t === 'pl.DataFrame' ||
                    t === 'polars.DataFrame' ||
                    (dataFrameImported && t === 'DataFrame') ||
                    t === 'pl.LazyFrame' ||
                    t === 'polars.LazyFrame' ||
                    (lazyFrameImported && t === 'LazyFrame')
                  ) {
                    return true;
                  }
                }
              }
              for (const ch of n.namedChildren) {
                if (hasDfConstruction(ch)) return true;
              }
              return false;
            };
            if (hasDfConstruction(body)) {
              isStage = true;
            }
          }
        }

        if (isStage) {
          stageFunctions.add(fnName);
        }
      }

      // ── Step 3: DataFrame Dataflow Between Stages (`polars_dataframe_flow`) ──
      // Track variable = stageA(...) and subsequent stageB(..., variable, ...)
      // Or direct stageB(stageA(...))
      for (const fnNode of functionNodes) {
        const body = fnNode.childForFieldName('body');
        if (!body) continue;

        const varProducer = new Map<string, string>(); // varName -> stageName

        const scanAssignmentsAndCalls = (n: TSNode) => {
          if (n.type === 'assignment') {
            const left = n.childForFieldName('left');
            const right = n.childForFieldName('right');
            if (left && right && right.type === 'call') {
              const calleeNode = right.childForFieldName('function');
              if (calleeNode) {
                const calleeName = calleeNode.text;
                if (stageFunctions.has(calleeName)) {
                  varProducer.set(left.text, calleeName);
                }
              }
            }
          } else if (n.type === 'call') {
            const calleeNode = n.childForFieldName('function');
            if (calleeNode) {
              const calleeName = calleeNode.text;
              if (stageFunctions.has(calleeName)) {
                const args = n.childForFieldName('arguments');
                if (args) {
                  for (const arg of args.namedChildren) {
                    // Pattern 1: stageB(var) where var came from stageA
                    if (arg.type === 'identifier' && varProducer.has(arg.text)) {
                      const producer = varProducer.get(arg.text)!;
                      if (producer !== calleeName) {
                        result.edges!.push({
                          edgeType: 'polars_dataframe_flow',
                          sourceSymbolId: `${filePath}::${calleeName}#function`,
                          targetSymbolId: `${filePath}::${producer}#function`,
                          metadata: {
                            stageFrom: producer,
                            stageTo: calleeName,
                            variable: arg.text,
                            line: n.startPosition.row + 1,
                          },
                          resolution: 'ast_resolved',
                        });
                      }
                    }
                    // Pattern 2: stageB(stageA(...))
                    if (arg.type === 'call') {
                      const innerFn = arg.childForFieldName('function');
                      if (
                        innerFn &&
                        stageFunctions.has(innerFn.text) &&
                        innerFn.text !== calleeName
                      ) {
                        result.edges!.push({
                          edgeType: 'polars_dataframe_flow',
                          sourceSymbolId: `${filePath}::${calleeName}#function`,
                          targetSymbolId: `${filePath}::${innerFn.text}#function`,
                          metadata: {
                            stageFrom: innerFn.text,
                            stageTo: calleeName,
                            line: n.startPosition.row + 1,
                          },
                          resolution: 'ast_resolved',
                        });
                      }
                    }
                  }
                }
              }
            }
          }
          for (const ch of n.namedChildren) {
            scanAssignmentsAndCalls(ch);
          }
        };

        scanAssignmentsAndCalls(body);
      }

      // ── Step 4: Extract Column Literals, Aliases, Joins, and UDFs ──
      for (const callNode of callNodes) {
        const fnNode = callNode.childForFieldName('function');
        if (!fnNode) continue;

        const enclosingId = getEnclosingSymbolId(callNode, filePath);
        const line = callNode.startPosition.row + 1;

        // --- 4A: pl.col("literal") or col("literal") ---
        let isColCall = false;
        if (fnNode.type === 'attribute') {
          const obj = fnNode.childForFieldName('object');
          const attr = fnNode.childForFieldName('attribute');
          if (obj && attr && polarsAliases.has(obj.text) && attr.text === 'col') {
            isColCall = true;
          }
        } else if (fnNode.type === 'identifier' && fnNode.text === 'col' && colImported) {
          isColCall = true;
        }

        if (isColCall) {
          const args = callNode.childForFieldName('arguments');
          if (args) {
            for (const arg of args.namedChildren) {
              const colName = getStringLiteral(arg);
              if (colName) {
                result.edges!.push({
                  edgeType: 'polars_column_ref',
                  sourceSymbolId: enclosingId,
                  targetSymbolId: `polars-col::${colName}`,
                  metadata: {
                    column: colName,
                    operation: 'col',
                    line,
                  },
                  resolution: 'ast_resolved',
                });
              }
            }
          }
        }

        // --- 4B: .alias("literal") ---
        if (fnNode.type === 'attribute') {
          const attr = fnNode.childForFieldName('attribute');
          if (attr && attr.text === 'alias') {
            const args = callNode.childForFieldName('arguments');
            if (args && args.namedChildren.length > 0) {
              const aliasName = getStringLiteral(args.namedChildren[0]);
              if (aliasName) {
                const origCol = findColInExpr(fnNode.childForFieldName('object'));
                result.edges!.push({
                  edgeType: 'polars_column_alias',
                  sourceSymbolId: enclosingId,
                  targetSymbolId: `polars-col::${aliasName}`,
                  metadata: {
                    from: origCol ?? null,
                    to: aliasName,
                    operation: 'alias',
                    line,
                  },
                  resolution: 'ast_resolved',
                });
                result.edges!.push({
                  edgeType: 'polars_column_ref',
                  sourceSymbolId: enclosingId,
                  targetSymbolId: `polars-col::${aliasName}`,
                  metadata: {
                    column: aliasName,
                    operation: 'alias',
                    line,
                  },
                  resolution: 'ast_resolved',
                });
              }
            }
          }
        }

        // --- 4C: .rename({...}) ---
        if (fnNode.type === 'attribute') {
          const attr = fnNode.childForFieldName('attribute');
          if (attr && attr.text === 'rename') {
            const args = callNode.childForFieldName('arguments');
            if (args) {
              let dictNode: TSNode | null = null;
              for (const arg of args.namedChildren) {
                if (arg.type === 'dictionary') {
                  dictNode = arg;
                  break;
                }
                if (arg.type === 'keyword_argument') {
                  const kName = arg.childForFieldName('name');
                  if (kName?.text === 'mapping') {
                    const val = arg.childForFieldName('value');
                    if (val?.type === 'dictionary') dictNode = val;
                  }
                }
              }

              if (dictNode) {
                for (const pair of dictNode.namedChildren) {
                  if (pair.type === 'pair') {
                    const k = pair.childForFieldName('key');
                    const v = pair.childForFieldName('value');
                    if (k && v) {
                      const fromCol = getStringLiteral(k);
                      const toCol = getStringLiteral(v);
                      if (fromCol && toCol) {
                        result.edges!.push({
                          edgeType: 'polars_column_alias',
                          sourceSymbolId: enclosingId,
                          targetSymbolId: `polars-col::${toCol}`,
                          metadata: {
                            from: fromCol,
                            to: toCol,
                            operation: 'rename',
                            line,
                          },
                          resolution: 'ast_resolved',
                        });
                        result.edges!.push({
                          edgeType: 'polars_column_ref',
                          sourceSymbolId: enclosingId,
                          targetSymbolId: `polars-col::${fromCol}`,
                          metadata: {
                            column: fromCol,
                            operation: 'rename',
                            line,
                          },
                          resolution: 'ast_resolved',
                        });
                        result.edges!.push({
                          edgeType: 'polars_column_ref',
                          sourceSymbolId: enclosingId,
                          targetSymbolId: `polars-col::${toCol}`,
                          metadata: {
                            column: toCol,
                            operation: 'rename',
                            line,
                          },
                          resolution: 'ast_resolved',
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // --- 4D: .join(..., on="literal") ---
        if (fnNode.type === 'attribute') {
          const attr = fnNode.childForFieldName('attribute');
          if (attr && attr.text === 'join') {
            const args = callNode.childForFieldName('arguments');
            if (args) {
              let onKeys: string[] = [];
              let leftOnKeys: string[] = [];
              let rightOnKeys: string[] = [];
              let how: string | null = null;
              let otherFrame: string | null = null;

              for (let i = 0; i < args.namedChildren.length; i++) {
                const arg = args.namedChildren[i];
                if (i === 0 && (arg.type === 'identifier' || arg.type === 'attribute')) {
                  otherFrame = arg.text;
                }
                if (arg.type === 'keyword_argument') {
                  const kName = arg.childForFieldName('name')?.text;
                  const kVal = arg.childForFieldName('value');
                  if (kName && kVal) {
                    if (kName === 'on') {
                      onKeys = getLiteralStringOrList(kVal);
                    } else if (kName === 'left_on') {
                      leftOnKeys = getLiteralStringOrList(kVal);
                    } else if (kName === 'right_on') {
                      rightOnKeys = getLiteralStringOrList(kVal);
                    } else if (kName === 'how') {
                      how = getStringLiteral(kVal);
                    }
                  }
                }
              }

              const allJoinKeys = [...onKeys, ...leftOnKeys, ...rightOnKeys];
              if (allJoinKeys.length > 0 || otherFrame) {
                result.edges!.push({
                  edgeType: 'polars_join',
                  sourceSymbolId: enclosingId,
                  targetSymbolId: enclosingId,
                  metadata: {
                    other: otherFrame,
                    on: onKeys,
                    left_on: leftOnKeys,
                    right_on: rightOnKeys,
                    how: how ?? 'inner',
                    line,
                  },
                  resolution: 'ast_resolved',
                });

                for (const key of allJoinKeys) {
                  result.edges!.push({
                    edgeType: 'polars_column_ref',
                    sourceSymbolId: enclosingId,
                    targetSymbolId: `polars-col::${key}`,
                    metadata: {
                      column: key,
                      operation: 'join_key',
                      line,
                    },
                    resolution: 'ast_resolved',
                  });
                }
              }
            }
          }
        }

        // --- 4E: .map_elements(fn) / .map_batches(fn) / .apply(fn) ---
        if (fnNode.type === 'attribute') {
          const attr = fnNode.childForFieldName('attribute');
          if (
            attr &&
            (attr.text === 'map_elements' || attr.text === 'map_batches' || attr.text === 'apply')
          ) {
            const methodName = attr.text;
            const args = callNode.childForFieldName('arguments');
            if (args) {
              let fnTargetName: string | null = null;
              for (const arg of args.namedChildren) {
                if (arg.type === 'identifier') {
                  fnTargetName = arg.text;
                  break;
                }
                if (arg.type === 'attribute') {
                  const attrPart = arg.childForFieldName('attribute');
                  fnTargetName = attrPart ? attrPart.text : arg.text;
                  break;
                }
                if (arg.type === 'keyword_argument') {
                  const kName = arg.childForFieldName('name')?.text;
                  const kVal = arg.childForFieldName('value');
                  if ((kName === 'function' || kName === 'f') && kVal) {
                    if (kVal.type === 'identifier') fnTargetName = kVal.text;
                    else if (kVal.type === 'attribute') {
                      const attrPart = kVal.childForFieldName('attribute');
                      fnTargetName = attrPart ? attrPart.text : kVal.text;
                    } else if (kVal.type === 'lambda') {
                      const body = kVal.childForFieldName('body');
                      if (body?.type === 'call') {
                        const lambdaCallee = body.childForFieldName('function');
                        if (lambdaCallee?.type === 'identifier') fnTargetName = lambdaCallee.text;
                      }
                    }
                    break;
                  }
                }
                if (arg.type === 'lambda') {
                  const body = arg.childForFieldName('body');
                  if (body?.type === 'call') {
                    const lambdaCallee = body.childForFieldName('function');
                    if (lambdaCallee?.type === 'identifier') {
                      fnTargetName = lambdaCallee.text;
                      break;
                    }
                  }
                }
              }

              if (fnTargetName) {
                // If defined locally in the same file
                if (localFunctions.has(fnTargetName)) {
                  result.edges!.push({
                    edgeType: 'polars_udf',
                    sourceSymbolId: enclosingId,
                    targetSymbolId: `${filePath}::${fnTargetName}#function`,
                    metadata: {
                      udf: fnTargetName,
                      method: methodName,
                      line,
                    },
                    resolution: 'ast_resolved',
                  });
                } else if (importedFromOtherModules.has(fnTargetName)) {
                  // Pass 2 will resolve cross-file imported callable
                  result.edges!.push({
                    edgeType: 'polars_udf',
                    sourceSymbolId: enclosingId,
                    targetSymbolId: fnTargetName, // resolved in pass 2
                    metadata: {
                      udf: fnTargetName,
                      fromModule: importedFromOtherModules.get(fnTargetName),
                      method: methodName,
                      crossFile: true,
                      line,
                    },
                    resolution: 'ast_resolved',
                  });
                }
              }
            }
          }
        }
      }

      if (hasPolarsImport || result.edges!.length > 0 || stageFunctions.size > 0) {
        result.frameworkRole = 'polars_pipeline';
      }

      return ok(result);
    } finally {
      tree.delete();
    }
  }

  /**
   * Pass 2: resolve cross-file Polars UDF callables and cross-file stage connections.
   */
  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const pyFiles = ctx.getAllFiles().filter((f) => f.language === 'python');
    if (pyFiles.length === 0) return ok(edges);

    const scope = ctx.changeScope;
    const targetFiles =
      scope && scope.changedFileIds && scope.changedFileIds.size > 0
        ? pyFiles.filter((f) => scope.changedFileIds.has(f.id))
        : pyFiles;

    if (targetFiles.length === 0) return ok(edges);

    // Build map of top-level function symbols by function name
    const functionsByName = new Map<
      string,
      Array<{ id: number; symbolId: string; fileId: number; filePath: string }>
    >();

    for (const f of pyFiles) {
      const symbols = ctx.getSymbolsByFile(f.id);
      for (const s of symbols) {
        if (s.kind === 'function') {
          const list = functionsByName.get(s.name) ?? [];
          list.push({ id: s.id, symbolId: s.symbolId, fileId: f.id, filePath: f.path });
          functionsByName.set(s.name, list);
        }
      }
    }

    // Regex to match map_elements / map_batches / apply calls in target files
    const UDF_CALL_RE =
      /\.(?:map_elements|map_batches|apply)\s*\(\s*(?:function\s*=\s*)?([A-Za-z_]\w*)/g;

    for (const f of targetFiles) {
      const source = ctx.readFile(f.path);
      if (
        !source ||
        (!source.includes('map_elements') &&
          !source.includes('map_batches') &&
          !source.includes('apply'))
      ) {
        continue;
      }

      const fileSymbols = ctx.getSymbolsByFile(f.id);
      UDF_CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;

      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
      while ((m = UDF_CALL_RE.exec(source)) !== null) {
        const fnName = m[1];
        if (fnName === 'lambda') continue;

        const candidates = functionsByName.get(fnName);
        if (!candidates || candidates.length === 0) continue;

        // Find enclosing symbol in current file
        const line = source.slice(0, m.index).split('\n').length;
        const enclosing = fileSymbols.find(
          (s) =>
            s.lineStart != null &&
            s.lineEnd != null &&
            line >= s.lineStart &&
            line <= s.lineEnd &&
            (s.kind === 'function' || s.kind === 'method'),
        );
        if (!enclosing) continue;

        // If target is in a different file (cross-file resolution)
        const crossFileCandidate = candidates.find((c) => c.fileId !== f.id);
        if (crossFileCandidate) {
          edges.push({
            edgeType: 'polars_udf',
            sourceNodeType: 'symbol',
            sourceRefId: enclosing.id,
            targetNodeType: 'symbol',
            targetRefId: crossFileCandidate.id,
            metadata: {
              udf: fnName,
              method: 'map_elements',
              line,
              crossFile: true,
            },
            resolution: 'ast_resolved',
          });
        }
      }
    }

    return ok(edges);
  }
}
